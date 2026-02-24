import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs"

export type MediaAssetType = "video" | "slides" | "model"
export type MediaSourceType = "local" | "remote"
export type MediaAssetStatus = "draft" | "approved" | "archived"

export type MediaAssetRow = {
  assetId: string
  tenant: string
  project: string
  type: MediaAssetType
  status: MediaAssetStatus
  title: string | null
  tagsJson: string | null
  sourceType: MediaSourceType
  source: string
  createdAt: number
}

export type MediaDb = {
  db: Database
  close: () => void
  ensureSchema: () => void
  countAssets: () => number
  upsertAsset: (asset: MediaAssetRow) => void
  getAssetById: (assetId: string) => MediaAssetRow | undefined
  deleteAsset: (input: { tenant: string; project: string; assetId: string }) => number
  searchAssets: (input: {
    tenant: string
    project: string
    query: string
    type?: MediaAssetType
    status?: MediaAssetStatus
    tags?: string[]
    topK: number
  }) => Array<Pick<MediaAssetRow, "assetId" | "type" | "status" | "title" | "tagsJson">>
  listAssets: (input: {
    tenant: string
    project: string
    query?: string
    type?: MediaAssetType
    status?: MediaAssetStatus
    tags?: string[]
    limit: number
    cursor?: string
  }) => Array<Pick<MediaAssetRow, "assetId" | "type" | "status" | "title" | "tagsJson" | "sourceType" | "source">>
}

export function openMediaDb(dbPath: string): MediaDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }

  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode=WAL;")
  db.exec("PRAGMA synchronous=NORMAL;")

  function ensureSchema() {
    db.exec(`
CREATE TABLE IF NOT EXISTS assets (
  assetId TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  title TEXT,
  tagsJson TEXT,
  sourceType TEXT NOT NULL,
  source TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
`)

    const cols = db.query<{ name: string }, []>("PRAGMA table_info(assets)").all().map((c) => c.name)
    if (!cols.includes("status")) {
      try {
        db.exec("ALTER TABLE assets ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';")
      } catch {
        // ignore
      }
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_scope ON assets(tenant, project, type);")
    db.exec("CREATE INDEX IF NOT EXISTS idx_assets_scope_status ON assets(tenant, project, status, type, assetId);")
  }

  function close() {
    db.close()
  }

  function countAssets() {
    const row = db.query<{ n: number }, []>("SELECT COUNT(1) AS n FROM assets").get()
    return row?.n ?? 0
  }

  function upsertAsset(asset: MediaAssetRow) {
    db.query(
      `
INSERT INTO assets(assetId, tenant, project, type, status, title, tagsJson, sourceType, source, createdAt)
VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(assetId) DO UPDATE SET
  tenant=excluded.tenant,
  project=excluded.project,
  type=excluded.type,
  status=excluded.status,
  title=excluded.title,
  tagsJson=excluded.tagsJson,
  sourceType=excluded.sourceType,
  source=excluded.source,
  createdAt=excluded.createdAt
`,
    ).run(
      asset.assetId,
      asset.tenant,
      asset.project,
      asset.type,
      asset.status,
      asset.title,
      asset.tagsJson,
      asset.sourceType,
      asset.source,
      asset.createdAt,
    )
  }

  function getAssetById(assetId: string) {
    return db.query<MediaAssetRow, [string]>("SELECT * FROM assets WHERE assetId = ?").get(assetId) ?? undefined
  }

  function deleteAsset(input: { tenant: string; project: string; assetId: string }) {
    const res = db
      .query<unknown, [string, string, string]>("DELETE FROM assets WHERE tenant = ? AND project = ? AND assetId = ?")
      .run(input.tenant, input.project, input.assetId)
    return res.changes ?? 0
  }

  function searchAssets(input: {
    tenant: string
    project: string
    query: string
    type?: MediaAssetType
    status?: MediaAssetStatus
    tags?: string[]
    topK: number
  }) {
    const where: string[] = ["tenant = ?", "project = ?"]
    const params: Array<string | number> = [input.tenant, input.project]

    if (input.type) {
      where.push("type = ?")
      params.push(input.type)
    }
    if (input.status) {
      where.push("status = ?")
      params.push(input.status)
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
      where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(tagsJson, '[]')) WHERE value IN (${tags.map(() => "?").join(",")}))`)
      params.push(...tags)
    }

    const q = input.query.trim()
    const like = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    where.push("(assetId LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR tagsJson LIKE ? ESCAPE '\\')")
    params.push(like, like, like)
    params.push(input.topK)

    return (
      db
        .query<
          Pick<MediaAssetRow, "assetId" | "type" | "status" | "title" | "tagsJson">,
          Array<string | number>
        >(
          `
SELECT assetId, type, status, title, tagsJson
FROM assets
WHERE ${where.join(" AND ")}
ORDER BY assetId ASC
LIMIT ?
`,
        )
        .all(...params) ?? []
    )
  }

  function listAssets(input: {
    tenant: string
    project: string
    query?: string
    type?: MediaAssetType
    status?: MediaAssetStatus
    tags?: string[]
    limit: number
    cursor?: string
  }) {
    const where: string[] = ["tenant = ?", "project = ?"]
    const params: Array<string | number> = [input.tenant, input.project]

    if (input.type) {
      where.push("type = ?")
      params.push(input.type)
    }
    if (input.status) {
      where.push("status = ?")
      params.push(input.status)
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
      where.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(tagsJson, '[]')) WHERE value IN (${tags.map(() => "?").join(",")}))`)
      params.push(...tags)
    }

    const q = (input.query ?? "").trim()
    if (q) {
      const like = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      where.push("(assetId LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR tagsJson LIKE ? ESCAPE '\\')")
      params.push(like, like, like)
    }

    if (input.cursor) {
      where.push("assetId > ?")
      params.push(input.cursor)
    }

    const limit = Math.min(1000, Math.max(1, Math.floor(input.limit)))
    params.push(limit)

    const sql = `
SELECT assetId, type, status, title, tagsJson, sourceType, source
FROM assets
WHERE ${where.join(" AND ")}
ORDER BY assetId ASC
LIMIT ?
`

    return (
      db
        .query<Pick<MediaAssetRow, "assetId" | "type" | "status" | "title" | "tagsJson" | "sourceType" | "source">, Array<string | number>>(sql)
        .all(...params) ?? []
    )
  }

  return { db, close, ensureSchema, countAssets, upsertAsset, getAssetById, deleteAsset, searchAssets, listAssets }
}
