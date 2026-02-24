import z from "zod/v4"
import { Ws } from "@open-assistant/protocol"

const AlignOutput = z.object({
  segments: z.array(Ws.TtsAlignSegment).default([]),
})

export type TtsAlignment = z.infer<typeof AlignOutput>

const Chunk = z.object({
  seq: z.number().int().nonnegative(),
  mime: z.string().min(1),
  sampleRate: z.number().int().positive(),
  data: z.string().min(1),
  marks: z.array(Ws.TtsMark).optional(),
})

export type TtsChunk = z.infer<typeof Chunk>

const SynthesizeOutput = z.object({
  chunks: z.array(Chunk),
})

async function* parseNdjsonChunks(res: Response, opts: { signal?: AbortSignal }): AsyncIterable<TtsChunk> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      if (opts.signal?.aborted) break
      const { value, done } = await reader.read()
      if (done) break
      if (opts.signal?.aborted) break
      if (!value?.byteLength) continue

      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const idx = buffer.indexOf("\n")
        if (idx < 0) break

        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue

        let json: unknown
        try {
          json = JSON.parse(line)
        } catch {
          continue
        }

        yield Chunk.parse(json)
      }
    }

    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail) {
      try {
        yield Chunk.parse(JSON.parse(tail))
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

export async function* synthesize(
  cfg: { baseUrl: string; mode: "mock" | "external" | "disabled" },
  input: { sessionID: string; text: string; signal?: AbortSignal },
): AsyncIterable<TtsChunk> {
  if (cfg.mode === "disabled") return

  const res = await fetch(new URL("/synthesize", cfg.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson, application/json" },
    body: JSON.stringify({ sessionID: input.sessionID, text: input.text }),
    signal: input.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`TTS synthesize failed: ${res.status} ${res.statusText} ${text}`)
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
  if (contentType.includes("application/x-ndjson")) {
    for await (const chunk of parseNdjsonChunks(res, { signal: input.signal })) {
      yield chunk
    }
    return
  }

  const json = await res.json().catch(() => ({}))
  for (const chunk of SynthesizeOutput.parse(json).chunks) {
    yield chunk
  }
}

export async function align(
  cfg: { baseUrl: string; mode: "mock" | "external" | "disabled" },
  input: { sessionID: string; text: string; signal?: AbortSignal },
): Promise<TtsAlignment> {
  if (cfg.mode === "disabled") return { segments: [] }

  const res = await fetch(new URL("/align", cfg.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: input.sessionID, text: input.text }),
    signal: input.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`TTS align failed: ${res.status} ${res.statusText} ${text}`)
  }

  const json = await res.json().catch(() => ({}))
  return AlignOutput.parse(json)
}

export async function cancel(cfg: { baseUrl: string; mode: "mock" | "external" | "disabled" }, input: { sessionID: string; signal?: AbortSignal }) {
  if (cfg.mode === "disabled") return

  const res = await fetch(new URL("/cancel", cfg.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionID: input.sessionID }),
    signal: input.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`TTS cancel failed: ${res.status} ${res.statusText} ${text}`)
  }
}
