import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"

type Action = "bundle" | "images" | "volumes" | "manifest"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DOCKER_BIN = Bun.which("docker") ?? "docker"

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

function usage() {
  log(
    [
      "Usage:",
      "  bun scripts/offline-bundle.ts [bundle|images|volumes|manifest]",
      "",
      "Env:",
      "  OA_BUNDLE_COMPOSE_MODE=prod|dev    (default: prod)",
      "  OA_BUNDLE_GPU=1                    (default: 0)",
      "  OA_BUNDLE_OUT_DIR=<path>           (default: ./offline-bundle/<timestamp>)",
      "  OA_BUNDLE_DRY_RUN=1                (default: 0)",
    ].join("\n"),
  )
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowStamp() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function run(cmd: string[], opts: { cwd: string; capture?: boolean }) {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: opts.capture ? "pipe" : "inherit",
    stderr: opts.capture ? "pipe" : "inherit",
    env: process.env,
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    opts.capture ? new Response(proc.stdout).text() : Promise.resolve(""),
    opts.capture ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  if (code !== 0) {
    const detail = opts.capture ? `\n${stderr || stdout}` : ""
    throw new Error(`Command failed (${code}): ${cmd.join(" ")}${detail}`)
  }
  return { stdout, stderr }
}

function composeFiles(opts: { composeMode: "prod" | "dev"; useGpu: boolean }) {
  const files = [path.join("infra", "docker-compose.full.yml")]
  if (opts.composeMode === "prod") files.push(path.join("infra", "docker-compose.prod.yml"))
  if (opts.useGpu) files.push(path.join("infra", "docker-compose.gpu.yml"))
  return files
}

async function composeConfigJson(files: string[]) {
  const args: string[] = ["compose"]
  for (const f of files) args.push("-f", f)
  args.push("config", "--format", "json")
  const { stdout } = await run([DOCKER_BIN, ...args], { cwd: ROOT, capture: true })
  return JSON.parse(stdout) as any
}

async function composeImages(files: string[]) {
  const args: string[] = ["compose"]
  for (const f of files) args.push("-f", f)
  args.push("config", "--images")
  const { stdout } = await run([DOCKER_BIN, ...args], { cwd: ROOT, capture: true })
  return stdout
    .split(/\r?\n/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function volumeExists(name: string) {
  const proc = Bun.spawn([DOCKER_BIN, "volume", "inspect", name], { stdout: "ignore", stderr: "ignore" })
  const code = await proc.exited
  return code === 0
}

function writeText(filePath: string, text: string) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, text, "utf8")
}

function writeJson(filePath: string, obj: unknown) {
  writeText(filePath, JSON.stringify(obj, null, 2) + "\n")
}

async function main() {
  const raw = (process.argv[2] ?? "bundle").toLowerCase()
  const action: Action = raw === "bundle" || raw === "images" || raw === "volumes" || raw === "manifest" ? raw : "bundle"
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage()
    return
  }

  const composeMode = (process.env.OA_BUNDLE_COMPOSE_MODE ?? "prod").toLowerCase() === "dev" ? "dev" : "prod"
  const useGpu = process.env.OA_BUNDLE_GPU === "1"
  const dryRun = process.env.OA_BUNDLE_DRY_RUN === "1"

  const outDir = path.resolve(process.env.OA_BUNDLE_OUT_DIR ?? path.join(ROOT, "offline-bundle", nowStamp()))
  const outImages = path.join(outDir, "images")
  const outVolumes = path.join(outDir, "volumes")
  const outFiles = path.join(outDir, "files")

  ensureDir(outDir)
  ensureDir(outImages)
  ensureDir(outVolumes)
  ensureDir(outFiles)

  const files = composeFiles({ composeMode, useGpu })
  log(`Compose files: ${files.join(", ")}`)

  const config = await composeConfigJson(files)
  const images = Array.from(new Set(await composeImages(files))).sort()

  const volumes = Object.values<any>(config?.volumes ?? {})
    .map((v) => String(v?.name ?? "").trim())
    .filter(Boolean)
    .sort()

  const funasrModelsHostPath = (() => {
    const mounts = (config?.services?.funasr?.volumes ?? []) as any[]
    for (const m of mounts) {
      if (m?.type !== "bind") continue
      if (m?.target !== "/workspace/models") continue
      if (typeof m?.source === "string" && m.source.trim()) return m.source.trim()
    }
    return undefined
  })()

  const manifest = {
    generatedAt: new Date().toISOString(),
    compose: { mode: composeMode, gpu: useGpu, files },
    images,
    volumes,
    bindMounts: funasrModelsHostPath ? [{ purpose: "funasr_models", hostPath: funasrModelsHostPath, containerPath: "/workspace/models" }] : [],
    notes: [
      "This bundle is intended for init-online -> prod-offline workflows.",
      "If you rebuild images or re-download models, re-run this bundler to refresh the archives.",
    ],
  }
  writeJson(path.join(outDir, "manifest.json"), manifest)

  // Copy infra directory for convenience (compose/prom/grafana configs, etc).
  // We do not copy large FunASR model files here; they are exported via tar if present.
  const srcInfra = path.join(ROOT, "infra")
  const dstInfra = path.join(outFiles, "infra")
  try {
    fs.cpSync(srcInfra, dstInfra, {
      recursive: true,
      filter: (src) => {
        const norm = src.replaceAll("\\", "/")
        if (norm.endsWith("/infra/funasr-runtime-resources/models")) return false
        return true
      },
    })
  } catch {
    // ignore
  }

  const restorePs1 = [
    "$ErrorActionPreference = 'Stop'",
    "$Root = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "",
    "Write-Host \"Loading Docker images...\"",
    "docker load -i (Join-Path $Root 'images\\images.tar')",
    "",
    "Write-Host \"Restoring named volumes...\"",
    ...volumes.flatMap((v) => [
      `docker volume create ${v} | Out-Null`,
      `docker run --rm -v ${v}:/data -v \"$Root:/bundle\" ${images.find((i) => i.includes("funasr_repo/funasr")) ?? images[0] ?? "alpine:3.20"} ` +
        `bash -lc \"test -f /bundle/volumes/${v}.tar.gz && tar -xzf /bundle/volumes/${v}.tar.gz -C /data || true\"`,
    ]),
    "",
    funasrModelsHostPath
      ? [
          "Write-Host \"Restoring FunASR model bind-mount dir (host)...\"",
          `New-Item -ItemType Directory -Force -Path \"${funasrModelsHostPath}\" | Out-Null`,
          `docker run --rm -v \"${funasrModelsHostPath}:/data\" -v \"$Root:/bundle\" ${images.find((i) => i.includes("funasr_repo/funasr")) ?? images[0] ?? "alpine:3.20"} ` +
            `bash -lc \"test -f /bundle/volumes/funasr-models.tar.gz && tar -xzf /bundle/volumes/funasr-models.tar.gz -C /data || true\"`,
        ].join("\n")
      : "",
    "",
    "Write-Host \"Done. Start the stack from the repo (recommended):\"",
    "Write-Host \"  cd open-assistant\"",
    "Write-Host \"  docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.prod.yml up -d\"",
    "",
  ]
    .filter((s) => s !== "")
    .join("\n")
  writeText(path.join(outDir, "restore.ps1"), restorePs1 + "\n")

  if (action === "manifest") {
    log(`Wrote ${path.join(outDir, "manifest.json")}`)
    log(`Wrote ${path.join(outDir, "restore.ps1")}`)
    return
  }

  if (action === "images" || action === "bundle") {
    const outTar = path.join(outImages, "images.tar")
    log(`Images: ${images.length}`)
    if (dryRun) {
      log(`[dry-run] docker image save -o ${outTar} ${images.join(" ")}`)
    } else {
      await run([DOCKER_BIN, "image", "save", "-o", outTar, ...images], { cwd: ROOT })
    }
  }

  if (action === "volumes" || action === "bundle") {
    const utilImage =
      images.find((i) => i.includes("funasr_repo/funasr")) ??
      images.find((i) => i.includes("openassistant-app")) ??
      images[0] ??
      "alpine:3.20"

    log(`Volumes: ${volumes.length}`)
    for (const v of volumes) {
      const outTarGz = path.join(outVolumes, `${v}.tar.gz`)
      const exists = await volumeExists(v)
      if (!exists) {
        log(`- skip missing volume: ${v}`)
        continue
      }
      if (dryRun) {
        log(`[dry-run] docker run --rm -v ${v}:/data -v ${outVolumes}:/out ${utilImage} bash -lc "tar -czf /out/${v}.tar.gz -C /data ."`)
        continue
      }
      log(`- export volume: ${v}`)
      await run([DOCKER_BIN, "run", "--rm", "-v", `${v}:/data`, "-v", `${outVolumes}:/out`, utilImage, "bash", "-lc", `tar -czf /out/${v}.tar.gz -C /data .`], {
        cwd: ROOT,
      })
      if (fs.existsSync(outTarGz)) {
        const mb = (fs.statSync(outTarGz).size / (1024 * 1024)).toFixed(1)
        log(`  -> ${path.basename(outTarGz)} (${mb} MiB)`)
      }
    }

    if (funasrModelsHostPath && fs.existsSync(funasrModelsHostPath)) {
      const outTarGz = path.join(outVolumes, "funasr-models.tar.gz")
      if (dryRun) {
        log(`[dry-run] docker run --rm -v ${funasrModelsHostPath}:/data -v ${outVolumes}:/out ${utilImage} bash -lc "tar -czf /out/funasr-models.tar.gz -C /data ."`)
      } else {
        log(`- export bind-mount dir: ${funasrModelsHostPath}`)
        await run(
          [DOCKER_BIN, "run", "--rm", "-v", `${funasrModelsHostPath}:/data`, "-v", `${outVolumes}:/out`, utilImage, "bash", "-lc", `tar -czf /out/funasr-models.tar.gz -C /data .`],
          { cwd: ROOT },
        )
        if (fs.existsSync(outTarGz)) {
          const mb = (fs.statSync(outTarGz).size / (1024 * 1024)).toFixed(1)
          log(`  -> ${path.basename(outTarGz)} (${mb} MiB)`)
        }
      }
    }
  }

  log(`Done: ${outDir}`)
  log(`- manifest: ${path.join(outDir, "manifest.json")}`)
  log(`- restore:  ${path.join(outDir, "restore.ps1")}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

