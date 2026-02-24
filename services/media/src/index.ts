import { Hono } from "hono"
import { Mcp } from "@open-assistant/protocol"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import z from "zod/v4"
import { openMediaDb, type MediaAssetRow, type MediaAssetStatus, type MediaAssetType } from "./db"
import { inferTypeFromExt, toAssetId } from "./ingest"

const Env = z.object({
  OA_MEDIA_HOST: z.string().default("0.0.0.0"),
  OA_MEDIA_PORT: z.coerce.number().int().positive().default(7004),
  OA_MEDIA_DB_PATH: z.string().default(fileURLToPath(new URL("../data/media.sqlite", import.meta.url))),
  OA_MEDIA_DEFAULT_TENANT: z.string().min(1).default("default"),
  OA_MEDIA_DEFAULT_PROJECT: z.string().min(1).default("open-assistant"),
  OA_MEDIA_ALLOW_HOSTS: z.string().optional(),
  OA_ADMIN_TOKEN: z.string().min(1).optional(),
  OA_MEDIA_ADMIN_TOKEN: z.string().min(1).optional(),
  OA_MEDIA_UPLOAD_DIR: z.string().optional(),
  OA_MEDIA_DEMO_VIDEO_FILE: z.string().optional(),
  OA_MEDIA_DEMO_SLIDES_FILE: z.string().optional(),
  OA_MEDIA_DEMO_MODEL_FILE: z.string().optional(),
})

function normalizedEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = typeof v === "string" && !v.trim() ? undefined : v
  }
  return out
}

const env = Env.parse(normalizedEnv(process.env))

const uploadDir = env.OA_MEDIA_UPLOAD_DIR ?? path.join(path.dirname(env.OA_MEDIA_DB_PATH), "uploads")

const DEFAULT_DEMO_VIDEO_FILE = fileURLToPath(new URL("../../media-mock/assets/demo.mp4", import.meta.url))
const demoVideoFile = env.OA_MEDIA_DEMO_VIDEO_FILE ?? DEFAULT_DEMO_VIDEO_FILE
const DEFAULT_DEMO_SLIDES_FILE = fileURLToPath(new URL("../../media-mock/assets/demo-slides.html", import.meta.url))
const demoSlidesFile = env.OA_MEDIA_DEMO_SLIDES_FILE ?? DEFAULT_DEMO_SLIDES_FILE
const DEFAULT_DEMO_MODEL_FILE = fileURLToPath(new URL("../../media-mock/assets/demo-model.gltf", import.meta.url))
const demoModelFile = env.OA_MEDIA_DEMO_MODEL_FILE ?? DEFAULT_DEMO_MODEL_FILE

const allowedHosts = new Set(
  (env.OA_MEDIA_ALLOW_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

const mediaDb = openMediaDb(env.OA_MEDIA_DB_PATH)
mediaDb.ensureSchema()

function ensureSeed() {
  if (mediaDb.countAssets() > 0) return
  const now = Date.now()
  const scope = { tenant: env.OA_MEDIA_DEFAULT_TENANT, project: env.OA_MEDIA_DEFAULT_PROJECT }
  mediaDb.upsertAsset({
    assetId: "demo-video",
    ...scope,
    type: "video",
    status: "approved",
    title: "Demo Video",
    tagsJson: JSON.stringify(["demo"]),
    sourceType: "local",
    source: demoVideoFile,
    createdAt: now,
  })
  mediaDb.upsertAsset({
    assetId: "demo-slides",
    ...scope,
    type: "slides",
    status: "approved",
    title: "Demo Slides",
    tagsJson: JSON.stringify(["demo"]),
    sourceType: "local",
    source: demoSlidesFile,
    createdAt: now,
  })
  mediaDb.upsertAsset({
    assetId: "demo-model",
    ...scope,
    type: "model",
    status: "approved",
    title: "Demo Model",
    tagsJson: JSON.stringify(["demo"]),
    sourceType: "local",
    source: demoModelFile,
    createdAt: now,
  })
}
ensureSeed()

function parseRange(range: string | null, size: number): { start: number; end: number } | undefined | null {
  if (!range) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m) return null
  const startRaw = m[1]
  const endRaw = m[2]

  const hasStart = startRaw !== ""
  const hasEnd = endRaw !== ""

  if (!hasStart && !hasEnd) return null

  if (!hasStart && hasEnd) {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isFinite(start) || start < 0) return null

  const end = hasEnd ? Number(endRaw) : size - 1
  if (!Number.isFinite(end) || end < start) return null

  const clampedEnd = Math.min(size - 1, end)
  if (start > clampedEnd) return null
  return { start, end: clampedEnd }
}

function inferMime(filePath: string, type: MediaAssetType): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".mp4") return "video/mp4"
  if (ext === ".webm") return "video/webm"
  if (ext === ".mp3") return "audio/mpeg"
  if (ext === ".wav") return "audio/wav"
  if (ext === ".glb") return "model/gltf-binary"
  if (ext === ".gltf") return "model/gltf+json"
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8"
  if (ext === ".pdf") return "application/pdf"
  if (type === "video") return "video/mp4"
  if (type === "model") return "model/gltf-binary"
  return "application/octet-stream"
}

