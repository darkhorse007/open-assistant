import { setTimeout as sleep } from "node:timers/promises"
import { Ws } from "@open-assistant/protocol"
import { fileURLToPath } from "node:url"
import path from "node:path"

type TurnResult = {
  sessionID: string
  turn: number
  ttsTextMs?: number
  firstAudioMs?: number
  interruptMs?: number
  totalMs?: number
  status: "completed" | "interrupted" | "error"
  error?: string
}

function pctl(values: number[], p: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
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

function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath))
  Bun.write(filePath, JSON.stringify(data, null, 2)).catch(() => {})
}

type Proc = ReturnType<typeof Bun.spawn>
const expectedExit = new Set<number>()

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

function spawnProc(name: string, cmd: string[], cwd: string, env?: Record<string, string | undefined>) {
  const spawnOpts = { cwd, env: env ?? process.env } as const
  let proc: Proc
  try {
    proc = Bun.spawn(cmd, { ...spawnOpts, stdout: "pipe", stderr: "pipe" })
  } catch {
    proc = Bun.spawn(cmd, { ...spawnOpts, stdout: "inherit", stderr: "inherit" })
  }

  const pid = proc.pid
  proc.exited
    .then((code) => {
      if (code === 0) return
      if (pid && expectedExit.has(pid)) return
      log(`[${name}] exited with code ${code}`)
    })
    .catch(() => {})

  return proc
}

async function killProc(proc: Proc) {
  const pid = proc.pid
  if (pid) {
    try {
      expectedExit.add(pid)
      if (process.platform === "win32") {
        await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
      } else {
        process.kill(pid, "SIGKILL")
      }
    } catch {
      // ignore
    }
  }
  try {
    proc.kill()
  } catch {
    // ignore
  }
  await proc.exited.catch(() => {})
}

async function waitForHttp(url: string, opts: { timeoutMs: number; intervalMs?: number }) {
  const started = Date.now()
  const intervalMs = opts.intervalMs ?? 300

  while (Date.now() - started < opts.timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // ignore
    }
    await sleep(intervalMs)
  }

  throw new Error(`Timed out waiting for HTTP: ${url}`)
}

