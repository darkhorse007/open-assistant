import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"

type Action = "up" | "perf" | "perf-asrtts" | "perf-all" | "up-perf" | "up-perf-asrtts" | "up-perf-all" | "down"
type ComposeMode = "dev" | "prod"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DOCKER_BIN = Bun.which("docker") ?? "docker"
const BUN_BIN = Bun.which("bun") ?? process.execPath

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

function ensureEnvFile() {
  const envFile = path.join(ROOT, "infra", ".env")
  if (fs.existsSync(envFile)) return

  const example = path.join(ROOT, "infra", ".env.example")
  if (!fs.existsSync(example)) return

  try {
    fs.copyFileSync(example, envFile)
    log(`Created ${envFile} from ${example}`)
    log("Edit infra/.env as needed (images, model dir, tokens).")
  } catch {
    // ignore
  }
}

function composeFiles(opts: { useGpu: boolean; composeMode: ComposeMode }) {
  const files = [path.join("infra", "docker-compose.full.yml")]
  if (opts.composeMode === "prod") files.push(path.join("infra", "docker-compose.prod.yml"))
  if (opts.useGpu) files.push(path.join("infra", "docker-compose.gpu.yml"))
  if (process.env.OA_FULL_MOCK_BACKENDS === "1") files.push(path.join("infra", "docker-compose.full.mock-backends.yml"))
  return files
}

async function runDockerCompose(args: string[], opts?: { env?: Record<string, string | undefined> }) {
  const proc = Bun.spawn([DOCKER_BIN, "compose", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: opts?.env ?? process.env,
  })
  const code = await proc.exited
  if (code !== 0) throw new Error(`docker compose failed with code ${code}`)
}

async function waitForReady(url: string, opts: { timeoutMs: number }) {
  const started = Date.now()
  let lastLogAt = 0

  while (Date.now() - started < opts.timeoutMs) {
    try {
      const res = await fetch(url)
      const text = await res.text().catch(() => "")
      let json: any = undefined
      try {
        json = text ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }

      if (res.ok && json?.ok === true) return

      const now = Date.now()
      if (now - lastLogAt > 5000) {
        lastLogAt = now
        if (json?.checks && typeof json.checks === "object") {
          const parts: string[] = []
          for (const [k, v] of Object.entries(json.checks)) {
            const ok = (v as any)?.ok === true ? "ok" : "bad"
            const detail = typeof (v as any)?.detail === "string" ? `: ${(v as any).detail}` : ""
            parts.push(`${k}=${ok}${detail}`)
          }
          log(`Waiting for readyz: ${parts.join(" | ")}`)
        } else {
          log(`Waiting for readyz: HTTP ${res.status}`)
        }
      }
    } catch {
      const now = Date.now()
      if (now - lastLogAt > 5000) {
        lastLogAt = now
        log("Waiting for readyz: connect error")
      }
    }

    await sleep(1000)
  }

  throw new Error(`Timed out waiting for readyz: ${url}`)
}

async function runPerf() {
  const env: Record<string, string | undefined> = { ...process.env }
  env.OA_PERF_SPAWN_STACK = "0"
  // Default to Gateway's direct WS port when running on the same host.
  env.OA_PERF_GATEWAY_WS_URL = env.OA_PERF_GATEWAY_WS_URL ?? "ws://127.0.0.1:7001/ws"
  if (!env.OA_PERF_TURN_TIMEOUT_MS) {
    env.OA_PERF_TURN_TIMEOUT_MS = process.env.OA_FULL_MOCK_BACKENDS === "1" ? "45000" : "300000"
  }

  const proc = Bun.spawn([BUN_BIN, "run", "perf:10"], { cwd: ROOT, stdout: "inherit", stderr: "inherit", env })
  const code = await proc.exited
  if (code !== 0) throw new Error(`perf:10 failed with code ${code}`)
}

async function runPerfAsrtts() {
  const env: Record<string, string | undefined> = { ...process.env }
  env.OA_PERF_SPAWN_STACK = "0"
  // Default to Gateway's direct WS port when running on the same host.
  env.OA_PERF_GATEWAY_WS_URL = env.OA_PERF_GATEWAY_WS_URL ?? "ws://127.0.0.1:7001/ws"
  if (!env.OA_PERF_TURN_TIMEOUT_MS) {
    env.OA_PERF_TURN_TIMEOUT_MS = process.env.OA_FULL_MOCK_BACKENDS === "1" ? "45000" : "300000"
  }

  const proc = Bun.spawn([BUN_BIN, "run", "perf:asrtts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit", env })
  const code = await proc.exited
  if (code !== 0) throw new Error(`perf:asrtts failed with code ${code}`)
}

