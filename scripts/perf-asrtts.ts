import { setTimeout as sleep } from "node:timers/promises"
import { Ws } from "@open-assistant/protocol"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { collectPerfMeta, sanitizeRunId } from "./perf-meta"

type TurnResult = {
  sessionID: string
  turn: number
  audioMs: number
  asrFinalMs?: number
  asrText?: string
  ttsTextMs?: number
  firstAudioMs?: number
  alignFirstMs?: number
  alignMsgCount?: number
  alignSegCount?: number
  ttsSegments?: number
  alignBoundSegments?: number
  alignMissingSegments?: number
  alignRatios?: number[]
  interruptMs?: number
  totalMs?: number
  status: "completed" | "interrupted" | "error"
  error?: string
}

type AudioFrames = {
  sampleRate: number
  frameMs: number
  frames: string[]
  audioMs: number
}

function pctl(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

function readEnvNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (typeof raw !== "string") return
  const s = raw.trim()
  if (!s) return
  const n = Number(s)
  if (!Number.isFinite(n)) return
  return n
}

function readEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (typeof raw !== "string") return defaultValue
  const s = raw.trim().toLowerCase()
  if (!s) return defaultValue
  return !(s === "0" || s === "false" || s === "no" || s === "off")
}

function now() {
  return performance.now()
}

function ensureDir(dir: string) {
  try {
    Bun.mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
}

async function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath))
  await Bun.write(filePath, JSON.stringify(data, null, 2)).catch(() => {})
}

function base64FromBytes(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function bytesFromBase64(b64: string) {
  return Buffer.from(b64, "base64")
}

function bytesLenFromBase64String(b64: string) {
  const s = b64.trim()
  const len = s.length
  if (len === 0) return 0
  let padding = 0
  if (s.endsWith("==")) padding = 2
  else if (s.endsWith("=")) padding = 1
  return Math.max(0, Math.floor((len * 3) / 4) - padding)
}

type SlaConfig = {
  enabled: boolean
  requireAlign: boolean
  maxErrorRate: number
  p95AsrFinalMs?: number
  p95TtsTextMs?: number
  p95FirstAudioMs?: number
  p95FirstAlignMs?: number
  p95TurnTotalMs?: number
  p95InterruptMs?: number
  alignRatioP50Min?: number
  alignRatioP50Max?: number
  alignRatioP95Min?: number
  alignRatioP95Max?: number
  maxAlignMissingSegments?: number
}

type SlaResult = {
  enabled: boolean
  ok: boolean
  failures: string[]
  config: SlaConfig
}

function alignEven(n: number) {
  const x = Math.max(2, Math.floor(n))
  return x - (x % 2)
}

function int16FromBytesLE(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

function bytesFromInt16LE(samples: Int16Array) {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true)
  return out
}

function resamplePcm16leLinear(opts: { bytes: Uint8Array; inSampleRate: number; outSampleRate: number }) {
  const inSr = Math.max(1, Math.floor(opts.inSampleRate))
  const outSr = Math.max(1, Math.floor(opts.outSampleRate))
  if (inSr === outSr) return opts.bytes

  const input = int16FromBytesLE(opts.bytes)
  const ratio = inSr / outSr
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Int16Array(outLen)

  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = input[Math.min(Math.max(0, idx), input.length - 1)] ?? 0
    const b = input[Math.min(Math.max(0, idx + 1), input.length - 1)] ?? a
    out[i] = Math.round(a + (b - a) * frac)
  }

  return bytesFromInt16LE(out)
}

type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; formatTag: number; data: Uint8Array }

