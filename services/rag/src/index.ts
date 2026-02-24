import { Hono } from "hono"
import { Mcp } from "@open-assistant/protocol"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import z from "zod/v4"
import { openRagDb } from "./db"
import { shouldIngestFileName, splitIntoChunks, sourceIdFor } from "./ingest"

const Env = z.object({
  OA_RAG_HOST: z.string().default("0.0.0.0"),
  OA_RAG_PORT: z.coerce.number().int().positive().default(7005),
  OA_RAG_DB_PATH: z.string().default(fileURLToPath(new URL("../data/rag.sqlite", import.meta.url))),
  OA_RAG_DEFAULT_TENANT: z.string().min(1).default("default"),
  OA_RAG_DEFAULT_PROJECT: z.string().min(1).default("open-assistant"),
  OA_RAG_UPLOAD_DIR: z.string().optional(),
  OA_RAG_INGEST_MAX_CHARS: z.coerce.number().int().positive().default(900),
  OA_ADMIN_TOKEN: z.string().min(1).optional(),
  OA_RAG_ADMIN_TOKEN: z.string().min(1).optional(),
  OA_AUDIT_SINK_URL: z.string().url().optional(),
  OA_AUDIT_SINK_TOKEN: z.string().min(1).optional(),
})

function normalizedEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" && !v.trim() ? undefined : v
  }
  return out
}

const env = Env.parse(normalizedEnv(process.env))
const uploadDir = env.OA_RAG_UPLOAD_DIR ?? path.join(path.dirname(env.OA_RAG_DB_PATH), "uploads")

const ragDb = openRagDb(env.OA_RAG_DB_PATH)
ragDb.ensureSchema()

function ensureSeed() {
  if (ragDb.countPassages() > 0) return
  ragDb.upsertPassage({
    tenant: env.OA_RAG_DEFAULT_TENANT,
    project: env.OA_RAG_DEFAULT_PROJECT,
    sourceId: "seed:welcome",
    text: "这是 Open Assistant 的内网 RAG（sqlite FTS5）种子数据。你可以用 `services/rag/src/cli.ts ingest` 导入文档目录。",
    metaJson: JSON.stringify({ kind: "seed" }),
  })
  ragDb.upsertPassage({
    tenant: env.OA_RAG_DEFAULT_TENANT,
    project: env.OA_RAG_DEFAULT_PROJECT,
    sourceId: "seed:security",
    text: "安全约束：不要直接输出或拼接任意 URL；素材播放必须通过 assetId；需要打断时立刻停止当前播报和播放。",
    metaJson: JSON.stringify({ kind: "seed" }),
  })
}
ensureSeed()

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))
app.get("/readyz", (c) => c.json({ ok: true }))

function parseBearer(value: string | undefined | null) {
  if (!value) return
  const m = value.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || undefined
}

function requireAdmin(c: any) {
  const configured = (env.OA_RAG_ADMIN_TOKEN ?? env.OA_ADMIN_TOKEN)?.trim()
  if (!configured) return
  const token = c.req.query("token") ?? parseBearer(c.req.header("authorization"))
  if (token !== configured) return c.json({ ok: false, error: "unauthorized" }, 401)
}

