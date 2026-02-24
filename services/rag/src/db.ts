import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs"

export type RagPassageRow = {
  sourceId: string
  text: string
  metaJson: string | null
  rank: number
}

export type RagDocStatus = "draft" | "approved" | "archived"

export type RagIngestStatus = "idle" | "queued" | "running" | "succeeded" | "failed"

export type RagDb = {
  db: Database
  close: () => void
  ensureSchema: () => void
  countPassages: () => number
  upsertPassage: (input: {
    tenant: string
    project: string
    sourceId: string
    text: string
    metaJson?: string | null
  }) => void
  deleteDoc: (input: { tenant: string; project: string; file: string }) => number
  deleteDocMeta: (input: { tenant: string; project: string; file: string }) => boolean
  upsertDocMeta: (input: { tenant: string; project: string; file: string; status: RagDocStatus; tags?: string[] }) => void
  getDocMeta: (input: { tenant: string; project: string; file: string }) => { status: RagDocStatus; tags: string[] } | undefined
  getDocInfo: (input: { tenant: string; project: string; file: string }) =>
    | {
        status: RagDocStatus
        tags: string[]
        storedName?: string
        ingestStatus: RagIngestStatus
        ingestError?: string
        ingestTotalChunks?: number
        ingestDoneChunks?: number
        ingestStartedAtMs?: number
        ingestFinishedAtMs?: number
        ingestUpdatedAtMs?: number
        ingestMaxChars?: number
      }
    | undefined
  updateDocMeta: (input: { tenant: string; project: string; file: string; status: RagDocStatus; tags: string[] }) => boolean
  updateDocStoredName: (input: { tenant: string; project: string; file: string; storedName: string | null }) => boolean
  queueDocIngest: (input: { tenant: string; project: string; file: string; storedName: string; maxChars: number }) => boolean
  startDocIngest: (input: { tenant: string; project: string; file: string; storedName: string; totalChunks: number }) => boolean
  progressDocIngest: (input: { tenant: string; project: string; file: string; storedName: string; doneChunks: number; totalChunks: number }) => boolean
  finishDocIngestSucceeded: (input: { tenant: string; project: string; file: string; storedName: string; totalChunks: number }) => boolean
  finishDocIngestFailed: (input: { tenant: string; project: string; file: string; storedName: string; error: string }) => boolean
  listDocs: (input: {
    tenant: string
    project: string
    query?: string
    limit: number
    cursor?: string
    status?: RagDocStatus | "all"
    tags?: string[]
  }) => Array<{
    file: string
    chunks: number
    status: RagDocStatus
    tags: string[]
    storedName?: string
    ingestStatus?: RagIngestStatus
    ingestError?: string
    ingestTotalChunks?: number
    ingestDoneChunks?: number
    ingestStartedAtMs?: number
    ingestFinishedAtMs?: number
    ingestUpdatedAtMs?: number
  }>
  getDocStoredNames: (input: { tenant: string; project: string; file: string }) => string[]
  search: (input: {
    tenant: string
    project: string
    query: string
    topK: number
    tags?: string[]
    onlyApproved?: boolean
  }) => RagPassageRow[]
}

