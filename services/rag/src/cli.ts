import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import z from "zod/v4"
import { openRagDb } from "./db"
import { shouldIngestFileName, splitIntoChunks, sourceIdFor } from "./ingest"

const Args = z.object({
  cmd: z.literal("ingest"),
  dir: z.string().min(1),
  tenant: z.string().min(1).default("default"),
  project: z.string().min(1).default("open-assistant"),
  dbPath: z.string().default(fileURLToPath(new URL("../data/rag.sqlite", import.meta.url))),
  maxChars: z.coerce.number().int().positive().default(900),
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
    console.error("Usage: bun src/cli.ts ingest --dir <path> [--tenant t] [--project p] [--dbPath path] [--maxChars 900]")
    process.exit(2)
  }

  const dir = argv.includes("--dir") ? argv[argv.indexOf("--dir") + 1] : ""
  const tenant = argv.includes("--tenant") ? argv[argv.indexOf("--tenant") + 1] : undefined
  const project = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : undefined
  const dbPath = argv.includes("--dbPath") ? argv[argv.indexOf("--dbPath") + 1] : undefined
  const maxChars = argv.includes("--maxChars") ? argv[argv.indexOf("--maxChars") + 1] : undefined

  const args = Args.parse({ cmd: "ingest", dir, tenant, project, dbPath, maxChars })

  const db = openRagDb(args.dbPath)
  db.ensureSchema()

  const absDir = path.resolve(args.dir)
  const files = walk(absDir).filter(shouldIngestFileName)

  let upserted = 0
  for (const file of files) {
    const rel = path.relative(absDir, file)
    const metaBefore = db.getDocMeta({ tenant: args.tenant, project: args.project, file: rel })
    const status = metaBefore?.status ?? "approved"
    const tags = metaBefore?.tags ?? []

    db.deleteDoc({ tenant: args.tenant, project: args.project, file: rel })

    const content = fs.readFileSync(file, "utf8")
    const chunks = splitIntoChunks(content, args.maxChars)
    for (let i = 0; i < chunks.length; i++) {
      db.upsertPassage({
        tenant: args.tenant,
        project: args.project,
        sourceId: sourceIdFor(rel, i),
        text: chunks[i]!,
        metaJson: JSON.stringify({ file: rel, chunk: i + 1, chunks: chunks.length }),
      })
      upserted++
    }

    db.upsertDocMeta({ tenant: args.tenant, project: args.project, file: rel, status, tags })
  }

  db.close()
  // eslint-disable-next-line no-console
  console.log(`Ingested ${upserted} passages into ${args.dbPath}`)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