function makeUrl(baseUrl: string, pathName: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(pathName.replace(/^\//, ""), base)
}

async function emitAudit(event: string, fields: Record<string, unknown>) {
  const baseUrl = env.OA_AUDIT_SINK_URL
  if (!baseUrl) return

  const token = (env.OA_AUDIT_SINK_TOKEN ?? env.OA_RAG_ADMIN_TOKEN ?? env.OA_ADMIN_TOKEN)?.trim()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["authorization"] = `Bearer ${token}`

  try {
    await fetch(makeUrl(baseUrl, "/audit/emit"), {
      method: "POST",
      headers,
      body: JSON.stringify({ event, fields }),
    })
  } catch {
    // ignore
  }
}

function normalizeDocName(file: string) {
  return file.replaceAll("\\\\", "/").replace(/^\/+/, "")
}

type IngestTask = { tenant: string; project: string; file: string }
const ingestQueue: IngestTask[] = []
const ingestQueued = new Set<string>()
let ingestWorkerRunning = false

function enqueueIngest(task: IngestTask) {
  const key = `${task.tenant}/${task.project}/${task.file}`
  if (ingestQueued.has(key)) return
  ingestQueued.add(key)
  ingestQueue.push(task)
  void runIngestWorker()
}

async function runIngestWorker() {
  if (ingestWorkerRunning) return
  ingestWorkerRunning = true
  try {
    while (ingestQueue.length) {
      const task = ingestQueue.shift()
      if (!task) break
      const key = `${task.tenant}/${task.project}/${task.file}`
      ingestQueued.delete(key)
      await ingestOne(task).catch(() => {})
    }
  } finally {
    ingestWorkerRunning = false
  }
}

function safeStoredFilePath(tenant: string, project: string, storedName: string) {
  const baseDir = path.resolve(path.join(uploadDir, tenant, project))
  const fp = path.resolve(path.join(baseDir, storedName))
  if (!isPathWithin(baseDir, fp)) return
  return fp
}

async function ingestOne(task: IngestTask) {
  const file = normalizeDocName(task.file)
  const ingestStartedAt = Date.now()
  const info = ragDb.getDocInfo({ tenant: task.tenant, project: task.project, file })
  if (!info?.storedName) return

  const storedName = info.storedName
  const maxChars = info.ingestMaxChars ?? env.OA_RAG_INGEST_MAX_CHARS
  const fp = safeStoredFilePath(task.tenant, task.project, storedName)
  if (!fp) {
    ragDb.finishDocIngestFailed({ tenant: task.tenant, project: task.project, file, storedName, error: "stored_file_path_invalid" })
    return
  }

  let content: string
  try {
    content = await Bun.file(fp).text()
  } catch (err) {
    ragDb.finishDocIngestFailed({
      tenant: task.tenant,
      project: task.project,
      file,
      storedName,
      error: err instanceof Error ? `read_failed: ${err.message}` : `read_failed: ${String(err)}`,
    })
    return
  }

  const chunks = splitIntoChunks(content, Math.max(1, Math.floor(maxChars)))
  void emitAudit("rag.ingest.start", {
    tenant: task.tenant,
    project: task.project,
    file,
    storedName,
    maxChars,
    totalChunks: chunks.length,
  })
  const started = ragDb.startDocIngest({ tenant: task.tenant, project: task.project, file, storedName, totalChunks: chunks.length })
  if (!started) return

  try {
    ragDb.deleteDoc({ tenant: task.tenant, project: task.project, file })

    for (let i = 0; i < chunks.length; i++) {
      ragDb.upsertPassage({
        tenant: task.tenant,
        project: task.project,
        sourceId: sourceIdFor(file, i),
        text: chunks[i]!,
        metaJson: JSON.stringify({ file, stored: storedName, chunk: i + 1, chunks: chunks.length }),
      })

      if ((i + 1) % 5 === 0 || i + 1 === chunks.length) {
        ragDb.progressDocIngest({ tenant: task.tenant, project: task.project, file, storedName, doneChunks: i + 1, totalChunks: chunks.length })
      }
    }

    ragDb.finishDocIngestSucceeded({ tenant: task.tenant, project: task.project, file, storedName, totalChunks: chunks.length })
    void emitAudit("rag.ingest.succeeded", {
      tenant: task.tenant,
      project: task.project,
      file,
      storedName,
      totalChunks: chunks.length,
      elapsedMs: Date.now() - ingestStartedAt,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ragDb.finishDocIngestFailed({
      tenant: task.tenant,
      project: task.project,
      file,
      storedName,
      error: `ingest_failed: ${detail}`,
    })
    void emitAudit("rag.ingest.failed", {
      tenant: task.tenant,
      project: task.project,
      file,
      storedName,
      error: `ingest_failed: ${detail}`.slice(0, 400),
      elapsedMs: Date.now() - ingestStartedAt,
    })
  }
}

const DocListInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(50),
  cursor: z.string().min(1).optional(),
  status: z.enum(["all", "draft", "approved", "archived"]).optional(),
})

app.post("/doc/list", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  const input = DocListInput.parse(await c.req.json().catch(() => ({})))
  const docs = ragDb.listDocs({
    tenant: input.tenant,
    project: input.project,
    query: input.query,
    tags: input.tags,
    limit: input.limit,
    cursor: input.cursor,
    status: input.status,
  })
  const nextCursor = docs.at(-1)?.file
  return c.json({ ok: true, docs, nextCursor })
})

const DocDeleteInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  file: z.string().min(1),
  deleteFile: z.coerce.boolean().default(true),
  reason: z.string().max(200).optional(),
})

function isPathWithin(baseDir: string, filePath: string) {
  const rel = path.relative(baseDir, filePath)
  if (!rel) return true
  if (rel.startsWith("..")) return false
  if (path.isAbsolute(rel)) return false
  return true
}

