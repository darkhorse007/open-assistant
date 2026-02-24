import { Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import { Ws } from "@open-assistant/protocol"
import z from "zod/v4"

const Env = z.object({
  OA_ASR_HOST: z.string().default("0.0.0.0"),
  OA_ASR_PORT: z.coerce.number().int().positive().default(7002),

  // mock: keep Phase 0 dev flow (no external dependencies)
  // funasr: connect to a FunASR runtime websocket backend
  OA_ASR_BACKEND: z.enum(["mock", "funasr"]).default("funasr"),

  // FunASR runtime websocket server (see modelscope/FunASR runtime docs).
  // Typical default: ws://127.0.0.1:10095
  OA_ASR_FUNASR_URL: z.string().default("ws://127.0.0.1:10095"),
  OA_ASR_FUNASR_MODE: z.enum(["online", "offline", "2pass"]).default("2pass"),
  // Comma-separated numbers: e.g. "5,10,5"
  OA_ASR_FUNASR_CHUNK_SIZE: z.string().default("5,10,5"),
  OA_ASR_FUNASR_CHUNK_INTERVAL: z.coerce.number().int().positive().default(10),
  OA_ASR_FUNASR_ITN: z.coerce.boolean().default(true),
  OA_ASR_FUNASR_FINAL_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  OA_ASR_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  OA_ASR_VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.015),
  OA_ASR_ENDPOINT_HANGOVER_MS: z.coerce.number().int().positive().default(450),
  OA_ASR_PARTIAL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OA_ASR_MAX_SEGMENT_MS: z.coerce.number().int().positive().default(15_000),
})

const env = Env.parse(process.env)

function parseChunkSize(spec: string): [number, number, number] {
  const parts = spec
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
  if (parts.length === 3) return [parts[0]!, parts[1]!, parts[2]!]
  return [5, 10, 5]
}

const funasrChunkSize = parseChunkSize(env.OA_ASR_FUNASR_CHUNK_SIZE)

type Conn = {
  sessionID: string
  ws: WSContext
  lastAudioAt: number
  lastVoiceAt: number
  inSegment: boolean
  segmentStartedAt: number
  segmentSeq: number
  sampleRate: number
  pending: Uint8Array[]
  pendingBytes: number
  partialTimer?: ReturnType<typeof setInterval>
  endpointTimer?: ReturnType<typeof setTimeout>
  running?: AbortController
  backend?: FunASRStream
}

const conns = new Map<string, Conn>()

function nowMs() {
  return Date.now()
}

type ReadyState = { ok: boolean; checkedAt: number; detail?: string }
let lastReady: ReadyState | undefined
let readyInFlight: Promise<ReadyState> | undefined
const READY_CACHE_MS = 5000

async function checkFunAsrReady(): Promise<void> {
  const url = env.OA_ASR_FUNASR_URL
  const timeoutMs = env.OA_ASR_READY_TIMEOUT_MS

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)
    let done = false

    const timeout = setTimeout(() => {
      if (done) return
      done = true
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error("timeout"))
    }, timeoutMs)

    ws.onopen = () => {
      if (done) return
      done = true
      clearTimeout(timeout)

      const init = {
        mode: env.OA_ASR_FUNASR_MODE,
        wav_name: `readyz-${Date.now()}`,
        is_speaking: true,
        wav_format: "pcm",
        audio_fs: 16000,
        chunk_size: funasrChunkSize,
        chunk_interval: env.OA_ASR_FUNASR_CHUNK_INTERVAL,
        itn: env.OA_ASR_FUNASR_ITN,
      }
      try {
        ws.send(JSON.stringify(init))
      } catch {
        // ignore
      }
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve()
    }

    ws.onerror = () => {
      if (done) return
      done = true
      clearTimeout(timeout)
      reject(new Error("connect error"))
    }
  })
}

async function readyStatus(): Promise<ReadyState> {
  const now = Date.now()
  if (lastReady?.ok && now - lastReady.checkedAt < READY_CACHE_MS) return lastReady
  if (readyInFlight) return await readyInFlight

  readyInFlight = (async () => {
    if (env.OA_ASR_BACKEND !== "funasr") return { ok: true, checkedAt: Date.now() }

    try {
      await checkFunAsrReady()
      return { ok: true, checkedAt: Date.now() }
    } catch (err) {
      return { ok: false, checkedAt: Date.now(), detail: err instanceof Error ? err.message : String(err) }
    }
  })()

  try {
    lastReady = await readyInFlight
    return lastReady
  } finally {
    readyInFlight = undefined
  }
}