async function main() {
  const raw = process.argv[2]
  const action: Action =
    raw === "up" ||
    raw === "perf" ||
    raw === "perf-asrtts" ||
    raw === "perf-all" ||
    raw === "up-perf" ||
    raw === "up-perf-asrtts" ||
    raw === "up-perf-all" ||
    raw === "down"
      ? raw
      : "up-perf"

  const useGpu = process.env.OA_FULL_GPU === "1"
  const composeModeRaw = (process.env.OA_FULL_COMPOSE_MODE ?? "dev").toLowerCase()
  const composeMode: ComposeMode = composeModeRaw === "prod" ? "prod" : "dev"
  const buildBeforeUp = process.env.OA_FULL_BUILD === "1"
  const pullPolicyRaw = (process.env.OA_FULL_PULL ?? "").trim().toLowerCase()
  const pullPolicy: "always" | "missing" | "never" | undefined =
    pullPolicyRaw === "always" || pullPolicyRaw === "missing" || pullPolicyRaw === "never"
      ? pullPolicyRaw
      : composeMode === "prod" && !buildBeforeUp
        ? "never"
        : undefined
  const noBuild =
    process.env.OA_FULL_NO_BUILD === "1" ||
    // In prod mode, keep runtime stable in offline environments by default:
    // - no accidental rebuild when the baked images are missing/outdated
    // - no base image pulls during build (since we're not building here)
    (composeMode === "prod" && !buildBeforeUp)
  const llmMode = (process.env.OA_FULL_LLM_MODE ?? "mock") as "mock" | "opencode"
  const downAfter = process.env.OA_FULL_DOWN_AFTER === "1"
  const readyUrl = process.env.OA_FULL_READY_URL ?? "http://127.0.0.1:7001/readyz"
  const timeoutMs = Number(process.env.OA_FULL_READY_TIMEOUT_MS ?? "1200000") // 20min

  ensureEnvFile()

  const files = composeFiles({ useGpu, composeMode })
  const fileArgs: string[] = []
  for (const f of files) fileArgs.push("-f", f)

  const envForCompose: Record<string, string | undefined> = { ...process.env }
  envForCompose.OA_LLM_MODE = llmMode
  if (llmMode === "mock") envForCompose.OA_OPENCODE_EVENTS_MODE = "disabled"

  if (action === "down") {
    log(`docker compose down (${files.join(", ")})…`)
    await runDockerCompose([...fileArgs, "down"], { env: envForCompose })
    return
  }

  if (action === "up" || action === "up-perf" || action === "up-perf-asrtts" || action === "up-perf-all") {
    if (buildBeforeUp) {
      log(`docker compose build (${files.join(", ")})…`)
      await runDockerCompose([...fileArgs, "build"], { env: envForCompose })
    }
    log(`docker compose up -d (${files.join(", ")})…`)
    const upArgs = [...fileArgs, "up", "-d"]
    if (pullPolicy) upArgs.push("--pull", pullPolicy)
    if (noBuild) upArgs.push("--no-build")
    await runDockerCompose(upArgs, { env: envForCompose })
  }

  log(`Waiting for Gateway readyz: ${readyUrl} …`)
  await waitForReady(readyUrl, { timeoutMs })
  log("✓ readyz OK")

  if (action === "perf" || action === "up-perf") {
    log("Running perf:10 …")
    await runPerf()
  } else if (action === "perf-asrtts" || action === "up-perf-asrtts") {
    log("Running perf:asrtts …")
    await runPerfAsrtts()
  } else if (action === "perf-all" || action === "up-perf-all") {
    log("Running perf:10 …")
    await runPerf()
    log("Running perf:asrtts …")
    await runPerfAsrtts()
  }

  if (downAfter) {
    log("Bringing stack down (OA_FULL_DOWN_AFTER=1)…")
    await runDockerCompose([...fileArgs, "down"], { env: envForCompose })
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
