import { Hono } from "hono"
import z from "zod/v4"

import { getInitialAndFinal, pinyin } from "../vendor/pinyin-pro/index.mjs"

const Env = z.object({
  OA_TTS_HOST: z.string().default("0.0.0.0"),
  OA_TTS_PORT: z.coerce.number().int().positive().default(7003),

  // mock: generate a placeholder tone (no external deps)
  // cosyvoice: proxy to a CosyVoice runtime server (fastapi)
  OA_TTS_BACKEND: z.enum(["mock", "cosyvoice"]).default("cosyvoice"),

  // CosyVoice runtime fastapi base URL (see FunAudioLLM/CosyVoice runtime/python/fastapi/server.py)
  OA_TTS_COSYVOICE_BASE_URL: z.string().default("http://127.0.0.1:50000"),
  OA_TTS_COSYVOICE_MODE: z.enum(["sft"]).default("sft"),
  OA_TTS_COSYVOICE_SPK_ID: z.string().default("中文女"),
  OA_TTS_COSYVOICE_SAMPLE_RATE: z.coerce.number().int().positive().default(22050),
  OA_TTS_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

  OA_TTS_CHUNK_BYTES: z.coerce.number().int().positive().default(16000),
  // For OA_TTS_BACKEND=mock (placeholder tone only)
  OA_TTS_SAMPLE_RATE: z.coerce.number().int().positive().default(16000),

  // Optional alignment segments (for `tts.align` in the Gateway).
  OA_TTS_ALIGN_ENABLED: z.coerce.boolean().default(true),

  // Optional lipsync marks (embedded in tts.audio chunks as `{tMs, open}`).
  OA_TTS_MARKS_ENABLED: z.coerce.boolean().default(true),
  OA_TTS_MARK_WINDOW_MS: z.coerce.number().int().positive().default(40),

  // Heuristic text->(phoneme/viseme) timing (ms). Used to attach `viseme/phoneme/word` to marks.
  OA_TTS_ALIGN_CONSONANT_MS: z.coerce.number().int().positive().default(70),
  OA_TTS_ALIGN_VOWEL_MS: z.coerce.number().int().positive().default(170),
  OA_TTS_ALIGN_PAUSE_WEAK_MS: z.coerce.number().int().positive().default(120), // comma-ish
  OA_TTS_ALIGN_PAUSE_STRONG_MS: z.coerce.number().int().positive().default(240), // period-ish
})

const env = Env.parse(process.env)

const SynthesizeInput = z.object({
  // Keep sessionID optional for compatibility with current gateway client.
  sessionID: z.string().min(1).optional(),
  text: z.string().min(1),
})

