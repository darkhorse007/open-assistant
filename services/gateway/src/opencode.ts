import z from "zod/v4"

const Health = z.object({
  healthy: z.boolean(),
  version: z.string(),
})

const Session = z.object({
  id: z.string(),
})

export type OpenCodeConfig = {
  baseUrl: string
  directory?: string
  username?: string
  password?: string
}

function authHeader(username?: string, password?: string) {
  if (!password) return
  const user = username ?? "opencode"
  const token = Buffer.from(`${user}:${password}`).toString("base64")
  return `Basic ${token}`
}

function makeUrl(baseUrl: string, path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\//, ""), base)
}

async function request(cfg: OpenCodeConfig, path: string, init?: RequestInit) {
  const url = makeUrl(cfg.baseUrl, path)

  const headers = new Headers(init?.headers)
  const auth = authHeader(cfg.username, cfg.password)
  if (auth) headers.set("authorization", auth)
  if (cfg.directory) headers.set("x-opencode-directory", cfg.directory)

  const res = await fetch(url, {
    ...init,
    headers,
  })

  return res
}

export async function health(cfg: OpenCodeConfig) {
  const res = await request(cfg, "/global/health", { method: "GET" })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode health failed: ${res.status} ${res.statusText} ${text}`)
  }
  const json = await res.json()
  return Health.parse(json)
}

export async function createSession(cfg: OpenCodeConfig, title: string) {
  const res = await request(cfg, "/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode create session failed: ${res.status} ${res.statusText} ${text}`)
  }
  const json = await res.json()
  return Session.parse(json).id
}

export async function abort(cfg: OpenCodeConfig, sessionID: string) {
  const res = await request(cfg, `/session/${encodeURIComponent(sessionID)}/abort`, { method: "POST" })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode abort failed: ${res.status} ${res.statusText} ${text}`)
  }
}

export async function prompt(
  cfg: OpenCodeConfig,
  sessionID: string,
  input: {
    agent?: string
    system?: string
    text: string
    signal?: AbortSignal
  },
) {
  const res = await request(cfg, `/session/${encodeURIComponent(sessionID)}/message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    signal: input.signal,
    body: JSON.stringify({
      agent: input.agent,
      system: input.system,
      parts: [{ type: "text", text: input.text }],
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode prompt failed: ${res.status} ${res.statusText} ${text}`)
  }

  const json = (await res.json()) as unknown
  const partsRaw = typeof json === "object" && json !== null && "parts" in json ? (json as { parts?: unknown }).parts : undefined
  const parts: Array<{ type?: string; text?: string }> = Array.isArray(partsRaw) ? (partsRaw as any[]) : []
  const assistant = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")

  return assistant.trim()
}
