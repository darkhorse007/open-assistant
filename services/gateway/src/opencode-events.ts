import { setTimeout as sleep } from "node:timers/promises"
import z from "zod/v4"
import type { OpenCodeConfig } from "./opencode"

const GlobalEvent = z.object({
  directory: z.string(),
  payload: z.object({
    type: z.string(),
    properties: z.unknown(),
  }),
})

export type GlobalEvent = z.infer<typeof GlobalEvent>

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

async function openEventStream(cfg: OpenCodeConfig, signal: AbortSignal) {
  const url = makeUrl(cfg.baseUrl, "/global/event")

  const headers = new Headers()
  headers.set("accept", "text/event-stream")

  const auth = authHeader(cfg.username, cfg.password)
  if (auth) headers.set("authorization", auth)
  if (cfg.directory) headers.set("x-opencode-directory", cfg.directory)

  const res = await fetch(url, { method: "GET", headers, signal })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`OpenCode event stream failed: ${res.status} ${res.statusText} ${text}`)
  }
  if (!res.body) throw new Error("OpenCode event stream missing body")
  return res.body
}

export async function runGlobalEventLoop(
  cfg: OpenCodeConfig,
  opts: {
    signal: AbortSignal
    onEvent: (event: GlobalEvent) => void
    onError?: (err: unknown) => void
  },
) {
  let backoffMs = 1000

  while (!opts.signal.aborted) {
    try {
      const stream = await openEventStream(cfg, opts.signal)
      backoffMs = 1000

      const reader = stream.getReader()
      const decoder = new TextDecoder()

      let buffer = ""
      let dataLines: string[] = []

      const flush = () => {
        if (!dataLines.length) return
        const raw = dataLines.join("\n")
        dataLines = []
        try {
          const parsed = GlobalEvent.parse(JSON.parse(raw))
          opts.onEvent(parsed)
        } catch {
          // ignore
        }
      }

      while (!opts.signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        while (true) {
          const idx = buffer.indexOf("\n")
          if (idx < 0) break
          let line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)

          if (line.endsWith("\r")) line = line.slice(0, -1)
          if (!line) {
            flush()
            continue
          }
          if (line.startsWith(":")) continue
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart())
          }
        }
      }

      flush()
    } catch (err) {
      if (opts.signal.aborted) break
      opts.onError?.(err)
      await sleep(backoffMs).catch(() => {})
      backoffMs = Math.min(backoffMs * 2, 15_000)
    }
  }
}