app.post("/doc/delete", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  const input = DocDeleteInput.parse(await c.req.json().catch(() => ({})))
  const normalizedFile = normalizeDocName(input.file)
  const info = ragDb.getDocInfo({ tenant: input.tenant, project: input.project, file: normalizedFile })
  const stored = Array.from(new Set([...(ragDb.getDocStoredNames({ tenant: input.tenant, project: input.project, file: normalizedFile }) ?? []), info?.storedName].filter(Boolean))).map(
    String,
  )

  const deletedPassages = ragDb.deleteDoc({ tenant: input.tenant, project: input.project, file: normalizedFile })
  const deletedMeta = ragDb.deleteDocMeta({ tenant: input.tenant, project: input.project, file: normalizedFile })
  if (!deletedPassages && !deletedMeta) return c.json({ ok: false, error: "not_found" }, 404)

  const deletedFiles: string[] = []
  const fileErrors: Record<string, string> = {}

  if (input.deleteFile && stored.length) {
    const baseDir = path.resolve(path.join(uploadDir, input.tenant, input.project))
    for (const name of stored) {
      const fp = path.resolve(path.join(baseDir, name))
      if (!isPathWithin(baseDir, fp)) continue
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
        deletedFiles.push(name)
      } catch (err) {
        fileErrors[name] = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return c.json({ ok: true, file: input.file, deletedPassages, stored, deletedFiles, fileErrors })
})

app.post("/doc/upload", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  let form: Awaited<ReturnType<Request["formData"]>>
  try {
    form = await c.req.raw.formData()
  } catch {
    return c.json({ ok: false, error: "bad_form" }, 400)
  }

  const tenant = String(form.get("tenant") ?? "").trim()
  const project = String(form.get("project") ?? "").trim()
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "tenant and project are required" }, 400)
  }

  const tags = Array.from(
    new Set(
      form
        .getAll("tags")
        .flatMap((v) => String(v).split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).slice(0, 64)

  const maxCharsRaw = String(form.get("maxChars") ?? "").trim()
  const maxChars = maxCharsRaw ? Number(maxCharsRaw) : env.OA_RAG_INGEST_MAX_CHARS
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return c.json({ ok: false, error: "bad_maxChars" }, 400)
  }

  const fileValue = form.get("file")
  if (!fileValue || typeof fileValue === "string") {
    return c.json({ ok: false, error: "missing_file", detail: "file is required" }, 400)
  }
  const blob = fileValue as Blob
  const originalName =
    typeof (blob as any)?.name === "string" && String((blob as any).name).trim() ? String((blob as any).name).trim() : "upload.txt"
  if (!shouldIngestFileName(originalName)) {
    return c.json({ ok: false, error: "unsupported_extension", detail: "only .txt/.md/.markdown supported" }, 400)
  }

  const normalizedFile = normalizeDocName(originalName)
  const metaBefore = ragDb.getDocInfo({ tenant, project, file: normalizedFile })
  const storedBefore = Array.from(new Set([...(ragDb.getDocStoredNames({ tenant, project, file: normalizedFile }) ?? []), metaBefore?.storedName].filter(Boolean))).map(String)

  const deletedFiles: string[] = []
  const fileErrors: Record<string, string> = {}
  if (storedBefore.length) {
    const baseDir = path.resolve(path.join(uploadDir, tenant, project))
    for (const name of storedBefore) {
      const fp = path.resolve(path.join(baseDir, name))
      if (!isPathWithin(baseDir, fp)) continue
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
        deletedFiles.push(name)
      } catch (err) {
        fileErrors[name] = err instanceof Error ? err.message : String(err)
      }
    }
  }

  const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]+/g, "-")
  const dir = path.join(uploadDir, tenant, project)
  fs.mkdirSync(dir, { recursive: true })
  const storedName = `${Date.now()}-${safeName}`.slice(0, 200)
  const filePath = path.join(dir, storedName)
  try {
    await Bun.write(filePath, blob)
  } catch (err) {
    return c.json({ ok: false, error: "write_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }

  const finalTags = tags.length ? tags : (metaBefore?.tags ?? [])
  ragDb.upsertDocMeta({ tenant, project, file: normalizedFile, status: "draft", tags: finalTags })
  ragDb.queueDocIngest({ tenant, project, file: normalizedFile, storedName, maxChars })
  enqueueIngest({ tenant, project, file: normalizedFile })
  void emitAudit("rag.ingest.queued", { tenant, project, file: normalizedFile, storedName, maxChars, triggeredBy: "upload" })

  return c.json({
    ok: true,
    tenant,
    project,
    file: normalizedFile,
    status: "draft",
    tags: finalTags,
    storedBefore,
    deletedFiles,
    fileErrors,
    ingest: { status: "queued" },
  })
})

const DocUpdateInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  file: z.string().min(1),
  reason: z.string().max(200).optional(),
  status: z.enum(["draft", "approved", "archived"]).optional(),
  tags: z.array(z.string()).optional(),
})