function bytesFromBase64(b64: string) {
  return Buffer.from(b64, "base64")
}

function rmsPcm16le(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = Math.floor(bytes.byteLength / 2)
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 0x8000
    sum += s * s
  }
  return Math.sqrt(sum / Math.max(1, samples))
}

function clearTimers(conn: Conn) {
  if (conn.partialTimer) clearInterval(conn.partialTimer)
  if (conn.endpointTimer) clearTimeout(conn.endpointTimer)
  conn.partialTimer = undefined
  conn.endpointTimer = undefined
}

function stopSegment(conn: Conn, opts?: { closeBackend?: boolean }) {
  conn.inSegment = false
  conn.segmentStartedAt = 0
  conn.pending = []
  conn.pendingBytes = 0
  clearTimers(conn)

  if (opts?.closeBackend !== false) {
    try {
      conn.backend?.close()
    } catch {
      // ignore
    }
  }
  conn.backend = undefined
}

function send(ws: WSContext, msg: Ws.AsrPartial | Ws.AsrFinal) {
  ws.send(JSON.stringify(msg))
}

async function transcribePcm16leMock(opts: { bytes: Uint8Array; sampleRate: number; seq: number; signal?: AbortSignal }) {
  if (opts.signal?.aborted) return ""
  const ms = Math.round((opts.bytes.byteLength / 2 / Math.max(1, opts.sampleRate)) * 1000)
  return `（ASR mock，占位：segment ${opts.seq}，约 ${ms}ms 音频）`
}

const FunASRResult = z
  .object({
    // examples: "2pass-online", "2pass-offline", "online", "offline"
    mode: z.string().optional(),
    text: z.unknown().optional(),
    is_final: z.boolean().optional(),
  })
  .passthrough()

function funasrTextOf(raw: unknown) {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string").join("")
  return ""
}

function mergeAsrText(prev: string, next: string) {
  const p = prev ?? ""
  const n = next ?? ""
  if (!p) return n
  if (!n) return p
  // Heuristic: supports both "full hypothesis" and "delta append" styles.
  if (n.startsWith(p)) return n
  if (p.startsWith(n)) return p
  return p + n
}

type FunASRMode = z.infer<typeof Env.shape.OA_ASR_FUNASR_MODE>