export function openRagDb(dbPath: string): RagDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }

  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL;")
  db.exec("PRAGMA synchronous=NORMAL;")

  function ensureSchema() {
    db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
  tenant UNINDEXED,
  project UNINDEXED,
  sourceId UNINDEXED,
  text,
  metaJson UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS docs(
  tenant TEXT NOT NULL,
  project TEXT NOT NULL,
  file TEXT NOT NULL,
  status TEXT NOT NULL,
  tagsJson TEXT NOT NULL DEFAULT '[]',
  storedName TEXT,
  ingestStatus TEXT NOT NULL DEFAULT 'idle',
  ingestError TEXT,
  ingestTotalChunks INTEGER,
  ingestDoneChunks INTEGER,
  ingestStartedAtMs INTEGER,
  ingestFinishedAtMs INTEGER,
  ingestUpdatedAtMs INTEGER,
  ingestMaxChars INTEGER,
  createdAtMs INTEGER NOT NULL,
  updatedAtMs INTEGER NOT NULL,
  PRIMARY KEY (tenant, project, file)
);
CREATE INDEX IF NOT EXISTS idx_docs_scope_status_file ON docs(tenant, project, status, file);
CREATE INDEX IF NOT EXISTS idx_docs_scope_ingest_file ON docs(tenant, project, ingestStatus, file);
`)

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(docs)").all().map((c) => c.name)
    if (!cols.includes("storedName")) db.exec("ALTER TABLE docs ADD COLUMN storedName TEXT;")
    if (!cols.includes("ingestStatus")) db.exec("ALTER TABLE docs ADD COLUMN ingestStatus TEXT DEFAULT 'idle';")
    if (!cols.includes("ingestError")) db.exec("ALTER TABLE docs ADD COLUMN ingestError TEXT;")
    if (!cols.includes("ingestTotalChunks")) db.exec("ALTER TABLE docs ADD COLUMN ingestTotalChunks INTEGER;")
    if (!cols.includes("ingestDoneChunks")) db.exec("ALTER TABLE docs ADD COLUMN ingestDoneChunks INTEGER;")
    if (!cols.includes("ingestStartedAtMs")) db.exec("ALTER TABLE docs ADD COLUMN ingestStartedAtMs INTEGER;")
    if (!cols.includes("ingestFinishedAtMs")) db.exec("ALTER TABLE docs ADD COLUMN ingestFinishedAtMs INTEGER;")
    if (!cols.includes("ingestUpdatedAtMs")) db.exec("ALTER TABLE docs ADD COLUMN ingestUpdatedAtMs INTEGER;")
    if (!cols.includes("ingestMaxChars")) db.exec("ALTER TABLE docs ADD COLUMN ingestMaxChars INTEGER;")
    db.exec("UPDATE docs SET ingestStatus = 'idle' WHERE ingestStatus IS NULL;")
    db.exec("CREATE INDEX IF NOT EXISTS idx_docs_scope_ingest_file ON docs(tenant, project, ingestStatus, file);")

    // Backfill doc meta for existing ingested passages (treat as approved).
    db.exec(`
INSERT OR IGNORE INTO docs(tenant, project, file, status, tagsJson, createdAtMs, updatedAtMs)
SELECT
  tenant,
  project,
  substr(sourceId, 1, instr(sourceId, '#') - 1) AS file,
  'approved' AS status,
  '[]' AS tagsJson,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS createdAtMs,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS updatedAtMs
FROM passages
WHERE instr(sourceId, '#') > 0
GROUP BY tenant, project, file;
`)
  }

  function close() {
    db.close()
  }

  function countPassages() {
    const row = db.query<{ n: number }, []>("SELECT COUNT(1) AS n FROM passages").get()
    return row?.n ?? 0
  }

  function upsertPassage(input: { tenant: string; project: string; sourceId: string; text: string; metaJson?: string | null }) {
    // FTS5 tables support INSERT + "replace" semantics by rowid; we treat sourceId as unique key by manual delete.
    db.query("DELETE FROM passages WHERE tenant = ? AND project = ? AND sourceId = ?").run(input.tenant, input.project, input.sourceId)
    db.query("INSERT INTO passages(tenant, project, sourceId, text, metaJson) VALUES(?, ?, ?, ?, ?)").run(
      input.tenant,
      input.project,
      input.sourceId,
      input.text,
      input.metaJson ?? null,
    )
  }

  function normalizeDocName(file: string) {
    return file.replaceAll("\\\\", "/").replace(/^\/+/, "")
  }

  function parseTags(tagsJson: string | null): string[] {
    try {
      const parsed = tagsJson ? JSON.parse(tagsJson) : undefined
      if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim())
    } catch {
      // ignore
    }
    return []
  }

  function normalizeStatus(status: string): RagDocStatus {
    if (status === "draft" || status === "archived" || status === "approved") return status
    return "approved"
  }

  function normalizeIngestStatus(status: string | null | undefined): RagIngestStatus {
    if (status === "queued" || status === "running" || status === "succeeded" || status === "failed" || status === "idle") return status
    return "idle"
  }

  function escapeLike(input: string) {
    return input.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
  }

  function docPattern(file: string) {
    const base = normalizeDocName(file)
    return `${escapeLike(base)}#%`
  }

  function deleteDoc(input: { tenant: string; project: string; file: string }) {
    const pattern = docPattern(input.file)
    const res = db
      .query<unknown, [string, string, string]>("DELETE FROM passages WHERE tenant = ? AND project = ? AND sourceId LIKE ? ESCAPE '\\'")
      .run(input.tenant, input.project, pattern)
    return res.changes ?? 0
  }

  function deleteDocMeta(input: { tenant: string; project: string; file: string }) {
    const normalized = normalizeDocName(input.file)
    const res = db.query<unknown, [string, string, string]>("DELETE FROM docs WHERE tenant = ? AND project = ? AND file = ?").run(input.tenant, input.project, normalized)
    return (res.changes ?? 0) > 0
  }

  function upsertDocMeta(input: { tenant: string; project: string; file: string; status: RagDocStatus; tags?: string[] }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const tagsJson = JSON.stringify(Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [])
    db.query(
      `
INSERT INTO docs(tenant, project, file, status, tagsJson, createdAtMs, updatedAtMs)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(tenant, project, file) DO UPDATE SET
  status = excluded.status,
  tagsJson = excluded.tagsJson,
  updatedAtMs = excluded.updatedAtMs
`,
    ).run(input.tenant, input.project, normalized, input.status, tagsJson, now, now)
  }

  function getDocMeta(input: { tenant: string; project: string; file: string }) {
    const normalized = normalizeDocName(input.file)
    const row = db
      .query<{ status: string; tagsJson: string | null }, [string, string, string]>("SELECT status, tagsJson FROM docs WHERE tenant = ? AND project = ? AND file = ?")
      .get(input.tenant, input.project, normalized)
    if (!row) return undefined
    return { status: normalizeStatus(row.status), tags: parseTags(row.tagsJson) }
  }

  function getDocInfo(input: { tenant: string; project: string; file: string }) {
    const normalized = normalizeDocName(input.file)
    const row = db
      .query<
        {
          status: string
          tagsJson: string | null
          storedName: string | null
          ingestStatus: string | null
          ingestError: string | null
          ingestTotalChunks: number | null
          ingestDoneChunks: number | null
          ingestStartedAtMs: number | null
          ingestFinishedAtMs: number | null
          ingestUpdatedAtMs: number | null
          ingestMaxChars: number | null
        },
        [string, string, string]
      >(
        `
SELECT
  status,
  tagsJson,
  storedName,
  ingestStatus,
  ingestError,
  ingestTotalChunks,
  ingestDoneChunks,
  ingestStartedAtMs,
  ingestFinishedAtMs,
  ingestUpdatedAtMs,
  ingestMaxChars
FROM docs
WHERE tenant = ? AND project = ? AND file = ?
`,
      )
      .get(input.tenant, input.project, normalized)
    if (!row) return undefined
    return {
      status: normalizeStatus(row.status),
      tags: parseTags(row.tagsJson),
      storedName: typeof row.storedName === "string" && row.storedName.trim() ? row.storedName.trim() : undefined,
      ingestStatus: normalizeIngestStatus(row.ingestStatus),
      ingestError: typeof row.ingestError === "string" && row.ingestError.trim() ? row.ingestError.trim() : undefined,
      ingestTotalChunks: typeof row.ingestTotalChunks === "number" ? row.ingestTotalChunks : undefined,
      ingestDoneChunks: typeof row.ingestDoneChunks === "number" ? row.ingestDoneChunks : undefined,
      ingestStartedAtMs: typeof row.ingestStartedAtMs === "number" ? row.ingestStartedAtMs : undefined,
      ingestFinishedAtMs: typeof row.ingestFinishedAtMs === "number" ? row.ingestFinishedAtMs : undefined,
      ingestUpdatedAtMs: typeof row.ingestUpdatedAtMs === "number" ? row.ingestUpdatedAtMs : undefined,
      ingestMaxChars: typeof row.ingestMaxChars === "number" ? row.ingestMaxChars : undefined,
    }
  }

  function updateDocMeta(input: { tenant: string; project: string; file: string; status: RagDocStatus; tags: string[] }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const tagsJson = JSON.stringify(Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [])
    const res = db
      .query<unknown, [RagDocStatus, string, number, string, string, string]>(
        "UPDATE docs SET status = ?, tagsJson = ?, updatedAtMs = ? WHERE tenant = ? AND project = ? AND file = ?",
      )
      .run(input.status, tagsJson, now, input.tenant, input.project, normalized)
    return (res.changes ?? 0) > 0
  }

  function updateDocStoredName(input: { tenant: string; project: string; file: string; storedName: string | null }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const stored = typeof input.storedName === "string" && input.storedName.trim() ? input.storedName.trim() : null
    const res = db
      .query<unknown, [string | null, number, string, string, string]>("UPDATE docs SET storedName = ?, updatedAtMs = ? WHERE tenant = ? AND project = ? AND file = ?")
      .run(stored, now, input.tenant, input.project, normalized)
    return (res.changes ?? 0) > 0
  }

  function queueDocIngest(input: { tenant: string; project: string; file: string; storedName: string; maxChars: number }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const stored = input.storedName.trim()
    const maxChars = Math.max(1, Math.floor(input.maxChars))
    const res = db
      .query<unknown, [string, number, number, number, string, string, string]>(
        `
UPDATE docs
SET
  storedName = ?,
  ingestStatus = 'queued',
  ingestError = NULL,
  ingestTotalChunks = NULL,
  ingestDoneChunks = NULL,
  ingestStartedAtMs = NULL,
  ingestFinishedAtMs = NULL,
  ingestUpdatedAtMs = ?,
  ingestMaxChars = ?,
  updatedAtMs = ?
WHERE tenant = ? AND project = ? AND file = ?
`,
      )
      .run(stored, now, maxChars, now, input.tenant, input.project, normalized)
    return (res.changes ?? 0) > 0
  }

  function startDocIngest(input: { tenant: string; project: string; file: string; storedName: string; totalChunks: number }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const total = Math.max(0, Math.floor(input.totalChunks))
    const stored = input.storedName.trim()
    const res = db
      .query<unknown, [number, number, number, number, string, string, string, string]>(
        `
UPDATE docs
SET
  ingestStatus = 'running',
  ingestError = NULL,
  ingestTotalChunks = ?,
  ingestDoneChunks = 0,
  ingestStartedAtMs = ?,
  ingestUpdatedAtMs = ?,
  updatedAtMs = ?
WHERE tenant = ? AND project = ? AND file = ? AND storedName = ? AND ingestStatus = 'queued'
`,
      )
      .run(total, now, now, now, input.tenant, input.project, normalized, stored)
    return (res.changes ?? 0) > 0
  }

  function progressDocIngest(input: { tenant: string; project: string; file: string; storedName: string; doneChunks: number; totalChunks: number }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const total = Math.max(0, Math.floor(input.totalChunks))
    const done = Math.max(0, Math.min(total, Math.floor(input.doneChunks)))
    const stored = input.storedName.trim()
    const res = db
      .query<unknown, [number, number, number, number, string, string, string, string]>(
        `
UPDATE docs
SET
  ingestTotalChunks = ?,
  ingestDoneChunks = ?,
  ingestUpdatedAtMs = ?,
  updatedAtMs = ?
WHERE tenant = ? AND project = ? AND file = ? AND storedName = ?
`,
      )
      .run(total, done, now, now, input.tenant, input.project, normalized, stored)
    return (res.changes ?? 0) > 0
  }

  function finishDocIngestSucceeded(input: { tenant: string; project: string; file: string; storedName: string; totalChunks: number }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const total = Math.max(0, Math.floor(input.totalChunks))
    const stored = input.storedName.trim()
    const res = db
      .query<unknown, [number, number, number, number, number, string, string, string, string]>(
        `
UPDATE docs
SET
  ingestStatus = 'succeeded',
  ingestError = NULL,
  ingestTotalChunks = ?,
  ingestDoneChunks = ?,
  ingestFinishedAtMs = ?,
  ingestUpdatedAtMs = ?,
  updatedAtMs = ?
WHERE tenant = ? AND project = ? AND file = ? AND storedName = ?
`,
      )
      .run(total, total, now, now, now, input.tenant, input.project, normalized, stored)
    return (res.changes ?? 0) > 0
  }

  function finishDocIngestFailed(input: { tenant: string; project: string; file: string; storedName: string; error: string }) {
    const normalized = normalizeDocName(input.file)
    const now = Date.now()
    const err = input.error.trim().slice(0, 400)
    const stored = input.storedName.trim()
    const res = db
      .query<unknown, [string, number, number, number, string, string, string, string]>(
        `
UPDATE docs
SET
  ingestStatus = 'failed',
  ingestError = ?,
  ingestFinishedAtMs = ?,
  ingestUpdatedAtMs = ?,
  updatedAtMs = ?
WHERE tenant = ? AND project = ? AND file = ? AND storedName = ?
`,
      )
      .run(err, now, now, now, input.tenant, input.project, normalized, stored)
    return (res.changes ?? 0) > 0
  }

  function listDocs(input: {
    tenant: string
    project: string
    query?: string
    limit: number
    cursor?: string
    status?: RagDocStatus | "all"
    tags?: string[]
  }) {
    const where: string[] = ["d.tenant = ?", "d.project = ?"]
    const params: Array<string | number> = [input.tenant, input.project, input.tenant, input.project]

    const q = (input.query ?? "").trim()
    if (q) {
      where.push("d.file LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(q)}%`)
    }

    const tags = Array.from(
      new Set(
        (input.tags ?? [])
          .filter((t) => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ).slice(0, 20)
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM json_each(d.tagsJson) WHERE value IN (${tags.map(() => "?").join(",")}))`)
      params.push(...tags)
    }

    if (input.cursor) {
      where.push("d.file > ?")
      params.push(input.cursor)
    }
    if (input.status && input.status !== "all") {
      where.push("d.status = ?")
      params.push(input.status)
    }

    const limit = Math.min(1000, Math.max(1, Math.floor(input.limit)))
    params.push(limit)

    const sql = `
SELECT
  d.file AS file,
  COALESCE(p.chunks, 0) AS chunks,
  d.status AS status,
  d.tagsJson AS tagsJson,
  d.storedName AS storedName,
  d.ingestStatus AS ingestStatus,
  d.ingestError AS ingestError,
  d.ingestTotalChunks AS ingestTotalChunks,
  d.ingestDoneChunks AS ingestDoneChunks,
  d.ingestStartedAtMs AS ingestStartedAtMs,
  d.ingestFinishedAtMs AS ingestFinishedAtMs,
  d.ingestUpdatedAtMs AS ingestUpdatedAtMs
FROM docs d
LEFT JOIN (
  SELECT substr(sourceId, 1, instr(sourceId, '#') - 1) AS file, COUNT(1) AS chunks
  FROM passages
  WHERE tenant = ? AND project = ? AND instr(sourceId, '#') > 0
  GROUP BY file
) p ON p.file = d.file
WHERE ${where.join(" AND ")}
ORDER BY d.file ASC
LIMIT ?
`
    const rows =
      db.query<
        {
          file: string
          chunks: number
          status: string
          tagsJson: string | null
          storedName: string | null
          ingestStatus: string | null
          ingestError: string | null
          ingestTotalChunks: number | null
          ingestDoneChunks: number | null
          ingestStartedAtMs: number | null
          ingestFinishedAtMs: number | null
          ingestUpdatedAtMs: number | null
        },
        Array<string | number>
      >(sql)
        .all(...params) ?? []
    return rows.map((r) => ({
      file: r.file,
      chunks: r.chunks,
      status: normalizeStatus(r.status),
      tags: parseTags(r.tagsJson),
      storedName: typeof r.storedName === "string" && r.storedName.trim() ? r.storedName.trim() : undefined,
      ingestStatus: normalizeIngestStatus(r.ingestStatus),
      ingestError: typeof r.ingestError === "string" && r.ingestError.trim() ? r.ingestError.trim() : undefined,
      ingestTotalChunks: typeof r.ingestTotalChunks === "number" ? r.ingestTotalChunks : undefined,
      ingestDoneChunks: typeof r.ingestDoneChunks === "number" ? r.ingestDoneChunks : undefined,
      ingestStartedAtMs: typeof r.ingestStartedAtMs === "number" ? r.ingestStartedAtMs : undefined,
      ingestFinishedAtMs: typeof r.ingestFinishedAtMs === "number" ? r.ingestFinishedAtMs : undefined,
      ingestUpdatedAtMs: typeof r.ingestUpdatedAtMs === "number" ? r.ingestUpdatedAtMs : undefined,
    }))
  }

  function getDocStoredNames(input: { tenant: string; project: string; file: string }) {
    const pattern = docPattern(input.file)
    const rows = db
      .query<{ metaJson: string | null }, [string, string, string]>(
        "SELECT metaJson FROM passages WHERE tenant = ? AND project = ? AND sourceId LIKE ? ESCAPE '\\' LIMIT 50",
      )
      .all(input.tenant, input.project, pattern)

    const out = new Set<string>()
    for (const row of rows ?? []) {
      if (!row?.metaJson) continue
      try {
        const parsed = JSON.parse(row.metaJson)
        const stored = (parsed as any)?.stored
        if (typeof stored === "string" && stored.trim()) out.add(stored.trim())
      } catch {
        // ignore
      }
    }
    return [...out]
  }

  function search(input: { tenant: string; project: string; query: string; topK: number; tags?: string[]; onlyApproved?: boolean }) {
    const q = input.query.trim()
    if (!q) return []

    const onlyApproved = input.onlyApproved ?? true

    const tags = Array.from(
      new Set(
        (input.tags ?? [])
          .filter((t) => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ).slice(0, 20)

    const tagSql =
      tags.length > 0
        ? {
            clause: `EXISTS (SELECT 1 FROM json_each(d.tagsJson) WHERE value IN (${tags.map(() => "?").join(",")}))`,
            params: tags,
          }
        : { clause: "1=1", params: [] as string[] }

    const needsDocsJoin = onlyApproved || tags.length > 0

    const stmt = db.query(
      needsDocsJoin
        ? `
SELECT passages.sourceId, passages.text, passages.metaJson, bm25(passages) as rank
FROM passages
LEFT JOIN docs d
  ON d.tenant = passages.tenant
  AND d.project = passages.project
  AND d.file = substr(passages.sourceId, 1, instr(passages.sourceId, '#') - 1)
WHERE passages MATCH ?
  AND passages.tenant = ?
  AND passages.project = ?
  AND (
    instr(passages.sourceId, '#') = 0
    OR (
      ${onlyApproved ? "(d.status = 'approved' OR d.status IS NULL)" : "1=1"}
      AND (${tagSql.clause})
    )
  )
ORDER BY rank ASC
LIMIT ?
`
        : `
SELECT sourceId, text, metaJson, bm25(passages) as rank
FROM passages
WHERE passages MATCH ?
  AND tenant = ?
  AND project = ?
ORDER BY rank ASC
LIMIT ?
`,
    )

    try {
      const params = needsDocsJoin ? [q, input.tenant, input.project, ...tagSql.params, input.topK] : [q, input.tenant, input.project, input.topK]
      return (stmt.all(...(params as any[])) ?? []) as RagPassageRow[]
    } catch {
      const like = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      const likeStmt = db.query(
        needsDocsJoin
          ? `
SELECT passages.sourceId, passages.text, passages.metaJson, 1000 as rank
FROM passages
LEFT JOIN docs d
  ON d.tenant = passages.tenant
  AND d.project = passages.project
  AND d.file = substr(passages.sourceId, 1, instr(passages.sourceId, '#') - 1)
WHERE passages.tenant = ?
  AND passages.project = ?
  AND passages.text LIKE ? ESCAPE '\\'
  AND (
    instr(passages.sourceId, '#') = 0
    OR (
      ${onlyApproved ? "(d.status = 'approved' OR d.status IS NULL)" : "1=1"}
      AND (${tagSql.clause})
    )
  )
ORDER BY passages.sourceId ASC
LIMIT ?
`
          : `
SELECT sourceId, text, metaJson, 1000 as rank
FROM passages
WHERE tenant = ?
  AND project = ?
  AND text LIKE ? ESCAPE '\\'
ORDER BY sourceId ASC
LIMIT ?
`,
      )

      const params = needsDocsJoin ? [input.tenant, input.project, like, ...tagSql.params, input.topK] : [input.tenant, input.project, like, input.topK]
      return (likeStmt.all(...(params as any[])) ?? []) as RagPassageRow[]
    }
  }

  return {
    db,
    close,
    ensureSchema,
    countPassages,
    upsertPassage,
    deleteDoc,
    deleteDocMeta,
    upsertDocMeta,
    getDocMeta,
    getDocInfo,
    updateDocMeta,
    updateDocStoredName,
    queueDocIngest,
    startDocIngest,
    progressDocIngest,
    finishDocIngestSucceeded,
    finishDocIngestFailed,
    listDocs,
    getDocStoredNames,
    search,
  }
}