app.post("/doc/update", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  const input = DocUpdateInput.parse(await c.req.json().catch(() => ({})))

  const before = ragDb.getDocMeta({ tenant: input.tenant, project: input.project, file: input.file })
  if (!before) return c.json({ ok: false, error: "not_found" }, 404)

  const status = input.status ?? before.status
  const tags = Array.isArray(input.tags) ? input.tags : before.tags
  const updated = ragDb.updateDocMeta({ tenant: input.tenant, project: input.project, file: input.file, status, tags })
  if (!updated) return c.json({ ok: false, error: "not_found" }, 404)

  return c.json({ ok: true, tenant: input.tenant, project: input.project, file: input.file, status, tags })
})

const DocIngestRetryInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  file: z.string().min(1),
  maxChars: z.coerce.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
})

app.post("/doc/ingest/retry", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  const input = DocIngestRetryInput.parse(await c.req.json().catch(() => ({})))

  const file = normalizeDocName(input.file)
  const info = ragDb.getDocInfo({ tenant: input.tenant, project: input.project, file })
  if (!info) return c.json({ ok: false, error: "not_found" }, 404)
  if (!info.storedName) return c.json({ ok: false, error: "no_stored_file" }, 400)

  const maxChars = typeof input.maxChars === "number" && Number.isFinite(input.maxChars) ? Math.floor(input.maxChars) : info.ingestMaxChars ?? env.OA_RAG_INGEST_MAX_CHARS
  ragDb.queueDocIngest({ tenant: input.tenant, project: input.project, file, storedName: info.storedName, maxChars })
  enqueueIngest({ tenant: input.tenant, project: input.project, file })
  void emitAudit("rag.ingest.queued", {
    tenant: input.tenant,
    project: input.project,
    file,
    storedName: info.storedName,
    maxChars,
    triggeredBy: "retry",
    reason: input.reason,
  })

  return c.json({ ok: true, tenant: input.tenant, project: input.project, file, ingest: { status: "queued" } })
})

app.post("/search", async (c) => {
  const input = Mcp.RagSearchInput.parse(await c.req.json().catch(() => ({})))
  const tenant = input.filters?.tenant
  const project = input.filters?.project
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "filters.tenant and filters.project are required" }, 400)
  }

  const tags = Array.isArray(input.filters?.tags) ? input.filters?.tags : undefined

  const rows = ragDb.search({ tenant, project, query: input.query, topK: input.topK, tags, onlyApproved: true })
  return c.json({
    passages: rows.map((r) => ({
      text: r.text,
      sourceId: r.sourceId,
      score: Number.isFinite(r.rank) ? 1 / (1 + Math.max(0, r.rank)) : 0.0,
      meta: (() => {
        if (!r.metaJson) return undefined
        try {
          const parsed = JSON.parse(r.metaJson)
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
        } catch {
          // ignore
        }
        return undefined
      })(),
    })),
  } satisfies Mcp.RagSearchOutput)
})

app.post("/admin/search", async (c) => {
  const admin = requireAdmin(c)
  if (admin) return admin
  const input = Mcp.RagSearchInput.parse(await c.req.json().catch(() => ({})))
  const tenant = input.filters?.tenant
  const project = input.filters?.project
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "filters.tenant and filters.project are required" }, 400)
  }

  const tags = Array.isArray(input.filters?.tags) ? input.filters?.tags : undefined
  const rows = ragDb.search({ tenant, project, query: input.query, topK: input.topK, tags, onlyApproved: false })
  return c.json({
    passages: rows.map((r) => ({
      text: r.text,
      sourceId: r.sourceId,
      score: Number.isFinite(r.rank) ? 1 / (1 + Math.max(0, r.rank)) : 0.0,
      meta: (() => {
        if (!r.metaJson) return undefined
        try {
          const parsed = JSON.parse(r.metaJson)
          if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
        } catch {
          // ignore
        }
        return undefined
      })(),
    })),
  } satisfies Mcp.RagSearchOutput)
})

// Resume queued ingests after restart.
try {
  ragDb.db.query("UPDATE docs SET ingestStatus = 'queued' WHERE ingestStatus = 'running'").run()
  const rows = ragDb.db.query<{ tenant: string; project: string; file: string }, []>(
    "SELECT tenant, project, file FROM docs WHERE ingestStatus = 'queued' ORDER BY updatedAtMs ASC LIMIT 500",
  ).all()
  for (const r of rows ?? []) {
    if (!r?.tenant || !r?.project || !r?.file) continue
    enqueueIngest({ tenant: String(r.tenant), project: String(r.project), file: String(r.file) })
  }
} catch {
  // ignore
}

const server = Bun.serve({
  hostname: env.OA_RAG_HOST,
  port: env.OA_RAG_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-rag listening on ${server.url}`)