type FunASRStream = {
  kind: "funasr"
  ready: Promise<void>
  sendAudio: (bytes: Uint8Array) => void
  end: () => void
  waitFinal: (opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<string>
  close: () => void
  getBestText: () => string
}

function connectFunASR(opts: {
  url: string
  mode: FunASRMode
  wavName: string
  sampleRate: number
  onPartial: (text: string) => void
}): FunASRStream {
  const ws = new WebSocket(opts.url)
  try {
    ;(ws as any).binaryType = "arraybuffer"
  } catch {
    // ignore
  }

  const queued: Uint8Array[] = []
  let isOpen = false
  let readyResolved = false
  let resolveReady: (() => void) | undefined

  let online = ""
  let offline = ""
  let lastEmitted = ""

  let finalResolved = false
  let finalResolve: (text: string) => void
  const final = new Promise<string>((resolve) => {
    finalResolve = resolve
  })

  function currentText() {
    return (offline + online).trim()
  }

  function resolveFinal() {
    if (finalResolved) return
    finalResolved = true
    finalResolve(currentText())
  }

  function emitPartial() {
    const cur = currentText()
    if (!cur) return
    if (cur === lastEmitted) return
    lastEmitted = cur
    opts.onPartial(cur)
  }

  const ready = new Promise<void>((resolve) => {
    resolveReady = () => {
      if (readyResolved) return
      readyResolved = true
      resolve()
    }

    ws.onopen = () => {
      isOpen = true
      const init = {
        mode: opts.mode,
        wav_name: opts.wavName,
        is_speaking: true,
        wav_format: "pcm",
        audio_fs: opts.sampleRate,
        chunk_size: funasrChunkSize,
        chunk_interval: env.OA_ASR_FUNASR_CHUNK_INTERVAL,
        itn: env.OA_ASR_FUNASR_ITN,
      }
      try {
        ws.send(JSON.stringify(init))
        for (const b of queued) ws.send(b)
        queued.length = 0
      } catch {
        // ignore
      }
      resolveReady?.()
    }
    ws.onerror = () => {
      resolveReady?.()
      resolveFinal()
      try {
        ws.close()
      } catch {
        // ignore
      }
    }
  })

  ws.onmessage = (event) => {
    const data = String((event as MessageEvent).data ?? "")
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    let msg: z.infer<typeof FunASRResult>
    try {
      msg = FunASRResult.parse(parsed)
    } catch {
      return
    }

    const mode = (msg.mode ?? "").toLowerCase()
    const text = funasrTextOf(msg.text)
    if (!text) return

    if (mode.includes("offline")) {
      offline = mergeAsrText(offline, text)
      online = ""
      emitPartial()
      if (msg.is_final === true && (opts.mode === "offline" || opts.mode === "2pass")) resolveFinal()
      return
    }

    // online / 2pass-online
    online = mergeAsrText(online, text)
    emitPartial()
    if (msg.is_final === true && opts.mode === "online") resolveFinal()
  }

  ws.onclose = () => {
    resolveReady?.()
    resolveFinal()
  }

  return {
    kind: "funasr",
    ready,
    sendAudio(bytes) {
      if (!bytes.byteLength) return
      if (!isOpen) {
        queued.push(bytes)
        return
      }
      try {
        ws.send(bytes)
      } catch {
        // ignore
      }
    },
    end() {
      if (!isOpen) return
      try {
        ws.send(JSON.stringify({ is_speaking: false }))
      } catch {
        // ignore
      }
    },
    async waitFinal({ timeoutMs, signal }) {
      const timeout = new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve(currentText()), timeoutMs)
        if (typeof (t as any)?.unref === "function") (t as any).unref()
      })

      const aborted = new Promise<string>((resolve) => {
        if (!signal) return
        if (signal.aborted) return resolve(currentText())
        const onAbort = () => resolve(currentText())
        signal.addEventListener("abort", onAbort, { once: true })
      })

      try {
        return await Promise.race([final, aborted, timeout])
      } finally {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolveFinal()
    },
    getBestText() {
      return currentText()
    },
  }
}

async function finalizeSegment(conn: Conn) {
  if (!conn.inSegment) return

  const startedAt = conn.segmentStartedAt
  const seq = conn.segmentSeq
  const sampleRate = conn.sampleRate
  const chunks = conn.pending
  const total = conn.pendingBytes
  const backend = conn.backend

  stopSegment(conn, { closeBackend: false })

  if (total <= 0) return
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    bytes.set(c, off)
    off += c.byteLength
  }

  const abort = new AbortController()
  conn.running = abort

  try {
    let text = ""
    if (env.OA_ASR_BACKEND === "funasr" && backend) {
      try {
        await backend.ready
      } catch {
        // ignore
      }
      try {
        backend.end()
        text = await backend.waitFinal({ timeoutMs: env.OA_ASR_FUNASR_FINAL_TIMEOUT_MS, signal: abort.signal })
      } catch {
        text = backend.getBestText()
      }
    }

    if (!text.trim()) {
      text = await transcribePcm16leMock({ bytes, sampleRate, seq, signal: abort.signal }).catch(() => "")
    }

    if (abort.signal.aborted || !text.trim()) return

    send(conn.ws, { v: 0, type: "asr.final", sessionID: conn.sessionID, text })
  } finally {
    if (conn.running === abort) conn.running = undefined
  }

  // Best-effort: log latency for debugging (metrics live in gateway).
  void startedAt
}

function scheduleEndpointCheck(conn: Conn) {
  if (conn.endpointTimer) clearTimeout(conn.endpointTimer)
  conn.endpointTimer = setTimeout(() => {
    conn.endpointTimer = undefined
    if (!conn.inSegment) return
    const now = nowMs()
    if (now - conn.lastVoiceAt >= env.OA_ASR_ENDPOINT_HANGOVER_MS) void finalizeSegment(conn)
  }, env.OA_ASR_ENDPOINT_HANGOVER_MS + 25)
}