function base64FromBytes(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function alignEven(n: number) {
  const x = Math.max(2, Math.floor(n))
  return x - (x % 2)
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

type Viseme = "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS" | "nn" | "RR" | "aa" | "E" | "ih" | "oh" | "ou"

type MouthMark = { tMs: number; open: number }

type AlignSeg = { startMs: number; endMs: number; viseme: Viseme; phoneme: string; word: string }

class AlignCursor {
  private i = 0

  constructor(private segs: AlignSeg[]) {}

  atMs(ms: number): AlignSeg | undefined {
    while (this.i + 1 < this.segs.length && ms >= (this.segs[this.i]?.endMs ?? Infinity)) this.i += 1
    return this.segs[this.i]
  }
}

function isPauseChar(ch: string) {
  return /[，,、;；:：。.!！?？]/.test(ch)
}

function pauseMsForChar(ch: string) {
  if (!ch) return 0
  if (/[。.!！?？]/.test(ch)) return env.OA_TTS_ALIGN_PAUSE_STRONG_MS
  if (/[，,、;；:：]/.test(ch)) return env.OA_TTS_ALIGN_PAUSE_WEAK_MS
  return 0
}

function visemeForInitial(initial: string): Viseme {
  const x = initial.toLowerCase()
  if (x === "b" || x === "p" || x === "m") return "PP"
  if (x === "f") return "FF"
  if (x === "d" || x === "t") return "DD"
  if (x === "n" || x === "l") return "nn"
  if (x === "g" || x === "k" || x === "h") return "kk"
  if (x === "zh" || x === "ch" || x === "sh" || x === "j" || x === "q" || x === "x") return "CH"
  if (x === "z" || x === "c" || x === "s") return "SS"
  if (x === "r") return "RR"
  if (x === "y") return "ih"
  if (x === "w") return "ou"
  return "sil"
}

function visemeForFinal(final: string): Viseme {
  const x = final.toLowerCase().replace(/v|ü/g, "u")
  if (!x) return "sil"
  if (x.includes("a")) return "aa"
  if (x.includes("o")) return "oh"
  if (x.includes("u")) return "ou"
  if (x.includes("i")) return "ih"
  if (x.includes("e")) return "E"
  return "aa"
}

function alignForText(text: string): { cursor: AlignCursor; segments: AlignSeg[] } {
  const chars = Array.from(text)
  const py = pinyin(text, { toneType: "none", type: "array" }) as string[]

  const segs: AlignSeg[] = []
  let t = 0

  const n = Math.max(chars.length, py.length)
  for (let i = 0; i < n; i++) {
    const word = chars[i] ?? ""
    const token = (py[i] ?? word).trimEnd()

    const pauseMs = pauseMsForChar(word || token)
    if (pauseMs > 0) {
      segs.push({ startMs: t, endMs: t + pauseMs, viseme: "sil", phoneme: "sil", word: word || token })
      t += pauseMs
      continue
    }

    if (!token) continue
    if (!word && isPauseChar(token)) continue

    const parts = getInitialAndFinal(token) as { initial?: string; final?: string }
    const initial = parts.initial ?? ""
    const final = parts.final ?? ""

    if (initial) {
      const d = env.OA_TTS_ALIGN_CONSONANT_MS
      segs.push({ startMs: t, endMs: t + d, viseme: visemeForInitial(initial), phoneme: initial, word: word || token })
      t += d
    }

    if (final) {
      const d = env.OA_TTS_ALIGN_VOWEL_MS
      segs.push({ startMs: t, endMs: t + d, viseme: visemeForFinal(final), phoneme: final, word: word || token })
      t += d
    }

    if (!initial && !final) {
      const d = 180
      segs.push({ startMs: t, endMs: t + d, viseme: visemeForFinal(token), phoneme: token, word: word || token })
      t += d
    }
  }

  if (segs.length === 0) segs.push({ startMs: 0, endMs: 1, viseme: "sil", phoneme: "sil", word: "" })
  return { cursor: new AlignCursor(segs), segments: segs }
}

function marksFromPcm16le(
  bytes: Uint8Array,
  opts: { sampleRate: number; windowMs: number },
): MouthMark[] {
  const sampleRate = Math.max(1, Math.floor(opts.sampleRate))
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples <= 0) return []

  const windowMs = clamp(Math.floor(opts.windowMs), 10, 250)
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000))

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const marks: MouthMark[] = []

  for (let startSample = 0; startSample < samples; startSample += windowSamples) {
    const endSample = Math.min(samples, startSample + windowSamples)
    let sumSquares = 0
    for (let i = startSample; i < endSample; i++) {
      const s = view.getInt16(i * 2, true) / 0x8000
      sumSquares += s * s
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, endSample - startSample))
    const open = clamp((rms - 0.02) / 0.12, 0, 1)
    const tMs = Math.round((startSample * 1000) / sampleRate)
    marks.push({ tMs, open })
  }

  return marks
}

function synthTonePCM16le(opts: { durationSeconds: number; sampleRate: number; frequencyHz: number }) {
  const total = Math.max(1, Math.round(opts.durationSeconds * opts.sampleRate))
  const pcm = new Int16Array(total)
  const amp = 0.2
  for (let i = 0; i < total; i++) {
    const t = i / opts.sampleRate
    const s = Math.sin(2 * Math.PI * opts.frequencyHz * t) * amp
    pcm[i] = Math.round(s * 0x7fff)
  }
  return pcm
}

type CancelEntry = {
  abort: AbortController
  expiresAt: number
}

const cancels = new Map<string, CancelEntry>()
const CANCEL_TTL_MS = 60_000

function ensureCancel(sessionID: string | undefined) {
  if (!sessionID) return
  cancels.set(sessionID, { abort: new AbortController(), expiresAt: Date.now() + CANCEL_TTL_MS })
}

function abortFor(sessionID: string | undefined) {
  if (!sessionID) return
  const entry = cancels.get(sessionID)
  if (!entry) return
  try {
    entry.abort.abort()
  } catch {
    // ignore
  }
  cancels.delete(sessionID)
}

function sweepCancels() {
  const now = Date.now()
  for (const [k, v] of cancels) {
    if (v.expiresAt > now) continue
    cancels.delete(k)
  }
}

