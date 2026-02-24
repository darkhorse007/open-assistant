import type { Ws } from "@open-assistant/protocol"
import type { AsrConnection } from "./asr"

export type AsrSchedulerResult = {
  queued: boolean
  droppedFrames: number
}

export type AsrScheduler = {
  send: (sessionID: string, msg: Ws.AudioIn) => AsrSchedulerResult
  closeSession: (sessionID: string) => void
  getQueueDepth: () => number
  getActiveCount: () => number
}

type State = {
  conn?: AsrConnection
  ready: boolean
  queue: Ws.AudioIn[]
  lastAudioAt: number
}

export function createAsrScheduler(opts: {
  maxConcurrent: number
  idleReleaseMs: number
  queueMaxFrames: number
  connect: (sessionID: string) => AsrConnection
  onQueueDepth?: (n: number) => void
  onActive?: (n: number) => void
  onDrop?: (sessionID: string, droppedFrames: number) => void
}): AsrScheduler {
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent))
  const idleReleaseMs = Math.max(200, Math.floor(opts.idleReleaseMs))
  const queueMaxFrames = Math.max(0, Math.floor(opts.queueMaxFrames))

  const states = new Map<string, State>()
  const active = new Set<string>()

  const waitingOrder: string[] = []
  const waitingSet = new Set<string>()

  let pumpQueued = false

  function getQueueDepth() {
    let n = 0
    for (const state of states.values()) n += state.queue.length
    return n
  }

  function onQueueDepthChange() {
    opts.onQueueDepth?.(getQueueDepth())
  }

  function onActiveChange() {
    opts.onActive?.(active.size)
  }

  function ensureState(sessionID: string) {
    const existing = states.get(sessionID)
    if (existing) return existing
    const state: State = { ready: false, queue: [], lastAudioAt: 0 }
    states.set(sessionID, state)
    return state
  }

  function enqueueWaiting(sessionID: string) {
    if (waitingSet.has(sessionID)) return
    waitingSet.add(sessionID)
    waitingOrder.push(sessionID)
  }

  function pickNextWaiting(): string | undefined {
    while (waitingOrder.length) {
      const sessionID = waitingOrder.shift()!
      waitingSet.delete(sessionID)
      const state = states.get(sessionID)
      if (!state) continue
      if (state.conn) continue
      if (state.queue.length === 0) continue
      return sessionID
    }
  }

  function release(sessionID: string) {
    const state = states.get(sessionID)
    if (!state?.conn) return

    const conn = state.conn
    state.conn = undefined
    state.ready = false
    active.delete(sessionID)
    onActiveChange()

    try {
      conn.close()
    } catch {
      // ignore
    }

    if (state.queue.length > 0) enqueueWaiting(sessionID)
    onQueueDepthChange()
    schedulePump()
  }

  function flushQueue(sessionID: string, state: State) {
    if (!state.conn || !state.ready) return
    while (state.queue.length) {
      const msg = state.queue.shift()!
      state.conn.send(msg)
    }
    waitingSet.delete(sessionID)
    onQueueDepthChange()
  }

  function acquire(sessionID: string) {
    const state = ensureState(sessionID)
    if (state.conn) return
    if (active.size >= maxConcurrent) return

    const conn = opts.connect(sessionID)
    state.conn = conn
    state.ready = false
    active.add(sessionID)
    onActiveChange()

    void conn.ready
      .then(() => {
        const current = states.get(sessionID)
        if (!current || current.conn !== conn) return
        current.ready = true
        flushQueue(sessionID, current)
      })
      .catch(() => {
        const current = states.get(sessionID)
        if (!current || current.conn !== conn) return
        release(sessionID)
      })
  }

  function pump() {
    while (active.size < maxConcurrent) {
      const sessionID = pickNextWaiting()
      if (!sessionID) break
      acquire(sessionID)
    }
  }

  function schedulePump() {
    if (pumpQueued) return
    pumpQueued = true
    queueMicrotask(() => {
      pumpQueued = false
      pump()
    })
  }

  function pushWithLimit(sessionID: string, state: State, msg: Ws.AudioIn): number {
    if (queueMaxFrames === 0) {
      opts.onDrop?.(sessionID, 1)
      return 1
    }

    state.queue.push(msg)
    let dropped = 0
    while (state.queue.length > queueMaxFrames) {
      state.queue.shift()
      dropped += 1
    }
    if (dropped) opts.onDrop?.(sessionID, dropped)
    return dropped
  }

  function send(sessionID: string, msg: Ws.AudioIn): AsrSchedulerResult {
    const now = Date.now()
    const state = ensureState(sessionID)
    state.lastAudioAt = now

    if (state.conn && state.ready) {
      state.conn.send(msg)
      return { queued: false, droppedFrames: 0 }
    }

    const droppedFrames = pushWithLimit(sessionID, state, msg)
    onQueueDepthChange()

    if (state.conn) {
      return { queued: true, droppedFrames }
    }

    if (active.size < maxConcurrent) {
      acquire(sessionID)
      return { queued: true, droppedFrames }
    }

    enqueueWaiting(sessionID)
    schedulePump()
    return { queued: true, droppedFrames }
  }

  function closeSession(sessionID: string) {
    release(sessionID)
    states.delete(sessionID)
    waitingSet.delete(sessionID)
    onQueueDepthChange()
    schedulePump()
  }

  {
    const intervalMs = Math.min(1000, Math.max(200, Math.floor(idleReleaseMs / 2)))
    const interval = setInterval(() => {
      const now = Date.now()
      for (const sessionID of Array.from(active)) {
        const state = states.get(sessionID)
        if (!state?.conn || !state.ready) continue
        if (state.queue.length > 0) continue
        if (now - state.lastAudioAt <= idleReleaseMs) continue
        release(sessionID)
      }
    }, intervalMs)
    if (typeof (interval as any)?.unref === "function") (interval as any).unref()
  }

  onQueueDepthChange()
  onActiveChange()

  return { send, closeSession, getQueueDepth, getActiveCount: () => active.size }
}

