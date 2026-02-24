import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import type { AuditEntry } from "./audit"

type AuditRow = {
  id: number
  ts: number
  dataJson: string
}

export type AuditSearchInput = {
  tenant?: string
  project?: string
  sessionID?: string
  event?: string
  eventPrefix?: string
  assetId?: string
  file?: string
  reason?: string
  sinceMs?: number
  untilMs?: number
  limit: number
  cursor?: number
  order: "desc" | "asc"
}

export type AuditSearchOutput = {
  events: Array<Record<string, unknown>>
  nextCursor?: number
}

export type AuditSessionSummary = {
  sessionID: string
  tenant?: string
  project?: string
  firstTsMs: number
  lastTsMs: number
  lastId: number
  events: number
  lastEvent?: string
}

export type AuditSessionsInput = {
  tenant?: string
  project?: string
  query?: string
  sinceMs?: number
  untilMs?: number
  limit: number
  cursor?: number
  order: "desc" | "asc"
}

export type AuditSessionsOutput = {
  sessions: AuditSessionSummary[]
  nextCursor?: number
}

export type AuditDb = {
  close: () => void
  insert: (entry: AuditEntry) => void
  search: (input: AuditSearchInput) => AuditSearchOutput
  sessions: (input: AuditSessionsInput) => AuditSessionsOutput
}