function serveLocal(req: Request, asset: { filePath: string; mime: string }): Response {
  const file = Bun.file(asset.filePath)
  const size = file.size
  if (!Number.isFinite(size) || size <= 0) {
    return new Response(JSON.stringify({ ok: false, error: "asset_missing" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })
  }

  const headers = new Headers()
  headers.set("content-type", asset.mime)
  headers.set("accept-ranges", "bytes")
  headers.set("cache-control", "no-store")
  headers.set("access-control-allow-origin", "*")

  const rangeHeader = req.headers.get("range")
  const range = parseRange(rangeHeader, size)
  if (rangeHeader && range === null) {
    headers.set("content-range", `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  if (!range) {
    headers.set("content-length", String(size))
    return new Response(req.method === "HEAD" ? null : file, { status: 200, headers })
  }

  const { start, end } = range
  const chunk = file.slice(start, end + 1)
  headers.set("content-range", `bytes ${start}-${end}/${size}`)
  headers.set("content-length", String(end - start + 1))
  return new Response(req.method === "HEAD" ? null : chunk, { status: 206, headers })
}

async function serveRemote(req: Request, asset: { url: string }): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(asset.url)
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad_source_url" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Response(JSON.stringify({ ok: false, error: "source_scheme_not_allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  if (allowedHosts.size === 0) {
    return new Response(JSON.stringify({ ok: false, error: "remote_source_not_allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  if (!allowedHosts.has(parsed.host)) {
    return new Response(JSON.stringify({ ok: false, error: "source_host_not_allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })
  }

  const headers: Record<string, string> = {}
  for (const key of ["range", "if-range", "if-modified-since", "if-none-match"]) {
    const v = req.headers.get(key)
    if (v) headers[key] = v
  }

  let upstream: Response
  try {
    upstream = await fetch(parsed, { method: req.method, headers, redirect: "manual" })
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }),
      { status: 502, headers: { "content-type": "application/json" } },
    )
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return new Response(JSON.stringify({ ok: false, error: "redirect_not_allowed" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })
  }

  const outHeaders = new Headers()
  for (const key of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key)
    if (value) outHeaders.set(key, value)
  }
  outHeaders.set("cache-control", "no-store")
  outHeaders.set("access-control-allow-origin", "*")

  return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: outHeaders })
}

function parseTags(tagsJson: string | null) {
  try {
    const parsed = tagsJson ? JSON.parse(tagsJson) : undefined
    if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === "string")
  } catch {
    // ignore
  }
  return undefined
}

function safeHostFromUrl(value: string) {
  try {
    return new URL(value).host
  } catch {
    return undefined
  }
}

function inferTypeFromSource(asset: Pick<MediaAssetRow, "sourceType" | "source">): MediaAssetType | undefined {
  if (asset.sourceType === "remote") {
    try {
      return inferTypeFromExt(new URL(asset.source).pathname)
    } catch {
      return undefined
    }
  }
  return inferTypeFromExt(asset.source)
}

function isPathWithin(baseDir: string, filePath: string) {
  const rel = path.relative(baseDir, filePath)
  if (!rel) return true
  if (rel.startsWith("..")) return false
  if (path.isAbsolute(rel)) return false
  return true
}

function parseBearer(value: string | undefined | null) {
  if (!value) return
  const m = value.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || undefined
}

function requireAdmin(c: any) {
  const configured = (env.OA_MEDIA_ADMIN_TOKEN ?? env.OA_ADMIN_TOKEN)?.trim()
  if (!configured) return
  const token = c.req.query("token") ?? parseBearer(c.req.header("authorization"))
  if (token !== configured) return c.json({ ok: false, error: "unauthorized" }, 401)
}

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))
app.get("/admin/config", (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  return c.json({
    ok: true,
    remoteEnabled: allowedHosts.size > 0,
    allowHosts: Array.from(allowedHosts).sort(),
  })
})

const AssetID = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
const AssetStatus = z.enum(["draft", "approved", "archived"])

app.post("/asset/search", async (c) => {
  const input = Mcp.AssetSearchInput.parse(await c.req.json().catch(() => ({})))
  const tenant = input.filters?.tenant
  const project = input.filters?.project
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "filters.tenant and filters.project are required" }, 400)
  }

  const tags = Array.isArray(input.filters?.tags) ? input.filters?.tags : undefined

  const rows = mediaDb.searchAssets({
    tenant,
    project,
    query: input.query,
    type: input.type,
    status: "approved",
    tags,
    topK: input.topK,
  })

  return c.json({
    assets: rows.map((r) => ({
      assetId: r.assetId,
      type: r.type,
      title: r.title ?? undefined,
      tags: parseTags(r.tagsJson),
    })),
  } satisfies Mcp.AssetSearchOutput)
})

const AssetListInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  type: Mcp.AssetType.optional(),
  status: AssetStatus.optional(),
  limit: z.coerce.number().int().positive().max(1000).default(50),
  cursor: z.string().min(1).optional(),
})

app.post("/asset/list", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  const input = AssetListInput.parse(await c.req.json().catch(() => ({})))
  const rows = mediaDb.listAssets({
    tenant: input.tenant,
    project: input.project,
    query: input.query,
    tags: input.tags,
    type: input.type,
    status: input.status,
    limit: input.limit,
    cursor: input.cursor,
  })

  const assets = rows.map((r) => ({
    assetId: r.assetId,
    type: r.type,
    status: r.status,
    title: r.title ?? undefined,
    tags: parseTags(r.tagsJson),
    sourceType: r.sourceType,
    sourceHost: r.sourceType === "remote" ? safeHostFromUrl(r.source) : undefined,
  }))

  const nextCursor = rows.at(-1)?.assetId
  return c.json({ ok: true, assets, nextCursor })
})

const AssetDeleteInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  assetId: AssetID,
  deleteFile: z.coerce.boolean().default(true),
})

app.post("/asset/delete", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  const input = AssetDeleteInput.parse(await c.req.json().catch(() => ({})))
  const asset = mediaDb.getAssetById(input.assetId)
  if (!asset) return c.json({ ok: false, error: "not_found" }, 404)
  if (asset.tenant !== input.tenant || asset.project !== input.project) return c.json({ ok: false, error: "not_found" }, 404)

  const deleted = mediaDb.deleteAsset({ tenant: input.tenant, project: input.project, assetId: input.assetId })
  if (!deleted) return c.json({ ok: false, error: "not_found" }, 404)

  let deletedFile = false
  let fileError: string | undefined

  if (input.deleteFile && asset.sourceType === "local") {
    const baseDir = path.resolve(path.join(uploadDir, input.tenant, input.project))
    const filePath = path.resolve(asset.source)
    if (isPathWithin(baseDir, filePath)) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
        deletedFile = true
      } catch (err) {
        fileError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return c.json({
    ok: true,
    assetId: input.assetId,
    deleted: true,
    deletedFile,
    fileError,
  })
})

const AssetUpdateInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  assetId: AssetID,
  reason: z.string().optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  type: Mcp.AssetType.optional(),
  status: AssetStatus.optional(),
})

app.post("/asset/update", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  const input = AssetUpdateInput.parse(await c.req.json().catch(() => ({})))
  const asset = mediaDb.getAssetById(input.assetId)
  if (!asset) return c.json({ ok: false, error: "not_found" }, 404)
  if (asset.tenant !== input.tenant || asset.project !== input.project) return c.json({ ok: false, error: "not_found" }, 404)

  const title = typeof input.title === "string" ? input.title.trim() || null : asset.title
  const tags =
    Array.isArray(input.tags) && input.tags.length
      ? input.tags
          .flatMap((v) => String(v).split(","))
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 64)
      : Array.isArray(input.tags)
        ? []
        : undefined

  let type: MediaAssetType = asset.type
  if (input.type) {
    const inferred = inferTypeFromSource(asset)
    if (inferred && inferred !== input.type) {
      return c.json({ ok: false, error: "type_mismatch", detail: `file extension suggests ${inferred}` }, 400)
    }
    type = input.type
  }

  const status: MediaAssetStatus = input.status ? input.status : asset.status
  if (asset.sourceType === "remote" && status === "approved" && asset.status !== "approved") {
    const host = safeHostFromUrl(asset.source)
    if (!host) {
      return c.json({ ok: false, error: "bad_source_url" }, 500)
    }
    if (allowedHosts.size === 0) {
      return c.json({ ok: false, error: "remote_source_not_allowed", allowedHosts: [] as string[] }, 403)
    }
    const allowHosts = Array.from(allowedHosts).sort()
    if (!allowedHosts.has(host)) {
      return c.json({ ok: false, error: "source_host_not_allowed", allowedHosts: allowHosts }, 403)
    }
  }

  const updated: MediaAssetRow = {
    ...asset,
    type,
    status,
    title,
    tagsJson: tags ? (tags.length ? JSON.stringify(tags) : null) : asset.tagsJson,
  }

  mediaDb.upsertAsset(updated)

  return c.json({
    ok: true,
    asset: {
      assetId: updated.assetId,
      type: updated.type,
      status: updated.status,
      title: updated.title ?? undefined,
      tags: parseTags(updated.tagsJson),
      sourceType: updated.sourceType,
      sourceHost: updated.sourceType === "remote" ? safeHostFromUrl(updated.source) : undefined,
    },
  })
})

const AssetRemoteCreateInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  assetId: AssetID.optional(),
  url: z.string().min(1).max(4096),
  type: z.enum(["auto", "video", "slides", "model"]).default("auto"),
  status: AssetStatus.default("draft"),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

app.post("/asset/remote", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  const input = AssetRemoteCreateInput.parse(await c.req.json().catch(() => ({})))

  const tenant = input.tenant.trim()
  const project = input.project.trim()
  if (!tenant || !project) return c.json({ ok: false, error: "missing_scope", detail: "tenant/project are required" }, 400)

  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return c.json({ ok: false, error: "bad_source_url" }, 400)
  }

  if (parsed.username || parsed.password) {
    return c.json({ ok: false, error: "source_credentials_not_allowed" }, 400)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ ok: false, error: "source_scheme_not_allowed" }, 403)
  }

  if (allowedHosts.size === 0) {
    return c.json({ ok: false, error: "remote_source_not_allowed", allowedHosts: [] as string[] }, 403)
  }

  const allowHosts = Array.from(allowedHosts).sort()
  if (!allowedHosts.has(parsed.host)) {
    return c.json({ ok: false, error: "source_host_not_allowed", allowedHosts: allowHosts }, 403)
  }

  const inferred = inferTypeFromExt(parsed.pathname)
  const type: MediaAssetType | undefined =
    input.type === "auto" ? inferred : input.type === "video" || input.type === "slides" || input.type === "model" ? input.type : undefined
  if (!type) {
    return c.json({ ok: false, error: "unsupported_type", detail: "type=auto/video/slides/model; or infer from URL path extension" }, 400)
  }
  if (input.type !== "auto" && inferred && inferred !== type) {
    return c.json({ ok: false, error: "type_mismatch", detail: `url path extension suggests ${inferred}` }, 400)
  }
  if (!inferred && input.type === "auto") {
    return c.json({ ok: false, error: "unsupported_extension", detail: "cannot infer type from URL path extension" }, 400)
  }

  const assetId = input.assetId ? AssetID.parse(input.assetId) : toAssetId(`${tenant}/${project}/${parsed.toString()}`)
  const existing = mediaDb.getAssetById(assetId)
  if (existing) {
    return c.json({ ok: false, error: "already_exists" }, 409)
  }

  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : path.basename(parsed.pathname) || parsed.host
  const tags =
    Array.isArray(input.tags) && input.tags.length
      ? input.tags
          .flatMap((v) => String(v).split(","))
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 64)
      : Array.isArray(input.tags)
        ? []
        : undefined

  const asset: MediaAssetRow = {
    assetId,
    tenant,
    project,
    type,
    status: input.status,
    title: title || null,
    tagsJson: tags ? (tags.length ? JSON.stringify(tags) : null) : null,
    sourceType: "remote",
    source: parsed.toString(),
    createdAt: Date.now(),
  }
  mediaDb.upsertAsset(asset)

  return c.json({
    ok: true,
    asset: {
      assetId: asset.assetId,
      type: asset.type,
      status: asset.status,
      title: asset.title ?? undefined,
      tags: parseTags(asset.tagsJson),
      sourceType: asset.sourceType,
      sourceHost: parsed.host,
    },
  })
})

const AssetRemoteUpdateInput = z.object({
  tenant: z.string().min(1),
  project: z.string().min(1),
  assetId: AssetID,
  url: z.string().min(1).max(4096),
  type: z.enum(["auto", "video", "slides", "model"]).optional(),
  reason: z.string().optional(),
})

app.post("/asset/remote/update", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  const input = AssetRemoteUpdateInput.parse(await c.req.json().catch(() => ({})))

  const asset = mediaDb.getAssetById(input.assetId)
  if (!asset) return c.json({ ok: false, error: "not_found" }, 404)
  if (asset.tenant !== input.tenant || asset.project !== input.project) return c.json({ ok: false, error: "not_found" }, 404)
  if (asset.sourceType !== "remote") return c.json({ ok: false, error: "not_remote" }, 400)

  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    return c.json({ ok: false, error: "bad_source_url" }, 400)
  }

  if (parsed.username || parsed.password) {
    return c.json({ ok: false, error: "source_credentials_not_allowed" }, 400)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return c.json({ ok: false, error: "source_scheme_not_allowed" }, 403)
  }

  if (allowedHosts.size === 0) {
    return c.json({ ok: false, error: "remote_source_not_allowed", allowedHosts: [] as string[] }, 403)
  }

  const allowHosts = Array.from(allowedHosts).sort()
  if (!allowedHosts.has(parsed.host)) {
    return c.json({ ok: false, error: "source_host_not_allowed", allowedHosts: allowHosts }, 403)
  }

  const inferred = inferTypeFromExt(parsed.pathname)
  let type: MediaAssetType = asset.type
  if (input.type) {
    const requested: MediaAssetType | "auto" = input.type
    if (requested === "auto") {
      if (!inferred) {
        return c.json({ ok: false, error: "unsupported_extension", detail: "cannot infer type from URL path extension" }, 400)
      }
      type = inferred
    } else {
      if (inferred && inferred !== requested) {
        return c.json({ ok: false, error: "type_mismatch", detail: `url path extension suggests ${inferred}` }, 400)
      }
      type = requested
    }
  } else {
    if (inferred && inferred !== asset.type) {
      return c.json({ ok: false, error: "type_mismatch", detail: `url path extension suggests ${inferred}` }, 400)
    }
  }

  const updated: MediaAssetRow = {
    ...asset,
    type,
    status: parsed.toString() !== asset.source && asset.status === "approved" ? "draft" : asset.status,
    source: parsed.toString(),
  }
  mediaDb.upsertAsset(updated)

  return c.json({
    ok: true,
    asset: {
      assetId: updated.assetId,
      type: updated.type,
      status: updated.status,
      title: updated.title ?? undefined,
      tags: parseTags(updated.tagsJson),
      sourceType: updated.sourceType,
      sourceHost: parsed.host,
    },
  })
})

app.post("/asset/upload", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
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

  const fileValue = form.get("file")
  if (!fileValue || typeof fileValue === "string") {
    return c.json({ ok: false, error: "missing_file", detail: "file is required" }, 400)
  }
  const blob = fileValue as Blob
  const originalName =
    typeof (blob as any)?.name === "string" && String((blob as any).name).trim() ? String((blob as any).name).trim() : "upload.bin"

  const ext = path.extname(originalName).toLowerCase()
  const inferred = inferTypeFromExt(originalName)

  const typeRaw = String(form.get("type") ?? "").trim().toLowerCase()
  const type: MediaAssetType | undefined =
    typeRaw === "" || typeRaw === "auto" ? inferred : typeRaw === "video" || typeRaw === "slides" || typeRaw === "model" ? typeRaw : undefined
  if (!type) {
    return c.json({ ok: false, error: "unsupported_type", detail: "type=auto/video/slides/model; or infer from file extension" }, 400)
  }
  if (typeRaw && typeRaw !== "auto" && inferred && inferred !== type) {
    return c.json({ ok: false, error: "type_mismatch", detail: `file extension suggests ${inferred}` }, 400)
  }
  if (!inferred && (typeRaw === "" || typeRaw === "auto")) {
    return c.json({ ok: false, error: "unsupported_extension", detail: "cannot infer type from file extension" }, 400)
  }

  const assetIdRaw = String(form.get("assetId") ?? "").trim()
  const assetId = assetIdRaw ? AssetID.parse(assetIdRaw) : toAssetId(`${tenant}/${project}/${originalName}`)

  const title = String(form.get("title") ?? "").trim() || originalName
  const tags = form
    .getAll("tags")
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 64)

  const dir = path.join(uploadDir, tenant, project)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${assetId}${ext}`)

  try {
    await Bun.write(filePath, blob)
  } catch (err) {
    return c.json({ ok: false, error: "write_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }

  const asset: MediaAssetRow = {
    assetId,
    tenant,
    project,
    type,
    status: "draft",
    title,
    tagsJson: tags.length ? JSON.stringify(tags) : null,
    sourceType: "local",
    source: filePath,
    createdAt: Date.now(),
  }
  mediaDb.upsertAsset(asset)

  return c.json({ ok: true, tenant, project, assetId, type, status: asset.status, title, tags, bytes: (blob as any).size })
})

async function serveAssetById(c: any, opts: { allowUnapproved: boolean }) {
  const assetId = c.req.param("assetId") ?? ""
  const tenant = c.req.query("tenant")
  const project = c.req.query("project")
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "tenant and project query params are required" }, 400)
  }

  const asset = mediaDb.getAssetById(assetId)
  if (!asset) return c.json({ ok: false, error: "not_found" }, 404)
  if (asset.tenant !== tenant || asset.project !== project) return c.json({ ok: false, error: "not_found" }, 404)
  if (!opts.allowUnapproved && asset.status !== "approved") return c.json({ ok: false, error: "not_found" }, 404)

  if (asset.sourceType === "remote") {
    return await serveRemote(c.req.raw, { url: asset.source })
  }

  const mime = inferMime(asset.source, asset.type)
  return serveLocal(c.req.raw, { filePath: asset.source, mime })
}

app.get("/admin/assets/:assetId", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  return await serveAssetById(c, { allowUnapproved: true })
})

app.on("HEAD", "/admin/assets/:assetId", async (c) => {
  const authErr = requireAdmin(c)
  if (authErr) return authErr
  return await serveAssetById(c, { allowUnapproved: true })
})

app.get("/assets/:assetId", async (c) => {
  return await serveAssetById(c, { allowUnapproved: false })
})

app.on("HEAD", "/assets/:assetId", async (c) => {
  return await serveAssetById(c, { allowUnapproved: false })
})

const server = Bun.serve({
  hostname: env.OA_MEDIA_HOST,
  port: env.OA_MEDIA_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-media listening on ${server.url}`)
