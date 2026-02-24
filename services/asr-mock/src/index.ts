import { Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import { Ws } from "@open-assistant/protocol"
import z from "zod/v4"

const Env = z.object({
  OA_ASR_MOCK_HOST: z.string().default("0.0.0.0"),
  OA_ASR_MOCK_PORT: z.coerce.number().int().positive().default(7002),
})

const env = Env.parse(process.env)

type Conn = {
  sessionID: string
  ws: WSContext
  segment: number
  isActive: boolean
  endTimer?: ReturnType<typeof setTimeout>
  partialTimer?: ReturnType<typeof setInterval>
}

function send(ws: WSContext, msg: Ws.AsrPartial | Ws.AsrFinal) {
  ws.send(JSON.stringify(msg))
}

function clearTimers(conn: Conn) {
  if (conn.endTimer) clearTimeout(conn.endTimer)
  if (conn.partialTimer) clearInterval(conn.partialTimer)
  conn.endTimer = undefined
  conn.partialTimer = undefined
}

function startSegment(conn: Conn) {
  conn.segment += 1
  conn.isActive = true

  const partial: Ws.AsrPartial = { v: 0, type: "asr.partial", sessionID: conn.sessionID, text: "（mock ASR：识别中…）" }
  send(conn.ws, partial)

  conn.partialTimer = setInterval(() => {
    const msg: Ws.AsrPartial = { v: 0, type: "asr.partial", sessionID: conn.sessionID, text: "（mock ASR：识别中…）" }
    send(conn.ws, msg)
  }, 500)
}

function scheduleFinalize(conn: Conn) {
  if (conn.endTimer) clearTimeout(conn.endTimer)
  conn.endTimer = setTimeout(() => {
    clearTimers(conn)
    if (!conn.isActive) return
    conn.isActive = false

    const finalText = `（mock ASR：segment ${conn.segment}）`
    const msg: Ws.AsrFinal = { v: 0, type: "asr.final", sessionID: conn.sessionID, text: finalText }
    send(conn.ws, msg)
  }, 900)
}

const app = new Hono()
app.get("/healthz", (c) => c.json({ ok: true }))
app.get("/readyz", (c) => c.json({ ok: true }))

app.get(
  "/asr",
  upgradeWebSocket((c) => {
    const sessionID = Ws.SessionID.parse(c.req.query("sessionID") ?? "")
    const conn: Conn = { sessionID, ws: undefined as any, segment: 0, isActive: false }

    return {
      onOpen(_event, ws) {
        conn.ws = ws
      },
      onClose() {
        clearTimers(conn)
      },
      onMessage(event) {
        try {
          const raw = JSON.parse(String(event.data))
          const msg = Ws.AudioIn.parse(raw)

          // Any audio frame counts as "speaking" for mock purposes.
          if (!conn.isActive) startSegment(conn)
          scheduleFinalize(conn)

          // Echo back partial occasionally is handled by timer.
          void msg
        } catch {
          // ignore
        }
      },
    }
  }),
)

const server = Bun.serve({
  hostname: env.OA_ASR_MOCK_HOST,
  port: env.OA_ASR_MOCK_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`open-assistant-asr-mock listening on ${server.url}`)
