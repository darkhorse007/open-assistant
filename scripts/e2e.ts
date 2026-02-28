import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

type Proc = ReturnType<typeof Bun.spawn>

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BUN_BIN = Bun.which("bun") ?? process.execPath
const PLAYWRIGHT_BIN = (() => {
  const fromPath = Bun.which("playwright")
  if (fromPath) return fromPath

  const base = fileURLToPath(new URL("../node_modules/.bin/playwright", import.meta.url))
  const candidates =
    process.platform === "win32"
      ? [`${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.bunx`]
      : [base, `${base}.bunx`]

  for (const c of candidates) {
    if (existsSync(c)) return c
  }

  return "playwright"
})()
const expectedExit = new Set<number>()
const DEFAULT_E2E_AUTH_TOKEN = "e2e-auth-token"
const DEFAULT_E2E_MCP_TOKEN = "e2e-mcp-token"

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
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

function spawn(name: string, cmd: string[], cwd: string, env?: Record<string, string | undefined>) {
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

async function kill(proc: Proc) {
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

async function main() {
  const procs: Array<{ name: string; proc: Proc }> = []
  const e2eAuthMode = (process.env.OA_E2E_AUTH_MODE ?? "static").trim() as "disabled" | "static" | "oidc"
  const e2eAuthToken = (process.env.OA_E2E_AUTH_TOKEN ?? DEFAULT_E2E_AUTH_TOKEN).trim()
  const e2eMcpToken = (process.env.OA_E2E_MCP_TOKEN ?? DEFAULT_E2E_MCP_TOKEN).trim()
  const gatewayBaseUrl = (process.env.OA_E2E_GATEWAY_BASE_URL ?? "http://127.0.0.1:7001").trim().replace(/\/+$/, "")

  try {
    log(`Starting stack (mocks + gateway + web)… auth=${e2eAuthMode}`)

    const asr = spawn("asr-mock", [BUN_BIN, "run", "dev:asr"], ROOT)
    procs.push({ name: "asr-mock", proc: asr })
    await waitForHttp("http://127.0.0.1:7002/healthz", { timeoutMs: 20_000 })

    const tts = spawn("tts-mock", [BUN_BIN, "run", "dev:tts"], ROOT)
    procs.push({ name: "tts-mock", proc: tts })
    await waitForHttp("http://127.0.0.1:7003/healthz", { timeoutMs: 20_000 })

    const media = spawn("media-mock", [BUN_BIN, "run", "dev:media:mock"], ROOT)
    procs.push({ name: "media-mock", proc: media })
    await waitForHttp("http://127.0.0.1:7004/healthz", { timeoutMs: 20_000 })

    const rag = spawn("rag-mock", [BUN_BIN, "run", "dev:rag:mock"], ROOT)
    procs.push({ name: "rag-mock", proc: rag })
    await waitForHttp("http://127.0.0.1:7005/healthz", { timeoutMs: 20_000 })

    const gwEnv: Record<string, string | undefined> = {
      ...process.env,
      OA_LLM_MODE: "mock",
      OA_AUTH_MODE: e2eAuthMode,
      OA_AUTH_TOKEN: e2eAuthMode === "static" ? e2eAuthToken : process.env.OA_AUTH_TOKEN,
      OA_OPENCODE_MCP_TOKEN: e2eMcpToken,
    }
    if (e2eAuthMode === "disabled") delete gwEnv.OA_AUTH_TOKEN

    const gw = spawn("gateway", [BUN_BIN, "run", "dev:gateway"], ROOT, gwEnv)
    procs.push({ name: "gateway", proc: gw })
    await waitForHttp("http://127.0.0.1:7001/healthz", { timeoutMs: 20_000 })

    const web = spawn("web", [BUN_BIN, "run", "dev:web"], ROOT, {
      ...process.env,
      VITE_OA_TOKEN: e2eAuthMode === "static" ? e2eAuthToken : process.env.VITE_OA_TOKEN,
    })
    procs.push({ name: "web", proc: web })
    await waitForHttp("http://127.0.0.1:5173", { timeoutMs: 40_000 })

    log("Running Playwright…")
    const pw = Bun.spawn([PLAYWRIGHT_BIN, "test"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        OA_E2E_BASE_URL: "http://127.0.0.1:5173",
        OA_E2E_GATEWAY_BASE_URL: gatewayBaseUrl,
        OA_E2E_AUTH_MODE: e2eAuthMode,
        OA_E2E_AUTH_TOKEN: e2eAuthToken,
        OA_E2E_MCP_TOKEN: e2eMcpToken,
      },
    })
    const code = (await pw.exited) ?? 1
    if (code !== 0) process.exitCode = code
  } finally {
    for (const p of procs.reverse()) await kill(p.proc)
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