function maybeStartSegment(conn: Conn, sampleRate: number) {
  if (conn.inSegment) return
  conn.inSegment = true
  conn.segmentSeq += 1
  conn.segmentStartedAt = nowMs()
  conn.sampleRate = sampleRate
  conn.pending = []
  conn.pendingBytes = 0

  const placeholder = "（识别中…）"
  send(conn.ws, { v: 0, type: "asr.partial", sessionID: conn.sessionID, text: placeholder })

  // If we have a real backend, placeholders are only useful until the first partial lands.
  conn.partialTimer = setInterval(() => {
    if (!conn.inSegment) return
    send(conn.ws, { v: 0, type: "asr.partial", sessionID: conn.sessionID, text: placeholder })
  }, env.OA_ASR_PARTIAL_INTERVAL_MS)

  if (env.OA_ASR_BACKEND !== "funasr") return

  const seg = conn.segmentSeq
  const wavName = `${conn.sessionID}-${seg}`
  conn.backend = connectFunASR({
    url: env.OA_ASR_FUNASR_URL,
    mode: env.OA_ASR_FUNASR_MODE,
    wavName,
    sampleRate,
    onPartial(text) {
      // Drop stale partials if a new segment started while the previous one is still decoding offline.
      if (conn.inSegment && conn.segmentSeq !== seg) return
      if (conn.partialTimer) clearInterval(conn.partialTimer)
      conn.partialTimer = undefined
      send(conn.ws, { v: 0, type: "asr.partial", sessionID: conn.sessionID, text })
    },
  })
}

function pushAudio(conn: Conn, bytes: Uint8Array) {
  conn.pending.push(bytes)
  conn.pendingBytes += bytes.byteLength
}

function onAudio(conn: Conn, msg: Ws.AudioIn) {
  conn.lastAudioAt = nowMs()

  if (msg.format.codec !== "pcm_s16le") return

  const bytes = bytesFromBase64(msg.data)
  if (!bytes.byteLength) return

  const rms = rmsPcm16le(bytes)
  const isVoice = rms >= env.OA_ASR_VAD_THRESHOLD
  if (isVoice) conn.lastVoiceAt = nowMs()

  // Segment guard: if a segment runs too long, force finalize.
  if (conn.inSegment && nowMs() - conn.segmentStartedAt >= env.OA_ASR_MAX_SEGMENT_MS) {
    void finalizeSegment(conn)
    return
  }

  if (isVoice) maybeStartSegment(conn, msg.format.sampleRate)
  if (conn.inSegment) {
    pushAudio(conn, bytes)
    conn.backend?.sendAudio(bytes)
    scheduleEndpointCheck(conn)
  }
}

function cancel(sessionID: string) {
  const conn = conns.get(sessionID)
  if (!conn) return false
  try {
    conn.running?.abort()
  } catch {
    // ignore
  }
  conn.running = undefined
  stopSegment(conn)
  return true
}

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))

app.get("/readyz", async (c) => {
  const status = await readyStatus()
  return c.json(
    { ok: status.ok, backend: env.OA_ASR_BACKEND, detail: status.detail },
    status.ok ? 200 : 503,
  )
})

app.post("/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as unknown
  const sessionID = z.object({ sessionID: Ws.SessionID }).parse(body).sessionID
  const ok = cancel(sessionID)
  return c.json({ ok })
})

app.get(
  "/asr",
  upgradeWebSocket((c) => {
    const sessionID = Ws.SessionID.parse(c.req.query("sessionID") ?? "")
    const conn: Conn = {
      sessionID,
      ws: undefined as any,
      lastAudioAt: 0,
      lastVoiceAt: 0,
      inSegment: false,
      segmentStartedAt: 0,
      segmentSeq: 0,
      sampleRate: 16000,
      pending: [],
      pendingBytes: 0,
    }

    return {
      onOpen(_event, ws) {
        conn.ws = ws
        conns.set(sessionID, conn)
      },
      onClose() {
        cancel(sessionID)
        conns.delete(sessionID)
      },
      onMessage(event) {
        try {
          const raw = JSON.parse(String(event.data))
          const msg = Ws.AudioIn.parse(raw)
          onAudio(conn, msg)
        } catch {
          // ignore
        }
      },
    }
  }),
)

const server = Bun.serve({
  hostname: env.OA_ASR_HOST,
  port: env.OA_ASR_PORT,
  fetch: app.fetch,
  websocket,
})

console.log(`open-assistant-asr listening on ${server.url}`)