async function runOneSession(opts: {
  wsUrl: string
  sessionID: string
  turns: number
  delayMs: number
  interruptProb: number
  interruptDelayMs: number
  turnTimeoutMs: number
  idleCloseMs: number
}) {
  return await new Promise<TurnResult[]>((resolve, reject) => {
    const results: TurnResult[] = []
    const url = new URL(opts.wsUrl)
    url.searchParams.set("sessionID", opts.sessionID)
    const ws = new WebSocket(url.toString())

    let currentTurn = 0
    let turnStartedAt = 0
    let lastState: Ws.StateValue = "idle"
    let ttsTextAt: number | undefined
    let firstAudioAt: number | undefined
    let shouldInterrupt = false
    let interruptSentAt: number | undefined
    let interruptDoneAt: number | undefined
    let interruptTimer: ReturnType<typeof setTimeout> | undefined
    let turnRecorded = false

    const startTurn = () => {
      currentTurn += 1
      ttsTextAt = undefined
      firstAudioAt = undefined
      shouldInterrupt = Math.random() < opts.interruptProb
      interruptSentAt = undefined
      interruptDoneAt = undefined
      turnRecorded = false
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined

      turnStartedAt = now()
      const msg: Ws.TextIn = { v: 0, type: "text.in", sessionID: opts.sessionID, text: `perf turn ${currentTurn}` }
      ws.send(JSON.stringify(msg))
      armTurnTimeout()
    }

    const finishTurnIfReady = () => {
      if (currentTurn <= 0) return
      if (turnRecorded) return
      const elapsed = now() - turnStartedAt

      if (interruptSentAt !== undefined) {
        if (interruptDoneAt === undefined) return

        turnRecorded = true
        if (turnTimeout) clearTimeout(turnTimeout)
        turnTimeout = undefined
        if (interruptTimer) clearTimeout(interruptTimer)
        interruptTimer = undefined

        results.push({
          sessionID: opts.sessionID,
          turn: currentTurn,
          ttsTextMs: ttsTextAt,
          firstAudioMs: firstAudioAt,
          interruptMs: interruptDoneAt - interruptSentAt,
          totalMs: elapsed,
          status: "interrupted",
        })
      } else {
        if (lastState !== "listening") return
        if (ttsTextAt === undefined) return
        if (firstAudioAt === undefined) return

        turnRecorded = true
        if (turnTimeout) clearTimeout(turnTimeout)
        turnTimeout = undefined
        if (interruptTimer) clearTimeout(interruptTimer)
        interruptTimer = undefined

        results.push({
          sessionID: opts.sessionID,
          turn: currentTurn,
          ttsTextMs: ttsTextAt,
          firstAudioMs: firstAudioAt,
          totalMs: elapsed,
          status: "completed",
        })
      }

      if (currentTurn >= opts.turns) {
        ws.close()
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

    const timeout = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`Timed out: ${opts.sessionID}`))
    }, Math.max(5_000, opts.turns > 0 ? opts.turnTimeoutMs * Math.max(1, opts.turns) : opts.idleCloseMs + 2000))

    let turnTimeout: ReturnType<typeof setTimeout> | undefined
    const armTurnTimeout = () => {
      if (turnTimeout) clearTimeout(turnTimeout)
      turnTimeout = setTimeout(() => {
        results.push({
          sessionID: opts.sessionID,
          turn: currentTurn,
          ttsTextMs: ttsTextAt,
          firstAudioMs: firstAudioAt,
          totalMs: now() - turnStartedAt,
          status: "error",
          error: "turn_timeout",
        })
        try {
          ws.close()
        } catch {
          // ignore
        }
      }, opts.turnTimeoutMs)
    }

    ws.onopen = () => {
      if (opts.turns <= 0) {
        setTimeout(() => {
          try {
            ws.close()
          } catch {
            // ignore
          }
        }, Math.max(500, opts.idleCloseMs))
        return
      }
      startTurn()
      armTurnTimeout()
    }

    ws.onmessage = (event) => {
      try {
        const msg = Ws.GatewayToClient.parse(JSON.parse(String(event.data)))
        if (msg.type === "state") {
          lastState = msg.state
          if (lastState === "speaking" && shouldInterrupt && interruptSentAt === undefined && !interruptTimer) {
            interruptTimer = setTimeout(sendInterrupt, Math.max(0, opts.interruptDelayMs))
          }
          if (interruptSentAt !== undefined && lastState === "listening" && interruptDoneAt === undefined) {
            interruptDoneAt = now()
          }
          finishTurnIfReady()
        } else if (msg.type === "tts.text" && msg.final) {
          if (ttsTextAt === undefined) ttsTextAt = now() - turnStartedAt
          if (shouldInterrupt && interruptSentAt === undefined && !interruptTimer) {
            interruptTimer = setTimeout(sendInterrupt, Math.max(0, opts.interruptDelayMs))
          }
          finishTurnIfReady()
        } else if (msg.type === "tts.audio") {
          if (firstAudioAt === undefined) firstAudioAt = now() - turnStartedAt
        } else if (msg.type === "ui.stop") {
          if (interruptSentAt !== undefined && interruptDoneAt === undefined) {
            interruptDoneAt = now()
            finishTurnIfReady()
          } else if (!turnRecorded && currentTurn > 0 && (msg.target === undefined || msg.target === "tts" || msg.target === "all")) {
            turnRecorded = true
            if (turnTimeout) clearTimeout(turnTimeout)
            turnTimeout = undefined
            if (interruptTimer) clearTimeout(interruptTimer)
            interruptTimer = undefined

            results.push({
              sessionID: opts.sessionID,
              turn: currentTurn,
              ttsTextMs: ttsTextAt,
              firstAudioMs: firstAudioAt,
              totalMs: now() - turnStartedAt,
              status: "error",
              error: "ui_stop",
            })

            try {
              ws.close()
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      clearTimeout(timeout)
      if (turnTimeout) clearTimeout(turnTimeout)
      if (interruptTimer) clearTimeout(interruptTimer)
      resolve(results)
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      if (turnTimeout) clearTimeout(turnTimeout)
      if (interruptTimer) clearTimeout(interruptTimer)
      reject(new Error(`WebSocket error: ${opts.sessionID}`))
    }
  })
}

async function main() {
  const spawnStack = process.env.OA_PERF_SPAWN_STACK === "1"
  const wsUrl = process.env.OA_PERF_GATEWAY_WS_URL ?? "ws://127.0.0.1:7001/ws"
  const sessions = Number(process.env.OA_PERF_SESSIONS ?? "10")
  const turnsPerSession = Number(process.env.OA_PERF_TURNS_PER_SESSION ?? "3")
  const delayMs = Number(process.env.OA_PERF_DELAY_MS ?? "200")
  const speakRatio = Number(process.env.OA_PERF_SPEAK_RATIO ?? "1.0")
  const interruptProb = Number(process.env.OA_PERF_INTERRUPT_PROB ?? "0.3")
  const interruptDelayMs = Number(process.env.OA_PERF_INTERRUPT_DELAY_MS ?? "250")
  const turnTimeoutMs = Number(process.env.OA_PERF_TURN_TIMEOUT_MS ?? "45000")

  const ROOT = fileURLToPath(new URL("..", import.meta.url))
  const BUN_BIN = Bun.which("bun") ?? process.execPath
  const procs: Array<{ name: string; proc: Proc }> = []

  try {
    if (spawnStack) {
      log("Starting stack (mocks + gateway)…")

      const asr = spawnProc("asr-mock", [BUN_BIN, "run", "dev:asr"], ROOT)
      procs.push({ name: "asr-mock", proc: asr })
      await waitForHttp("http://127.0.0.1:7002/healthz", { timeoutMs: 20_000 })

      const tts = spawnProc("tts-mock", [BUN_BIN, "run", "dev:tts"], ROOT)
      procs.push({ name: "tts-mock", proc: tts })
      await waitForHttp("http://127.0.0.1:7003/healthz", { timeoutMs: 20_000 })

      const media = spawnProc("media-mock", [BUN_BIN, "run", "dev:media:mock"], ROOT)
      procs.push({ name: "media-mock", proc: media })
      await waitForHttp("http://127.0.0.1:7004/healthz", { timeoutMs: 20_000 })

      const rag = spawnProc("rag-mock", [BUN_BIN, "run", "dev:rag:mock"], ROOT)
      procs.push({ name: "rag-mock", proc: rag })
      await waitForHttp("http://127.0.0.1:7005/healthz", { timeoutMs: 20_000 })

      const gw = spawnProc("gateway", [BUN_BIN, "run", "dev:gateway"], ROOT, { ...process.env, OA_LLM_MODE: "mock" })
      procs.push({ name: "gateway", proc: gw })
      await waitForHttp("http://127.0.0.1:7001/healthz", { timeoutMs: 20_000 })
    }

    log(
      `Perf: sessions=${sessions} turnsPerSession=${turnsPerSession} speakRatio=${speakRatio.toFixed(2)} interruptProb=${interruptProb.toFixed(2)} ws=${wsUrl}`,
    )

    const all: TurnResult[] = []
    const runners: Promise<TurnResult[]>[] = []
    for (let i = 0; i < sessions; i++) {
      const sessionID = `perf-${Date.now()}-${i}`
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
          interruptProb: Math.max(0, Math.min(1, interruptProb)),
          interruptDelayMs: Math.max(0, interruptDelayMs),
          turnTimeoutMs: Math.max(1000, turnTimeoutMs),
          idleCloseMs,
        }).catch((err) => [
          {
            sessionID,
            turn: 0,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          } satisfies TurnResult,
        ]),
      )
    }

    const results = await Promise.all(runners)
    for (const r of results) all.push(...r)

    const completed = all.filter((r) => r.status === "completed")
    const interrupted = all.filter((r) => r.status === "interrupted")
    const errors = all.filter((r) => r.status === "error")

    const ttsText = completed.map((r) => r.ttsTextMs ?? 0).filter((n) => n > 0)
    const firstAudio = completed.map((r) => r.firstAudioMs ?? 0).filter((n) => n > 0)
    const total = completed.map((r) => r.totalMs ?? 0).filter((n) => n > 0)
    const interruptMs = interrupted.map((r) => r.interruptMs ?? 0).filter((n) => n > 0)

    log(`Turns: ${all.length}`)
    log(
      `completed: ${completed.length} interrupted: ${interrupted.length} errors: ${errors.length} errorRate=${(
        (errors.length / Math.max(1, all.length)) *
        100
      ).toFixed(1)}%`,
    )
    log(`tts.text final ms: p50=${pctl(ttsText, 50).toFixed(0)} p95=${pctl(ttsText, 95).toFixed(0)} (n=${ttsText.length})`)
    log(
      `first tts.audio ms: p50=${pctl(firstAudio, 50).toFixed(0)} p95=${pctl(firstAudio, 95).toFixed(0)} (n=${firstAudio.length})`,
    )
    log(`turn total ms: p50=${pctl(total, 50).toFixed(0)} p95=${pctl(total, 95).toFixed(0)} (n=${total.length})`)
    log(`interrupt ms: p50=${pctl(interruptMs, 50).toFixed(0)} p95=${pctl(interruptMs, 95).toFixed(0)} (n=${interruptMs.length})`)

    const report = {
      ts: new Date().toISOString(),
      config: { wsUrl, sessions, turnsPerSession, delayMs, speakRatio, interruptProb, interruptDelayMs, turnTimeoutMs },
      summary: {
        turns: all.length,
        completed: completed.length,
        interrupted: interrupted.length,
        errors: errors.length,
        errorRate: errors.length / Math.max(1, all.length),
        ttsText: { p50: pctl(ttsText, 50), p95: pctl(ttsText, 95), n: ttsText.length },
        firstAudio: { p50: pctl(firstAudio, 50), p95: pctl(firstAudio, 95), n: firstAudio.length },
        total: { p50: pctl(total, 50), p95: pctl(total, 95), n: total.length },
        interrupt: { p50: pctl(interruptMs, 50), p95: pctl(interruptMs, 95), n: interruptMs.length },
      },
      results: all,
    }

    const outFile = path.join(ROOT, "test-results", `perf-report-${Date.now()}.json`)
    writeJson(outFile, report)
    log(`Report written: ${outFile}`)
  } finally {
    for (const p of procs.reverse()) await killProc(p.proc)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