function safeTsMs(entry: AuditEntry) {
  const parsed = Date.parse(entry.ts)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function escapeLike(input: string) {
  return input.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

export function openAuditDb(opts: { dbPath: string; maxRows: number }): AuditDb {
  if (opts.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true })
  }

  const db = new Database(opts.dbPath)
  db.exec("PRAGMA journal_mode=WAL;")
  db.exec("PRAGMA synchronous=NORMAL;")

 db.exec(`
 CREATE TABLE IF NOT EXISTS audit_events (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   ts INTEGER NOT NULL,
   event TEXT NOT NULL,
   sessionID TEXT,
   tenant TEXT,
   project TEXT,
   assetId TEXT,
   file TEXT,
   reason TEXT,
   dataJson TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
 CREATE INDEX IF NOT EXISTS idx_audit_session_ts ON audit_events(sessionID, ts);
 CREATE INDEX IF NOT EXISTS idx_audit_scope_ts ON audit_events(tenant, project, ts);
 CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit_events(event, ts);
 `)

  const cols = db.query<{ name: string }, []>("PRAGMA table_info(audit_events)").all().map((c) => c.name)
  if (!cols.includes("assetId")) db.exec("ALTER TABLE audit_events ADD COLUMN assetId TEXT;")
  if (!cols.includes("file")) db.exec("ALTER TABLE audit_events ADD COLUMN file TEXT;")
  if (!cols.includes("reason")) db.exec("ALTER TABLE audit_events ADD COLUMN reason TEXT;")
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_assetId_ts ON audit_events(assetId, ts);")
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_file_ts ON audit_events(file, ts);")
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_reason_ts ON audit_events(reason, ts);")

  const insertStmt = db.query<
    unknown,
    [number, string, string | null, string | null, string | null, string | null, string | null, string | null, string]
  >("INSERT INTO audit_events(ts, event, sessionID, tenant, project, assetId, file, reason, dataJson) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")

  const getCutoffStmt = db.query<{ id: number }, [number]>("SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET ?")
  const pruneStmt = db.query<unknown, [number]>("DELETE FROM audit_events WHERE id < ?")

  let insertCount = 0
  function maybePrune() {
    const maxRows = Math.max(1, Math.floor(opts.maxRows))
    if (insertCount % 200 !== 0) return
    const cutoff = getCutoffStmt.get(maxRows - 1)
    if (!cutoff?.id) return
    pruneStmt.run(cutoff.id)
  }

  function insert(entry: AuditEntry) {
    const tsMs = safeTsMs(entry)
    const json = JSON.stringify(entry)
    const assetId = typeof (entry as any)?.assetId === "string" ? String((entry as any).assetId) : null
    const file = typeof (entry as any)?.file === "string" ? String((entry as any).file) : null
    const reasonValue = typeof (entry as any)?.reason === "string" ? String((entry as any).reason) : null
    const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : null
    insertStmt.run(
      tsMs,
      entry.event,
      typeof entry.sessionID === "string" ? entry.sessionID : null,
      typeof entry.tenant === "string" ? entry.tenant : null,
      typeof entry.project === "string" ? entry.project : null,
      assetId,
      file,
      reason,
      json,
    )
    insertCount += 1
    maybePrune()
  }

  function search(input: AuditSearchInput): AuditSearchOutput {
    const where: string[] = []
    const params: Array<string | number> = []

    if (input.tenant) {
      where.push("tenant = ?")
      params.push(input.tenant)
    }
    if (input.project) {
      where.push("project = ?")
      params.push(input.project)
    }
    if (input.sessionID) {
      where.push("sessionID = ?")
      params.push(input.sessionID)
    }
    if (input.event) {
      where.push("event = ?")
      params.push(input.event)
    }
    if (input.eventPrefix) {
      const prefix = input.eventPrefix.trim()
      if (prefix) {
        where.push("event LIKE ? ESCAPE '\\'")
        params.push(`${escapeLike(prefix)}%`)
      }
    }
    if (input.assetId) {
      where.push("assetId = ?")
      params.push(input.assetId)
    }
    if (input.file) {
      where.push("file = ?")
      params.push(input.file)
    }
    if (input.reason) {
      where.push("reason IS NOT NULL AND instr(reason, ?) > 0")
      params.push(input.reason)
    }
    if (typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs)) {
      where.push("ts >= ?")
      params.push(Math.floor(input.sinceMs))
    }
    if (typeof input.untilMs === "number" && Number.isFinite(input.untilMs)) {
      where.push("ts <= ?")
      params.push(Math.floor(input.untilMs))
    }
    if (typeof input.cursor === "number" && Number.isFinite(input.cursor)) {
      where.push(input.order === "asc" ? "id > ?" : "id < ?")
      params.push(Math.floor(input.cursor))
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const orderSql = input.order === "asc" ? "ASC" : "DESC"
    const limit = Math.min(1000, Math.max(1, Math.floor(input.limit)))
    params.push(limit)

    const sql = `SELECT id, ts, dataJson FROM audit_events ${whereSql} ORDER BY id ${orderSql} LIMIT ?`
    const rows =
      db
        .query<AuditRow, Array<string | number>>(sql)
        .all(...params) ?? []

    const events: Array<Record<string, unknown>> = []
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.dataJson)
        if (!parsed || typeof parsed !== "object") continue
        const entry = parsed as Record<string, unknown>
        entry.id = row.id
        entry.tsMs = row.ts
        events.push(entry)
      } catch {
        // ignore
      }
    }

    const last = rows.at(-1)
    const nextCursor = last?.id
    return { events, nextCursor }
  }

  type SessionRow = {
    sessionID: string
    firstTs: number
    lastTs: number
    lastId: number
    events: number
    tenant: string | null
    project: string | null
    lastEvent: string | null
  }

  function sessions(input: AuditSessionsInput): AuditSessionsOutput {
    const where: string[] = ["sessionID IS NOT NULL AND sessionID != ''"]
    const params: Array<string | number> = []

    if (input.tenant) {
      where.push("tenant = ?")
      params.push(input.tenant)
    }
    if (input.project) {
      where.push("project = ?")
      params.push(input.project)
    }
    if (input.query) {
      const q = input.query.trim()
      if (q) {
        where.push("instr(sessionID, ?) > 0")
        params.push(q)
      }
    }
    if (typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs)) {
      where.push("ts >= ?")
      params.push(Math.floor(input.sinceMs))
    }
    if (typeof input.untilMs === "number" && Number.isFinite(input.untilMs)) {
      where.push("ts <= ?")
      params.push(Math.floor(input.untilMs))
    }

    const having: string[] = []
    if (typeof input.cursor === "number" && Number.isFinite(input.cursor)) {
      having.push(input.order === "asc" ? "MAX(id) > ?" : "MAX(id) < ?")
      params.push(Math.floor(input.cursor))
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const havingSql = having.length ? `HAVING ${having.join(" AND ")}` : ""
    const orderSql = input.order === "asc" ? "ASC" : "DESC"
    const limit = Math.min(1000, Math.max(1, Math.floor(input.limit)))
    params.push(limit)

    const sql = `
    SELECT
      s.sessionID AS sessionID,
      s.firstTs AS firstTs,
      s.lastTs AS lastTs,
      s.lastId AS lastId,
      s.events AS events,
      s.tenant AS tenant,
      s.project AS project,
      e.event AS lastEvent
    FROM (
      SELECT
        sessionID,
        MIN(ts) AS firstTs,
        MAX(ts) AS lastTs,
        MAX(id) AS lastId,
        COUNT(*) AS events,
        MIN(tenant) AS tenant,
        MIN(project) AS project
      FROM audit_events
      ${whereSql}
      GROUP BY sessionID
      ${havingSql}
    ) s
    JOIN audit_events e ON e.id = s.lastId
    ORDER BY s.lastId ${orderSql}
    LIMIT ?`

    const rows =
      db
        .query<SessionRow, Array<string | number>>(sql)
        .all(...params) ?? []

    const sessions = rows.map((r) => ({
      sessionID: r.sessionID,
      tenant: r.tenant ?? undefined,
      project: r.project ?? undefined,
      firstTsMs: r.firstTs,
      lastTsMs: r.lastTs,
      lastId: r.lastId,
      events: r.events,
      lastEvent: r.lastEvent ?? undefined,
    }))

    const last = rows.at(-1)
    const nextCursor = last?.lastId
    return { sessions, nextCursor }
  }

  function close() {
    db.close()
  }

  return { close, insert, search, sessions }
}