function anySignal(signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController()
  for (const sig of signals) {
    if (!sig) continue
    if (sig.aborted) {
      controller.abort()
      break
    }
    sig.addEventListener(
      "abort",
      () => {
        try {
          controller.abort()
        } catch {
          // ignore
        }
      },
      { once: true },
    )
  }
  return controller.signal
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

async function synthesizeCosyVoice(opts: { text: string; signal?: AbortSignal }) {
  const url = new URL("/inference_sft", env.OA_TTS_COSYVOICE_BASE_URL)

  const form = new FormData()
  form.set("tts_text", opts.text)
  form.set("spk_id", env.OA_TTS_COSYVOICE_SPK_ID)

  const res = await fetch(url, { method: "POST", body: form, signal: opts.signal })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`CosyVoice inference failed: ${res.status} ${res.statusText} ${text}`)
  }
  if (!res.body) return { sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE, chunks: [] as Uint8Array[] }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (opts.signal?.aborted) break
      if (!value?.byteLength) continue
      chunks.push(value)
    }
  } catch {
    // If aborted mid-flight, treat as best-effort partial audio.
  }

  return { sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE, chunks }
}

class ByteQueue {
  private chunks: Uint8Array[] = []
  length = 0

  push(bytes: Uint8Array) {
    if (!bytes.byteLength) return
    this.chunks.push(bytes)
    this.length += bytes.byteLength
  }

  shift(n: number): Uint8Array {
    const want = Math.max(0, Math.min(n, this.length))
    const out = new Uint8Array(want)
    let off = 0

    while (off < want) {
      const head = this.chunks[0]
      if (!head) break
      const take = Math.min(head.byteLength, want - off)
      out.set(head.subarray(0, take), off)
      off += take

      if (take === head.byteLength) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)

      this.length -= take
    }

    return out
  }
}

type OutChunk = { seq: number; mime: string; sampleRate: number; data: string; marks?: MouthMark[] }