function parseWavPcm16le(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const readFourCC = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3))

  if (bytes.byteLength < 44) throw new Error("wav too small")
  if (readFourCC(0) !== "RIFF") throw new Error("not RIFF")
  if (readFourCC(8) !== "WAVE") throw new Error("not WAVE")

  let fmt: { formatTag: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined
  let data: Uint8Array | undefined

  let off = 12
  while (off + 8 <= bytes.byteLength) {
    const id = readFourCC(off)
    const size = view.getUint32(off + 4, true)
    const start = off + 8
    const end = Math.min(bytes.byteLength, start + size)
    if (id === "fmt " && end - start >= 16) {
      const formatTag = view.getUint16(start + 0, true)
      const channels = view.getUint16(start + 2, true)
      const sampleRate = view.getUint32(start + 4, true)
      const bitsPerSample = view.getUint16(start + 14, true)
      fmt = { formatTag, channels, sampleRate, bitsPerSample }
    } else if (id === "data") {
      data = bytes.subarray(start, end)
    }

    off = start + size + (size % 2)
  }

  if (!fmt) throw new Error("wav missing fmt chunk")
  if (!data) throw new Error("wav missing data chunk")
  if (fmt.formatTag !== 1) throw new Error(`wav format not PCM: ${fmt.formatTag}`)
  if (fmt.bitsPerSample !== 16) throw new Error(`wav bitsPerSample not 16: ${fmt.bitsPerSample}`)
  if (fmt.channels !== 1) throw new Error(`wav channels not 1: ${fmt.channels}`)
  if (data.byteLength < 2) throw new Error("wav data empty")
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, formatTag: fmt.formatTag, data }
}

