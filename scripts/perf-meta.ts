import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const STACK_ENV_KEYS = [
  "OA_AUTH_MODE",
  "OA_AUTH_TAGS_MODE",
  "OA_OIDC_ISSUER",
  "OA_OIDC_AUDIENCE",
  "OA_OIDC_REQUIRE_TENANT_PROJECT",
  "OA_OIDC_REQUIRE_TAGS",
  "OA_AUTH_SUB_CLAIM",
  "OA_AUTH_TENANT_CLAIM",
  "OA_AUTH_PROJECT_CLAIM",
  "OA_AUTH_TAGS_CLAIM",

  "OA_ASR_MODE",
  "OA_TTS_MODE",
  "OA_MEDIA_MODE",
  "OA_RAG_MODE",
  "OA_LLM_MODE",
  "OA_OPENCODE_EVENTS_MODE",

  "OA_GW_MAX_SESSIONS",
  "OA_GW_TURN_TIMEOUT_MS",
  "OA_GW_ASR_MAX_CONCURRENT_DECODE",
  "OA_GW_ASR_QUEUE_MAX_FRAMES",
  "OA_GW_ASR_IDLE_RELEASE_MS",
  "OA_GW_TTS_MAX_CONCURRENT_SYNTHESIS",
  "OA_GW_TTS_SEGMENT_MAX_CHARS",
] as const

export function sanitizeRunId(raw: string) {
  const trimmed = raw.trim()
  const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_")
  const limited = cleaned.slice(0, 96)
  return limited || String(Date.now())
}

function captureStdout(cmd: string[], cwd: string) {
  try {
    const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode !== 0) return undefined
    return new TextDecoder().decode(proc.stdout).trim()
  } catch {
    return undefined
  }
}

function getRepoRoot() {
  return fileURLToPath(new URL("..", import.meta.url))
}

function collectGitInfo(repoRoot: string) {
  const gitDir = path.join(repoRoot, ".git")
  if (!fs.existsSync(gitDir)) return undefined

  const commit = captureStdout(["git", "rev-parse", "HEAD"], repoRoot)
  const branch = captureStdout(["git", "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
  const describe = captureStdout(["git", "describe", "--always", "--dirty"], repoRoot)
  const status = captureStdout(["git", "status", "--porcelain"], repoRoot)
  const dirty = typeof status === "string" ? Boolean(status.trim()) : undefined

  if (!commit && !branch && !describe && dirty === undefined) return undefined
  return { commit, branch, describe, dirty }
}

export function pickStackEnv(env: Record<string, string | undefined>) {
  const out: Record<string, string> = {}
  for (const key of STACK_ENV_KEYS) {
    const v = env[key]
    if (typeof v !== "string") continue
    const s = v.trim()
    if (!s) continue
    out[key] = s
  }
  return out
}

export function collectPerfMeta(opts: { runId: string; env?: Record<string, string | undefined> }) {
  const env = opts.env ?? process.env
  const repoRoot = getRepoRoot()

  const buildVersion = (env.OA_BUILD_VERSION ?? env.OA_VERSION ?? "").trim() || undefined
  const buildSha = (env.OA_BUILD_SHA ?? env.GITHUB_SHA ?? "").trim() || undefined

  return {
    runId: opts.runId,
    generatedAt: new Date().toISOString(),
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
    },
    host: {
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    },
    version: {
      buildVersion,
      buildSha,
      git: collectGitInfo(repoRoot),
    },
    stack: pickStackEnv(env),
  }
}

