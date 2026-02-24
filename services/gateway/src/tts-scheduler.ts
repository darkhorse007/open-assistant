import type { TtsAlignment, TtsChunk } from "./tts"

export type TtsSynthesizeFn = (input: { sessionID: string; text: string; signal?: AbortSignal }) => AsyncIterable<TtsChunk>

export type TtsAlignFn = (input: { sessionID: string; text: string; signal?: AbortSignal }) => Promise<TtsAlignment>

export type TtsJob = {
  sessionID: string
  text: string
  signal?: AbortSignal
  onAlign?: (alignment: TtsAlignment) => void
  onChunk: (chunk: TtsChunk) => void
}

type InternalJob = TtsJob & {
  resolve: () => void
  reject: (err: unknown) => void
}

export type TtsScheduler = {
  enqueue: (job: TtsJob) => Promise<void>
  getQueueDepth: () => number
}

export function createTtsScheduler(opts: { maxConcurrent: number; align?: TtsAlignFn; synthesize: TtsSynthesizeFn; onDepth?: (n: number) => void }): TtsScheduler {
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent))
  const synthesize = opts.synthesize

  const queues = new Map<string, InternalJob[]>()
  const sessionOrder: string[] = []
  let rrIndex = 0

  const activeSessions = new Set<string>()
  let activeGlobal = 0
  let pumpQueued = false

  function getQueueDepth() {
    let n = 0
    for (const q of queues.values()) n += q.length
    return n
  }

  function onDepthChange() {
    opts.onDepth?.(getQueueDepth())
  }

  function maybeRemoveSession(sessionID: string) {
    const q = queues.get(sessionID)
    if (q && q.length > 0) return
    queues.delete(sessionID)
    const idx = sessionOrder.indexOf(sessionID)
    if (idx >= 0) sessionOrder.splice(idx, 1)
    if (rrIndex >= sessionOrder.length) rrIndex = 0
  }

  function schedulePump() {
    if (pumpQueued) return
    pumpQueued = true
    queueMicrotask(() => {
      pumpQueued = false
      pump()
    })
  }

  function pickNextJob(): InternalJob | undefined {
    if (sessionOrder.length === 0) return

    for (let i = 0; i < sessionOrder.length; i++) {
      const idx = (rrIndex + i) % sessionOrder.length
      const sessionID = sessionOrder[idx]!
      if (activeSessions.has(sessionID)) continue
      const q = queues.get(sessionID)
      if (!q || q.length === 0) continue

      rrIndex = (idx + 1) % sessionOrder.length
      return q.shift()
    }
  }

  async function runJob(job: InternalJob) {
    if (job.signal?.aborted) {
      job.resolve()
      return
    }

    if (opts.align && job.onAlign) {
      try {
        const alignment = await opts.align({ sessionID: job.sessionID, text: job.text, signal: job.signal })
        if (!job.signal?.aborted) job.onAlign(alignment)
      } catch (err) {
        if (job.signal?.aborted) {
          job.resolve()
          return
        }
        // Best-effort: alignment should not block audio playback.
      }
    }

    for await (const chunk of synthesize({ sessionID: job.sessionID, text: job.text, signal: job.signal })) {
      if (job.signal?.aborted) {
        job.resolve()
        return
      }
      job.onChunk(chunk)
    }

    job.resolve()
  }

  function pump() {
    while (activeGlobal < maxConcurrent) {
      const job = pickNextJob()
      if (!job) break
      onDepthChange()

      activeGlobal += 1
      activeSessions.add(job.sessionID)

      void runJob(job)
        .catch((err) => {
          if (job.signal?.aborted) return job.resolve()
          if (err instanceof Error && err.name === "AbortError") return job.resolve()
          return job.reject(err)
        })
        .finally(() => {
          activeGlobal -= 1
          activeSessions.delete(job.sessionID)
          maybeRemoveSession(job.sessionID)
          onDepthChange()
          schedulePump()
        })
    }
  }

  async function enqueue(job: TtsJob) {
    if (job.signal?.aborted) return

    return await new Promise<void>((resolve, reject) => {
      let done = false
      const resolveOnce = () => {
        if (done) return
        done = true
        resolve()
      }
      const rejectOnce = (err: unknown) => {
        if (done) return
        done = true
        reject(err)
      }

      const wrapped: InternalJob = { ...job, resolve: resolveOnce, reject: rejectOnce }

      const existing = queues.get(job.sessionID)
      if (existing) existing.push(wrapped)
      else {
        queues.set(job.sessionID, [wrapped])
        sessionOrder.push(job.sessionID)
      }

      const onAbort = () => {
        const q = queues.get(job.sessionID)
        if (q) {
          const idx = q.indexOf(wrapped)
          if (idx >= 0) q.splice(idx, 1)
        }
        maybeRemoveSession(job.sessionID)
        onDepthChange()
        schedulePump()
        resolveOnce()
      }

      if (job.signal) job.signal.addEventListener("abort", onAbort, { once: true })

      onDepthChange()
      schedulePump()
    })
  }

  return { enqueue, getQueueDepth }
}