async function loadAudioFrames(): Promise<AudioFrames> {
  const targetSr = Number(process.env.OA_PERF_AUDIO_SAMPLE_RATE ?? "16000")
  const frameMs = Number(process.env.OA_PERF_AUDIO_FRAME_MS ?? "64")
  const audioText = process.env.OA_PERF_AUDIO_TEXT ?? "你好。"

  let bytes: Uint8Array | undefined
  let sampleRate: number | undefined

  const b64 = (process.env.OA_PERF_AUDIO_B64 ?? "").trim()
  if (b64) {
    bytes = bytesFromBase64(b64)
    sampleRate = Number(process.env.OA_PERF_AUDIO_B64_SAMPLE_RATE ?? String(targetSr))
  }

  const file = (process.env.OA_PERF_AUDIO_FILE ?? "").trim()
  if (!bytes && file) {
    const buf = new Uint8Array(await Bun.file(file).arrayBuffer())
    const ext = path.extname(file).toLowerCase()
    if (ext === ".wav") {
      const wav = parseWavPcm16le(buf)
      bytes = wav.data
      sampleRate = wav.sampleRate
    } else {
      bytes = buf
      sampleRate = Number(process.env.OA_PERF_AUDIO_FILE_SAMPLE_RATE ?? String(targetSr))
    }
  }

  if (!bytes) {
    const ttsBaseUrl = process.env.OA_PERF_TTS_BASE_URL ?? "http://127.0.0.1:7003"
    const url = new URL("/synthesize", ttsBaseUrl)
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: audioText }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Failed to synthesize sample audio: ${res.status} ${res.statusText} ${text}`)
    }
    const json = (await res.json().catch(() => ({}))) as any
    const chunks: any[] = Array.isArray(json?.chunks) ? json.chunks : []
    const out: Uint8Array[] = []
    for (const c of chunks) {
      if (!c?.data || typeof c.data !== "string") continue
      out.push(bytesFromBase64(c.data))
      if (!sampleRate && typeof c.sampleRate === "number") sampleRate = c.sampleRate
    }
    bytes = Buffer.concat(out.map((b) => Buffer.from(b)))
  }

  const inSr = Number(sampleRate ?? targetSr)
  const pcmBytes = resamplePcm16leLinear({ bytes, inSampleRate: inSr, outSampleRate: targetSr })
  const audioMs = (pcmBytes.byteLength / 2 / Math.max(1, targetSr)) * 1000
  const frameBytes = alignEven(Math.round((Math.max(1, frameMs) * targetSr * 2) / 1000))

  const frames: string[] = []
  for (let off = 0; off < pcmBytes.byteLength; off += frameBytes) {
    const slice = pcmBytes.subarray(off, Math.min(pcmBytes.byteLength, off + frameBytes))
    if (!slice.byteLength) continue
    frames.push(base64FromBytes(slice))
  }

  if (frames.length === 0) throw new Error("audio frames empty")
  return { sampleRate: targetSr, frameMs: Math.max(1, frameMs), frames, audioMs }
}

async function checkGatewayReady() {
  const readyUrl = process.env.OA_PERF_READY_URL ?? "http://127.0.0.1:7001/readyz"
  const timeoutMs = Number(process.env.OA_PERF_READY_TIMEOUT_MS ?? "120000")
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(readyUrl)
      const json = (await res.json().catch(() => ({}))) as any
      if (res.ok && json?.ok === true) return
    } catch {
      // ignore
    }
    await sleep(500)
  }

  throw new Error(`Timed out waiting for readyz: ${readyUrl}`)
}

async function runOneSession(opts: {
  wsUrl: string
  sessionID: string
  turns: number
  delayMs: number
  turnTimeoutMs: number
  idleCloseMs: number
  frames: AudioFrames
  realtime: boolean
  interruptProb: number
  interruptDelayMs: number
}) {
  return await new Promise<TurnResult[]>((resolve, reject) => {
    const results: TurnResult[] = []
    const url = new URL(opts.wsUrl)
    url.searchParams.set("sessionID", opts.sessionID)
    const ws = new WebSocket(url.toString())

    let audioSeq = 0
    let currentTurn = 0
    let turnStartedAt = 0
    let lastState: Ws.StateValue = "idle"
    let initialStartTimer: ReturnType<typeof setTimeout> | undefined
    let asrFinalAt: number | undefined
    let asrText: string | undefined
    let ttsTextAt: number | undefined
    let firstAudioAt: number | undefined
    let shouldInterrupt = false
    let interruptSentAt: number | undefined
    let interruptDoneAt: number | undefined
    let interruptTimer: ReturnType<typeof setTimeout> | undefined
    let turnRecorded = false

    type SegmentStats = {
      id: string
      audioBytes: number
      sampleRate?: number
      mime?: string
      alignEstimatedMs?: number
    }
    let segmentStats = new Map<string, SegmentStats>()
    let alignFirstAt: number | undefined
    let alignMsgCount = 0
    let alignSegCount = 0

    let turnAbort: AbortController | undefined

    const stopTurnTimers = () => {
      if (turnTimeout) clearTimeout(turnTimeout)
      turnTimeout = undefined
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined
    }

    const closeWs = () => {
      try {
        ws.close()
      } catch {
        // ignore
      }
    }

    const stopInitialStartTimer = () => {
      if (initialStartTimer) clearTimeout(initialStartTimer)
      initialStartTimer = undefined
    }

    const alignSummary = () => {
      const segs = [...segmentStats.values()]
      const ttsSegments = segs.filter((s) => s.audioBytes > 0).length

      const ratios: number[] = []
      let alignBoundSegments = 0
      let alignMissingSegments = 0

      for (const s of segs) {
        if (s.audioBytes <= 0 || !s.sampleRate) continue
        const isPcm = (s.mime ?? "").toLowerCase().includes("pcm")
        const audioMs = isPcm ? (s.audioBytes / 2 / Math.max(1, s.sampleRate)) * 1000 : undefined
        const alignMs = s.alignEstimatedMs ?? 0

        if (alignMs > 0 && audioMs !== undefined) {
          alignBoundSegments += 1
          ratios.push(audioMs / alignMs)
        } else if (alignMs <= 0) {
          alignMissingSegments += 1
        }
      }

      return { ttsSegments, alignBoundSegments, alignMissingSegments, ratios }
    }

    const recordError = (err: string) => {
      if (turnRecorded) return
      turnRecorded = true
      stopTurnTimers()
      const align = alignSummary()
      results.push({
        sessionID: opts.sessionID,
        turn: currentTurn,
        audioMs: opts.frames.audioMs,
        asrFinalMs: asrFinalAt,
        asrText,
        ttsTextMs: ttsTextAt,
        firstAudioMs: firstAudioAt,
        alignFirstMs: alignFirstAt,
        alignMsgCount,
        alignSegCount,
        ttsSegments: align.ttsSegments,
        alignBoundSegments: align.alignBoundSegments,
        alignMissingSegments: align.alignMissingSegments,
        alignRatios: align.ratios,
        totalMs: now() - turnStartedAt,
        status: "error",
        error: err,
      })
      closeWs()
    }

    const finishTurnIfReady = () => {
      if (currentTurn <= 0) return
      if (turnRecorded) return
      const elapsed = now() - turnStartedAt

      if (interruptSentAt !== undefined) {
        if (interruptDoneAt === undefined) return

        turnRecorded = true
        stopTurnTimers()
        const align = alignSummary()
        results.push({
          sessionID: opts.sessionID,
          turn: currentTurn,
          audioMs: opts.frames.audioMs,
          asrFinalMs: asrFinalAt,
          asrText,
          ttsTextMs: ttsTextAt,
          firstAudioMs: firstAudioAt,
          alignFirstMs: alignFirstAt,
          alignMsgCount,
          alignSegCount,
          ttsSegments: align.ttsSegments,
          alignBoundSegments: align.alignBoundSegments,
          alignMissingSegments: align.alignMissingSegments,
          alignRatios: align.ratios,
          interruptMs: interruptDoneAt - interruptSentAt,
          totalMs: elapsed,
          status: "interrupted",
        })
      } else {
        if (lastState !== "listening") return
        if (asrFinalAt === undefined) return
        if (ttsTextAt === undefined) return
        if (firstAudioAt === undefined) return

        turnRecorded = true
        stopTurnTimers()
        const align = alignSummary()
        results.push({
          sessionID: opts.sessionID,
          turn: currentTurn,
          audioMs: opts.frames.audioMs,
          asrFinalMs: asrFinalAt,
          asrText,
          ttsTextMs: ttsTextAt,
          firstAudioMs: firstAudioAt,
          alignFirstMs: alignFirstAt,
          alignMsgCount,
          alignSegCount,
          ttsSegments: align.ttsSegments,
          alignBoundSegments: align.alignBoundSegments,
          alignMissingSegments: align.alignMissingSegments,
          alignRatios: align.ratios,
          totalMs: elapsed,
          status: "completed",
        })
      }

      if (currentTurn >= opts.turns) {
        closeWs()
        return
      }

      void sleep(opts.delayMs).then(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        startTurn()
      })
    }

    const sendInterrupt = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (interruptSentAt !== undefined) return
      interruptSentAt = now()
      const msg: Ws.Interrupt = { v: 0, type: "interrupt", sessionID: opts.sessionID, reason: "button" }
      ws.send(JSON.stringify(msg))
    }

    const streamAudio = async (signal: AbortSignal) => {
      // Send a fixed utterance (pcm16le @ target sampleRate) as real-time frames.
      const base = opts.frames
      for (const b64 of base.frames) {
        if (signal.aborted) return
        if (ws.readyState !== WebSocket.OPEN) return
        const msg: Ws.AudioIn = {
          v: 0,
          type: "audio.in",
          sessionID: opts.sessionID,
          seq: audioSeq++,
          format: { codec: "pcm_s16le", sampleRate: base.sampleRate, channels: 1 },
          data: b64,
        }
        try {
          ws.send(JSON.stringify(msg))
        } catch {
          return
        }
        if (opts.realtime) await sleep(base.frameMs)
      }
    }

    const startTurn = () => {
      currentTurn += 1
      asrFinalAt = undefined
      asrText = undefined
      ttsTextAt = undefined
      firstAudioAt = undefined
      segmentStats = new Map()
      alignFirstAt = undefined
      alignMsgCount = 0
      alignSegCount = 0
      shouldInterrupt = Math.random() < opts.interruptProb
      interruptSentAt = undefined
      interruptDoneAt = undefined
      turnRecorded = false
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined

      if (turnAbort) {
        try {
          turnAbort.abort()
        } catch {
          // ignore
        }
      }
      turnAbort = new AbortController()

      turnStartedAt = now()
      armTurnTimeout()
      void streamAudio(turnAbort.signal).catch(() => {})
    }

    const timeout = setTimeout(() => {
      closeWs()
      reject(new Error(`Timed out: ${opts.sessionID}`))
    }, Math.max(5_000, opts.turns > 0 ? opts.turnTimeoutMs * Math.max(1, opts.turns) + 10_000 : opts.idleCloseMs + 2000))

    let turnTimeout: ReturnType<typeof setTimeout> | undefined
    const armTurnTimeout = () => {
      if (turnTimeout) clearTimeout(turnTimeout)
      turnTimeout = setTimeout(() => recordError("turn_timeout"), opts.turnTimeoutMs)
    }

    ws.onopen = () => {
      if (opts.turns <= 0) {
        setTimeout(closeWs, Math.max(500, opts.idleCloseMs))
        return
      }

      // The utterance we stream by default is short. If we start streaming immediately on `open`,
      // Gateway may still be transitioning into `listening`, and the whole utterance can be dropped
      // (leading to turn timeouts). Prefer waiting for the first `state=listening` before starting.
      initialStartTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (currentTurn > 0) return
        startTurn()
      }, 5_000)
    }

    ws.onmessage = (event) => {
      try {
        const msg = Ws.GatewayToClient.parse(JSON.parse(String(event.data)))
        if (msg.type === "state") {
          lastState = msg.state
          if (currentTurn === 0 && lastState === "listening") {
            stopInitialStartTimer()
            startTurn()
            return
          }
          if (lastState === "speaking" && shouldInterrupt && interruptSentAt === undefined && !interruptTimer) {
            interruptTimer = setTimeout(sendInterrupt, Math.max(0, opts.interruptDelayMs))
          }
          if (interruptSentAt !== undefined && lastState === "listening" && interruptDoneAt === undefined) {
            interruptDoneAt = now()
          }
          finishTurnIfReady()
        } else if (msg.type === "asr.final") {
          if (asrFinalAt === undefined) asrFinalAt = now() - turnStartedAt
          asrText = typeof msg.text === "string" ? msg.text.slice(0, 200) : undefined
          finishTurnIfReady()
        } else if (msg.type === "tts.text" && msg.final) {
          if (ttsTextAt === undefined) ttsTextAt = now() - turnStartedAt
          if (shouldInterrupt && interruptSentAt === undefined && !interruptTimer) {
            interruptTimer = setTimeout(sendInterrupt, Math.max(0, opts.interruptDelayMs))
          }
          finishTurnIfReady()
        } else if (msg.type === "tts.audio") {
          if (firstAudioAt === undefined) firstAudioAt = now() - turnStartedAt
          const segmentId = msg.segmentId ?? "seg:unknown"
          let seg = segmentStats.get(segmentId)
          if (!seg) {
            seg = { id: segmentId, audioBytes: 0 }
            segmentStats.set(segmentId, seg)
          }
          if (!seg.sampleRate && typeof msg.sampleRate === "number") seg.sampleRate = msg.sampleRate
          if (!seg.mime && typeof msg.mime === "string") seg.mime = msg.mime
          if (typeof msg.data === "string") seg.audioBytes += bytesLenFromBase64String(msg.data)
        } else if (msg.type === "tts.align") {
          if (alignFirstAt === undefined) alignFirstAt = now() - turnStartedAt
          alignMsgCount += 1
          const segs = Array.isArray(msg.segments) ? msg.segments : []
          alignSegCount += segs.length
          const segmentId = msg.segmentId ?? "seg:unknown"
          let seg = segmentStats.get(segmentId)
          if (!seg) {
            seg = { id: segmentId, audioBytes: 0 }
            segmentStats.set(segmentId, seg)
          }
          let est = 0
          for (const s of segs) est = Math.max(est, typeof s.endMs === "number" ? s.endMs : 0)
          if (est > 0) seg.alignEstimatedMs = Math.max(seg.alignEstimatedMs ?? 0, est)
        } else if (msg.type === "ui.stop") {
          if (interruptSentAt !== undefined && interruptDoneAt === undefined) {
            interruptDoneAt = now()
            finishTurnIfReady()
          } else if (!turnRecorded && currentTurn > 0 && (msg.target === undefined || msg.target === "tts" || msg.target === "all")) {
            recordError("ui_stop")
          }
        }
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      clearTimeout(timeout)
      stopInitialStartTimer()
      stopTurnTimers()
      if (turnAbort) {
        try {
          turnAbort.abort()
        } catch {
          // ignore
        }
      }
      resolve(results)
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      stopInitialStartTimer()
      stopTurnTimers()
      if (turnAbort) {
        try {
          turnAbort.abort()
        } catch {
          // ignore
        }
      }
      reject(new Error(`WebSocket error: ${opts.sessionID}`))
    }
  })
}

async function main() {
  const runId = sanitizeRunId(process.env.OA_PERF_RUN_ID ?? String(Date.now()))
  const ROOT = fileURLToPath(new URL("..", import.meta.url))
  const wsUrl = process.env.OA_PERF_GATEWAY_WS_URL ?? "ws://127.0.0.1:7001/ws"
  const sessions = Number(process.env.OA_PERF_SESSIONS ?? "10")
  const turnsPerSession = Number(process.env.OA_PERF_TURNS_PER_SESSION ?? "3")
  const delayMs = Number(process.env.OA_PERF_DELAY_MS ?? "400")
  const speakRatio = Number(process.env.OA_PERF_SPEAK_RATIO ?? "1.0")
  const interruptProb = Number(process.env.OA_PERF_INTERRUPT_PROB ?? "0.0")
  const interruptDelayMs = Number(process.env.OA_PERF_INTERRUPT_DELAY_MS ?? "250")
  const turnTimeoutMs = Number(process.env.OA_PERF_TURN_TIMEOUT_MS ?? "300000")
  const realtime = (process.env.OA_PERF_AUDIO_REALTIME ?? "1").trim() !== "0"

  await checkGatewayReady()
  const frames = await loadAudioFrames()

  // eslint-disable-next-line no-console
  console.log(
    `Perf(ASR+TTS): runId=${runId} sessions=${sessions} turnsPerSession=${turnsPerSession} audioMs=${Math.round(frames.audioMs)} frameMs=${
      frames.frameMs
    } realtime=${realtime ? "1" : "0"} interruptProb=${interruptProb.toFixed(2)} ws=${wsUrl}`,
  )

  const runners: Promise<TurnResult[]>[] = []
  for (let i = 0; i < sessions; i++) {
    const sessionID = `perf-asrtts-${Date.now()}-${i}`
    const active = Math.random() < Math.max(0, Math.min(1, speakRatio))
    const idleCloseMs = Math.min(
      60_000,
      Math.max(2000, turnsPerSession * Math.max(1000, turnTimeoutMs) + Math.max(0, turnsPerSession - 1) * delayMs),
    )
    runners.push(
      runOneSession({
        wsUrl,
        sessionID,
        turns: active ? turnsPerSession : 0,
        delayMs,
        turnTimeoutMs,
        idleCloseMs,
        frames,
        realtime,
        interruptProb: Math.max(0, Math.min(1, interruptProb)),
        interruptDelayMs: Math.max(0, interruptDelayMs),
      }).catch((err) => [
        {
          sessionID,
          turn: 0,
          audioMs: frames.audioMs,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        } satisfies TurnResult,
      ]),
    )
  }

  const all: TurnResult[] = []
  const results = await Promise.all(runners)
  for (const r of results) all.push(...r)

  const completed = all.filter((r) => r.status === "completed")
  const interrupted = all.filter((r) => r.status === "interrupted")
  const errors = all.filter((r) => r.status === "error")

  const asrFinal = all.map((r) => r.asrFinalMs ?? 0).filter((n) => n > 0)
  const ttsText = completed.map((r) => r.ttsTextMs ?? 0).filter((n) => n > 0)
  const firstAudio = completed.map((r) => r.firstAudioMs ?? 0).filter((n) => n > 0)
  const alignFirst = completed.map((r) => r.alignFirstMs ?? 0).filter((n) => n > 0)
  const alignRatios = completed.flatMap((r) => r.alignRatios ?? []).filter((n) => n > 0)
  const ttsSegmentsTotal = completed.reduce((sum, r) => sum + (r.ttsSegments ?? 0), 0)
  const alignBoundSegmentsTotal = completed.reduce((sum, r) => sum + (r.alignBoundSegments ?? 0), 0)
  const alignMissingSegmentsTotal = completed.reduce((sum, r) => sum + (r.alignMissingSegments ?? 0), 0)
  const total = completed.map((r) => r.totalMs ?? 0).filter((n) => n > 0)
  const interruptMs = interrupted.map((r) => r.interruptMs ?? 0).filter((n) => n > 0)

  // eslint-disable-next-line no-console
  console.log(`Turns: ${all.length}`)
  // eslint-disable-next-line no-console
  console.log(
    `completed: ${completed.length} interrupted: ${interrupted.length} errors: ${errors.length} errorRate=${(
      (errors.length / Math.max(1, all.length)) *
      100
    ).toFixed(1)}%`,
  )
  // eslint-disable-next-line no-console
  console.log(`asr.final ms: p50=${pctl(asrFinal, 50).toFixed(0)} p95=${pctl(asrFinal, 95).toFixed(0)} (n=${asrFinal.length})`)
  // eslint-disable-next-line no-console
  console.log(`tts.text final ms: p50=${pctl(ttsText, 50).toFixed(0)} p95=${pctl(ttsText, 95).toFixed(0)} (n=${ttsText.length})`)
  // eslint-disable-next-line no-console
  console.log(
    `first tts.audio ms: p50=${pctl(firstAudio, 50).toFixed(0)} p95=${pctl(firstAudio, 95).toFixed(0)} (n=${firstAudio.length})`,
  )
  // eslint-disable-next-line no-console
  console.log(
    `first tts.align ms: p50=${pctl(alignFirst, 50).toFixed(0)} p95=${pctl(alignFirst, 95).toFixed(0)} (n=${alignFirst.length})`,
  )
  // eslint-disable-next-line no-console
  console.log(
    `align ratio (audioMs/alignMs): p50=${pctl(alignRatios, 50).toFixed(3)} p95=${pctl(alignRatios, 95).toFixed(3)} (n=${alignRatios.length})`,
  )
  // eslint-disable-next-line no-console
  console.log(`turn total ms: p50=${pctl(total, 50).toFixed(0)} p95=${pctl(total, 95).toFixed(0)} (n=${total.length})`)
  // eslint-disable-next-line no-console
  console.log(`interrupt ms: p50=${pctl(interruptMs, 50).toFixed(0)} p95=${pctl(interruptMs, 95).toFixed(0)} (n=${interruptMs.length})`)

  const slaConfig: SlaConfig = {
    enabled: readEnvBool("OA_PERF_ASSERT", false),
    requireAlign: readEnvBool("OA_PERF_REQUIRE_ALIGN", false),
    maxErrorRate: readEnvNumber("OA_PERF_MAX_ERROR_RATE") ?? 0,
    p95AsrFinalMs: readEnvNumber("OA_PERF_P95_ASR_FINAL_MS"),
    p95TtsTextMs: readEnvNumber("OA_PERF_P95_TTS_TEXT_MS"),
    p95FirstAudioMs: readEnvNumber("OA_PERF_P95_FIRST_AUDIO_MS"),
    p95FirstAlignMs: readEnvNumber("OA_PERF_P95_FIRST_ALIGN_MS"),
    p95TurnTotalMs: readEnvNumber("OA_PERF_P95_TURN_TOTAL_MS"),
    p95InterruptMs: readEnvNumber("OA_PERF_P95_INTERRUPT_MS"),
    alignRatioP50Min: readEnvNumber("OA_PERF_ALIGN_RATIO_P50_MIN"),
    alignRatioP50Max: readEnvNumber("OA_PERF_ALIGN_RATIO_P50_MAX"),
    alignRatioP95Min: readEnvNumber("OA_PERF_ALIGN_RATIO_P95_MIN"),
    alignRatioP95Max: readEnvNumber("OA_PERF_ALIGN_RATIO_P95_MAX"),
    maxAlignMissingSegments: readEnvNumber("OA_PERF_MAX_ALIGN_MISSING_SEGMENTS"),
  }

  const sla: SlaResult = (() => {
    const failures: string[] = []
    if (!slaConfig.enabled) return { enabled: false, ok: true, failures, config: slaConfig }

    const errorRate = errors.length / Math.max(1, all.length)
    if (errorRate > slaConfig.maxErrorRate) {
      failures.push(`errorRate ${errorRate.toFixed(4)} > ${slaConfig.maxErrorRate.toFixed(4)}`)
    }

    const checkP95 = (name: string, values: number[], limit: number | undefined) => {
      if (limit === undefined) return
      if (values.length === 0) return failures.push(`${name}.p95 missing (n=0), expected <= ${limit}`)
      const v = pctl(values, 95)
      if (v > limit) failures.push(`${name}.p95 ${v.toFixed(0)}ms > ${limit.toFixed(0)}ms`)
    }

    checkP95("asr.final", asrFinal, slaConfig.p95AsrFinalMs)
    checkP95("tts.text", ttsText, slaConfig.p95TtsTextMs)
    checkP95("tts.audio.first", firstAudio, slaConfig.p95FirstAudioMs)
    checkP95("tts.align.first", alignFirst, slaConfig.p95FirstAlignMs)
    checkP95("turn.total", total, slaConfig.p95TurnTotalMs)
    checkP95("interrupt", interruptMs, slaConfig.p95InterruptMs)

    if (slaConfig.maxAlignMissingSegments !== undefined) {
      if (alignMissingSegmentsTotal > slaConfig.maxAlignMissingSegments) {
        failures.push(
          `alignMissingSegments ${alignMissingSegmentsTotal} > ${Math.floor(slaConfig.maxAlignMissingSegments)}`,
        )
      }
    }

    const ratioP50 = pctl(alignRatios, 50)
    const ratioP95 = pctl(alignRatios, 95)

    if (slaConfig.alignRatioP50Min !== undefined && ratioP50 < slaConfig.alignRatioP50Min) {
      failures.push(`alignRatio.p50 ${ratioP50.toFixed(3)} < ${slaConfig.alignRatioP50Min.toFixed(3)}`)
    }
    if (slaConfig.alignRatioP50Max !== undefined && ratioP50 > slaConfig.alignRatioP50Max) {
      failures.push(`alignRatio.p50 ${ratioP50.toFixed(3)} > ${slaConfig.alignRatioP50Max.toFixed(3)}`)
    }
    if (slaConfig.alignRatioP95Min !== undefined && ratioP95 < slaConfig.alignRatioP95Min) {
      failures.push(`alignRatio.p95 ${ratioP95.toFixed(3)} < ${slaConfig.alignRatioP95Min.toFixed(3)}`)
    }
    if (slaConfig.alignRatioP95Max !== undefined && ratioP95 > slaConfig.alignRatioP95Max) {
      failures.push(`alignRatio.p95 ${ratioP95.toFixed(3)} > ${slaConfig.alignRatioP95Max.toFixed(3)}`)
    }

    if (slaConfig.requireAlign) {
      if (alignFirst.length === 0) failures.push("requireAlign enabled but no tts.align observed (firstAlign n=0)")
      if (alignRatios.length === 0) failures.push("requireAlign enabled but no align ratios observed (alignRatio n=0)")
      const maxMissing = Math.floor(slaConfig.maxAlignMissingSegments ?? 0)
      if (alignMissingSegmentsTotal > maxMissing) {
        failures.push(`requireAlign: alignMissingSegments ${alignMissingSegmentsTotal} > ${maxMissing}`)
      }
      if (ttsSegmentsTotal > 0 && alignBoundSegmentsTotal === 0) {
        failures.push(`requireAlign: alignBoundSegments=0 while ttsSegments=${ttsSegmentsTotal}`)
      }
    }

    return { enabled: true, ok: failures.length === 0, failures, config: slaConfig }
  })()

  const report = {
    meta: collectPerfMeta({ runId }),
    ts: new Date().toISOString(),
    config: {
      wsUrl,
      sessions,
      turnsPerSession,
      delayMs,
      speakRatio,
      interruptProb,
      interruptDelayMs,
      turnTimeoutMs,
      realtime,
      audioText: process.env.OA_PERF_AUDIO_TEXT ?? "你好。",
      sampleRate: frames.sampleRate,
      frameMs: frames.frameMs,
      audioMs: frames.audioMs,
    },
    summary: {
      turns: all.length,
      completed: completed.length,
      interrupted: interrupted.length,
      errors: errors.length,
      errorRate: errors.length / Math.max(1, all.length),
      asrFinal: { p50: pctl(asrFinal, 50), p95: pctl(asrFinal, 95), n: asrFinal.length },
      ttsText: { p50: pctl(ttsText, 50), p95: pctl(ttsText, 95), n: ttsText.length },
      firstAudio: { p50: pctl(firstAudio, 50), p95: pctl(firstAudio, 95), n: firstAudio.length },
      firstAlign: { p50: pctl(alignFirst, 50), p95: pctl(alignFirst, 95), n: alignFirst.length },
      alignSegments: {
        ttsSegments: ttsSegmentsTotal,
        bound: alignBoundSegmentsTotal,
        missing: alignMissingSegmentsTotal,
      },
      alignRatio: { p50: pctl(alignRatios, 50), p95: pctl(alignRatios, 95), n: alignRatios.length },
      total: { p50: pctl(total, 50), p95: pctl(total, 95), n: total.length },
      interrupt: { p50: pctl(interruptMs, 50), p95: pctl(interruptMs, 95), n: interruptMs.length },
    },
    assert: sla,
    results: all,
  }

  const outFile = path.join(ROOT, "test-results", `perf-asrtts-report-${runId}.json`)
  await writeJson(outFile, report)
  // eslint-disable-next-line no-console
  console.log(`Report written: ${outFile}`)

  if (sla.enabled) {
    if (sla.ok) {
      // eslint-disable-next-line no-console
      console.log("SLA: OK")
    } else {
      // eslint-disable-next-line no-console
      console.error(`SLA: FAILED (${sla.failures.length})`)
      for (const f of sla.failures) {
        // eslint-disable-next-line no-console
        console.error(`- ${f}`)
      }
      process.exit(2)
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
