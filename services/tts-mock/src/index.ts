import { Hono } from "hono"
import z from "zod/v4"

const Env = z.object({
  OA_TTS_MOCK_HOST: z.string().default("0.0.0.0"),
  OA_TTS_MOCK_PORT: z.coerce.number().int().positive().default(7003),
  OA_TTS_MOCK_SAMPLE_RATE: z.coerce.number().int().positive().default(16000),
  OA_TTS_MOCK_ALIGN_ENABLED: z.coerce.boolean().default(true),
  OA_TTS_MOCK_MARKS_ENABLED: z.coerce.boolean().default(true),
  OA_TTS_MOCK_MARK_WINDOW_MS: z.coerce.number().int().positive().default(40),
})

const env = Env.parse(process.env)

const SynthesizeInput = z.object({
  sessionID: z.string().min(1).optional(),
  text: z.string(),
})

function base64FromBytes(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function alignEven(n: number) {
  const x = Math.max(2, Math.floor(n))
  return x - (x % 2)
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
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

type Viseme = "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS" | "nn" | "RR" | "aa" | "E" | "ih" | "oh" | "ou"

type TtsMark = { tMs: number; open: number }

type AlignSeg = { startMs: number; endMs: number; viseme: Viseme; phoneme: string; word: string }

class AlignCursor {
  private i = 0

  constructor(private segs: AlignSeg[]) {}

  atMs(ms: number): AlignSeg | undefined {
    while (this.i + 1 < this.segs.length && ms >= (this.segs[this.i]?.endMs ?? Infinity)) this.i += 1
    return this.segs[this.i]
  }
}

function isPauseToken(token: string) {
  return /[，,、;；:：。.!！?？]/.test(token)
}

function pauseMsForToken(token: string) {
  if (/[。.!！?？]/.test(token)) return 240
  if (/[，,、;；:：]/.test(token)) return 120
  return 0
}

function tokenize(text: string) {
  const out: string[] = []
  let buf = ""

  const flush = () => {
    const s = buf.trim()
    if (s) out.push(s)
    buf = ""
  }

  for (const ch of Array.from(text)) {
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    if (isPauseToken(ch)) {
      flush()
      out.push(ch)
      continue
    }
    if (/[\u0000-\u007f]/.test(ch)) {
      buf += ch
      continue
    }
    flush()
    out.push(ch)
  }

  flush()
  return out
}

function visemeForToken(token: string): Viseme {
  const raw = token.trim()
  if (!raw) return "sil"
  if (isPauseToken(raw)) return "sil"

  const lower = raw.toLowerCase()

  if (/(^|[^a-z])(b|p|m)([^a-z]|$)/.test(lower)) return "PP"
  if (/(^|[^a-z])f([^a-z]|$)/.test(lower)) return "FF"
  if (/(^|[^a-z])(d|t)([^a-z]|$)/.test(lower)) return "DD"
  if (/(^|[^a-z])(n|l)([^a-z]|$)/.test(lower)) return "nn"
  if (/(^|[^a-z])(g|k|h)([^a-z]|$)/.test(lower)) return "kk"
  if (/(^|[^a-z])(zh|ch|sh|j|q|x)([^a-z]|$)/.test(lower)) return "CH"
  if (/(^|[^a-z])(z|c|s)([^a-z]|$)/.test(lower)) return "SS"
  if (/(^|[^a-z])r([^a-z]|$)/.test(lower)) return "RR"

  if (/[a]/.test(lower)) return "aa"
  if (/[o]/.test(lower)) return "oh"
  if (/[uüv]/.test(lower)) return "ou"
  if (/[i]/.test(lower)) return "ih"
  if (/[e]/.test(lower)) return "E"

  // Non-ascii: pick a stable vowel-ish mouth shape based on code point.
  const cp = raw.codePointAt(0) ?? 0
  const vowels: Viseme[] = ["aa", "E", "ih", "oh", "ou"]
  return vowels[Math.abs(cp) % vowels.length] ?? "aa"
}

function alignForText(text: string): { cursor: AlignCursor; segments: AlignSeg[] } {
  const tokens = tokenize(text)
  const segs: AlignSeg[] = []
  let t = 0

  for (const token of tokens) {
    const pauseMs = pauseMsForToken(token)
    if (pauseMs > 0) {
      segs.push({ startMs: t, endMs: t + pauseMs, viseme: "sil", phoneme: "sil", word: token })
      t += pauseMs
      continue
    }

    const d = clamp(Math.round(120 + token.length * 28), 90, 360)
    segs.push({ startMs: t, endMs: t + d, viseme: visemeForToken(token), phoneme: token, word: token })
    t += d
  }

  if (segs.length === 0) segs.push({ startMs: 0, endMs: 1, viseme: "sil", phoneme: "sil", word: "" })
  return { cursor: new AlignCursor(segs), segments: segs }
}

function marksFromPcm16le(
  bytes: Uint8Array,
  opts: { sampleRate: number; windowMs: number },
): TtsMark[] {
  const sampleRate = Math.max(1, Math.floor(opts.sampleRate))
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples <= 0) return []

  const windowMs = clamp(Math.floor(opts.windowMs), 10, 250)
  const windowSamples = Math.max(1, Math.round((sampleRate * windowMs) / 1000))

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const marks: TtsMark[] = []

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

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))
app.get("/readyz", (c) => c.json({ ok: true }))

app.post("/cancel", (c) => c.json({ ok: true }))

app.post("/align", async (c) => {
  const input = SynthesizeInput.parse(await c.req.json().catch(() => ({})))
  if (!env.OA_TTS_MOCK_ALIGN_ENABLED) return c.json({ segments: [] })
  const { segments } = alignForText(input.text)
  return c.json({ segments })
})

app.post("/synthesize", async (c) => {
  const input = SynthesizeInput.parse(await c.req.json().catch(() => ({})))

  const sampleRate = env.OA_TTS_MOCK_SAMPLE_RATE
  const durationSeconds = clamp(Math.max(0.4, input.text.length * 0.06), 0.4, 3.0)
  const pcm = synthTonePCM16le({ durationSeconds, sampleRate, frequencyHz: 440 })

  const bytes = new Uint8Array(pcm.buffer)
  const chunks = 4
  const chunkBytes = alignEven(Math.ceil(bytes.length / chunks))
  const out: Array<{ seq: number; mime: string; sampleRate: number; data: string; marks?: TtsMark[] }> = []

  for (let i = 0; i < chunks; i++) {
    const start = i * chunkBytes
    const end = Math.min(bytes.length, start + chunkBytes)
    if (start >= end) break

    const slice = bytes.subarray(start, end)
    out.push({
      seq: i,
      mime: "audio/pcm;codec=s16le",
      sampleRate,
      data: base64FromBytes(slice),
      marks: env.OA_TTS_MOCK_MARKS_ENABLED
        ? marksFromPcm16le(slice, { sampleRate, windowMs: env.OA_TTS_MOCK_MARK_WINDOW_MS })
        : undefined,
    })
  }

  return c.json({ chunks: out })
})

const server = Bun.serve({
  hostname: env.OA_TTS_MOCK_HOST,
  port: env.OA_TTS_MOCK_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-tts-mock listening on ${server.url}`)
