import { fileURLToPath } from "node:url"
import path from "node:path"
import { sanitizeRunId } from "./perf-meta"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BUN_BIN = Bun.which("bun") ?? process.execPath

function readBool(name: string, defaultValue: boolean) {
  const raw = process.env[name]
  if (typeof raw !== "string") return defaultValue
  const s = raw.trim().toLowerCase()
  if (!s) return defaultValue
  return !(s === "0" || s === "false" || s === "no" || s === "off")
}

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

async function runStep(name: string, script: string, env?: Record<string, string | undefined>) {
  log(`Running ${name} (${script}) ...`)
  const proc = Bun.spawn([BUN_BIN, "run", script], {
    cwd: ROOT,
    env: { ...process.env, ...(env ?? {}) },
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = (await proc.exited) ?? 1
  if (code !== 0) throw new Error(`${name} failed with exit code ${code}`)
}

async function main() {
  const runId = sanitizeRunId(process.env.OA_GATE_RUN_ID ?? String(Date.now()))
  const skipE2E = readBool("OA_GATE_SKIP_E2E", false)
  const rc23OutputFile =
    process.env.OA_RC23_OUTPUT_FILE?.trim() ||
    path.join(ROOT, "test-results", `rc2-rc3-negative-gate-${runId}.log`)

  log(`Release gate runId=${runId}`)

  await runStep("Typecheck", "typecheck")
  await runStep("RC2/RC3 negative checks", "test:rc2rc3", {
    OA_RC23_OUTPUT_FILE: rc23OutputFile,
  })

  if (skipE2E) {
    log("Skipping E2E because OA_GATE_SKIP_E2E=1")
  } else {
    await runStep("E2E (mock stack)", "test:e2e")
  }

  log("Release gate passed.")
  log(`RC2/RC3 evidence: ${rc23OutputFile}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
