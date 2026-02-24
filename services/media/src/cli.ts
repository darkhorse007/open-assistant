import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import z from "zod/v4"
import { openMediaDb, type MediaAssetRow } from "./db"
import { inferTypeFromExt, toAssetId } from "./ingest"

const Args = z.object({
  cmd: z.literal("ingest"),
  dir: z.string().min(1),
  tenant: z.string().min(1).default("default"),
  project: z.string().min(1).default("open-assistant"),
  dbPath: z.string().default(fileURLToPath(new URL("../data/media.sqlite", import.meta.url))),
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd !== "ingest") {
    // eslint-disable-next-line no-console
    console.error("Usage: bun src/cli.ts ingest --dir <path> [--tenant t] [--project p] [--dbPath path]")
    process.exit(2)
  }

  const dir = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : ""
  const tenant = argv.includes("--tenant") ? argv[argv.indexOf("--tenant") + 1] : undefined
  const project = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : undefined
  const dbPath = argv.includes("--dbPath") ? argv[argv.indexOf("--dbPath") + 1] : undefined

  const args = Args.parse({ cmd: "ingest", dir, tenant, project, dbPath })

  const db = openMediaDb(args.dbPath)
  db.ensureSchema()

  const absDir = path.resolve(args.dir)
  const files = walk(absDir)

  let upserted = 0
  for (const file of files) {
    const type = inferTypeFromExt(file)
    if (!type) continue
    const rel = path.relative(absDir, file)
    const assetId = toAssetId(rel)
    const title = path.basename(file)
    const asset: MediaAssetRow = {
      assetId,
      tenant: args.tenant,
      project: args.project,
      type,
      status: "approved",
      title,
      tagsJson: null,
      sourceType: "local",
      source: file,
      createdAt: Date.now(),
    }
    db.upsertAsset(asset)
    upserted++
  }

  db.close()
  // eslint-disable-next-line no-console
  console.log(`Ingested ${upserted} assets into ${args.dbPath}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
