import { createHash } from "node:crypto"

export type AuditMode = "off" | "hash" | "full"

type AuditBase = {
  ts: string
  event: string
  sessionID?: string
  tenant?: string
  project?: string
}

export type AuditEntry = AuditBase & Record<string, unknown>

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function redactValue(mode: AuditMode, key: string, value: unknown) {
  if (mode === "full") return { [key]: value }
  if (mode === "off") return {}
  if (typeof value !== "string") return { [key]: value }
  const hash = sha256Hex(value).slice(0, 16)
  return { [`${key}Hash`]: hash, [`${key}Len`]: value.length }
}

export function createAuditLogger(cfg: { mode: AuditMode; onEntry?: (entry: AuditEntry) => void }) {
  const mode = cfg.mode

  return function audit(event: string, fields: Record<string, unknown>) {
    if (mode === "off") return

    const tsMs = Date.now()
    const out: AuditEntry = {
      ts: new Date(tsMs).toISOString(),
      event,
    }

    for (const [k, v] of Object.entries(fields)) {
      if (k === "text" || k === "query" || k === "assistant" || k === "prompt" || k === "sub" || k === "newSub") {
        Object.assign(out, redactValue(mode, k, v))
        continue
      }
      out[k] = v
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out))

    if (typeof cfg.onEntry === "function") {
      try {
        cfg.onEntry(out)
      } catch {
        // ignore
      }
    }
  }
}