async function* cosyVoiceToOutChunks(opts: { text: string; chunkBytes: number; signal?: AbortSignal }): AsyncIterable<OutChunk> {
  const chunkBytes = alignEven(opts.chunkBytes)
  const mime = "audio/pcm;codec=s16le"

  const url = new URL("/inference_sft", env.OA_TTS_COSYVOICE_BASE_URL)
  const form = new FormData()
  form.set("tts_text", opts.text)
  form.set("spk_id", env.OA_TTS_COSYVOICE_SPK_ID)

  const res = await fetch(url, { method: "POST", body: form, signal: opts.signal })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`CosyVoice inference failed: ${res.status} ${res.statusText} ${text}`)
  }
  if (!res.body) return

  const reader = res.body.getReader()
  const queue = new ByteQueue()
  let seq = 0

  try {
    while (true) {
      if (opts.signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      if (opts.signal?.aborted) break
      if (!value?.byteLength) continue

      queue.push(value)

      while (!opts.signal?.aborted && queue.length >= chunkBytes) {
        const bytes = queue.shift(chunkBytes)
        yield {
          seq,
          mime,
          sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE,
          data: base64FromBytes(bytes),
          marks: env.OA_TTS_MARKS_ENABLED
            ? marksFromPcm16le(bytes, { sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE, windowMs: env.OA_TTS_MARK_WINDOW_MS })
            : undefined,
        }
        seq += 1
        await Bun.sleep(0)
      }
    }

    while (!opts.signal?.aborted && queue.length > 0) {
      const bytes = queue.shift(queue.length)
      if (!bytes.byteLength) break
      yield {
        seq,
        mime,
        sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE,
        data: base64FromBytes(bytes),
        marks: env.OA_TTS_MARKS_ENABLED
          ? marksFromPcm16le(bytes, { sampleRate: env.OA_TTS_COSYVOICE_SAMPLE_RATE, windowMs: env.OA_TTS_MARK_WINDOW_MS })
          : undefined,
      }
      seq += 1
      await Bun.sleep(0)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

async function* mockToneToOutChunks(opts: { text: string; chunkBytes: number; signal?: AbortSignal }): AsyncIterable<OutChunk> {
  const sampleRate = env.OA_TTS_SAMPLE_RATE
  const durationSeconds = clamp(Math.max(0.4, opts.text.length * 0.06), 0.4, 3.0)
  const pcm = synthTonePCM16le({ durationSeconds, sampleRate, frequencyHz: 440 })

  const bytes = new Uint8Array(pcm.buffer)
  const chunkBytes = alignEven(opts.chunkBytes)
  const mime = "audio/pcm;codec=s16le"

  for (let offset = 0, seq = 0; offset < bytes.byteLength; seq++) {
    if (opts.signal?.aborted) break
    const end = Math.min(bytes.byteLength, offset + chunkBytes)
    const slice = bytes.subarray(offset, end)
    if (!slice.byteLength) break
    yield {
      seq,
      mime,
      sampleRate,
      data: base64FromBytes(slice),
      marks: env.OA_TTS_MARKS_ENABLED
        ? marksFromPcm16le(slice, { sampleRate, windowMs: env.OA_TTS_MARK_WINDOW_MS })
        : undefined,
    }
    offset = end
    await Bun.sleep(0)
  }
}

type ReadyState = { ok: boolean; checkedAt: number; detail?: string }
let lastReady: ReadyState | undefined
let readyInFlight: Promise<ReadyState> | undefined
const READY_CACHE_MS = 5000

async function checkCosyVoiceReady(): Promise<void> {
  const url = new URL("/inference_sft", env.OA_TTS_COSYVOICE_BASE_URL)
  const form = new FormData()
  form.set("tts_text", "你好")
  form.set("spk_id", env.OA_TTS_COSYVOICE_SPK_ID)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.OA_TTS_READY_TIMEOUT_MS)

  try {
    const res = await fetch(url, { method: "POST", body: form, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`CosyVoice inference failed: ${res.status} ${res.statusText} ${text}`)
    }

    const reader = res.body?.getReader()
    if (!reader) return
    try {
      await reader.read()
    } finally {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function readyStatus(): Promise<ReadyState> {
  const now = Date.now()
  if (lastReady?.ok && now - lastReady.checkedAt < READY_CACHE_MS) return lastReady
  if (readyInFlight) return await readyInFlight

  readyInFlight = (async () => {
    if (env.OA_TTS_BACKEND !== "cosyvoice") return { ok: true, checkedAt: Date.now() }
    try {
      await checkCosyVoiceReady()
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

{
  const interval = setInterval(sweepCancels, 5_000)
  if (typeof (interval as any)?.unref === "function") (interval as any).unref()
}

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))
app.get("/readyz", async (c) => {
  const status = await readyStatus()
  return c.json(
    { ok: status.ok, backend: env.OA_TTS_BACKEND, detail: status.detail },
    status.ok ? 200 : 503,
  )
})

app.post("/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as unknown
  const sessionID = z.object({ sessionID: z.string().min(1) }).parse(body).sessionID
  abortFor(sessionID)
  return c.json({ ok: true })
})

app.post("/align", async (c) => {
  const input = SynthesizeInput.parse(await c.req.json().catch(() => ({})))
  if (!env.OA_TTS_ALIGN_ENABLED) return c.json({ segments: [] })
  const { segments } = alignForText(input.text)
  return c.json({ segments })
})

app.post("/synthesize", async (c) => {
  const input = SynthesizeInput.parse(await c.req.json().catch(() => ({})))
  ensureCancel(input.sessionID)

  const entry = input.sessionID ? cancels.get(input.sessionID) : undefined
  const signal = anySignal([entry?.abort.signal, c.req.raw.signal])
  const chunkBytes = alignEven(env.OA_TTS_CHUNK_BYTES)

  if (signal?.aborted || c.req.raw.signal.aborted) {
    return c.json({ chunks: [] })
  }

  const accept = (c.req.header("accept") ?? "").toLowerCase()
  const wantsNdjson = accept.includes("application/x-ndjson")

  const streamChunks =
    env.OA_TTS_BACKEND === "cosyvoice"
      ? cosyVoiceToOutChunks({ text: input.text, chunkBytes, signal })
      : mockToneToOutChunks({ text: input.text, chunkBytes, signal })

  const cleanupIfAborted = () => {
    if (input.sessionID && (entry?.abort.signal.aborted || c.req.raw.signal.aborted)) cancels.delete(input.sessionID)
  }

  if (wantsNdjson) {
    const encoder = new TextEncoder()
    const hbBytes = encoder.encode("\n")

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          const hb = setInterval(() => {
            if (signal.aborted) return clearInterval(hb)
            try {
              controller.enqueue(hbBytes)
            } catch {
              clearInterval(hb)
            }
          }, 1000)

          try {
            for await (const chunk of streamChunks) {
              if (signal.aborted) break
              controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`))
            }
          } catch (err) {
            if (!signal.aborted) {
              try {
                controller.error(err)
              } catch {
                // ignore (already closed / cancelled)
              }
            }
          } finally {
            clearInterval(hb)
            cleanupIfAborted()
            try {
              controller.close()
            } catch {
              // ignore (already closed / cancelled)
            }
          }
        })()
      },
    })

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }

  try {
    const out: OutChunk[] = []
    for await (const chunk of streamChunks) out.push(chunk)
    return c.json({ chunks: out })
  } finally {
    cleanupIfAborted()
  }
})

const server = Bun.serve({
  hostname: env.OA_TTS_HOST,
  port: env.OA_TTS_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-tts listening on ${server.url}`)
