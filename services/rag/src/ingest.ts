import crypto from "node:crypto"
import path from "node:path"

export function shouldIngestFileName(filePath: string) {
  const ext = path.extname(filePath).toLowerCase()
  return ext === ".txt" || ext === ".md" || ext === ".markdown"
}

export function splitIntoChunks(text: string, maxChars: number) {
  const cleaned = text.replace(/\r\n/g, "\n")
  const paras = cleaned.split(/\n{2,}/)
  const chunks: string[] = []

  let buf = ""
  const flush = () => {
    const t = buf.trim()
    if (t) chunks.push(t)
    buf = ""
  }

  for (const p of paras) {
    const para = p.trim()
    if (!para) continue
    if ((buf + "\n\n" + para).length <= maxChars) {
      buf = buf ? `${buf}\n\n${para}` : para
      continue
    }
    flush()
    if (para.length <= maxChars) {
      buf = para
      continue
    }

    // Hard split long paragraphs.
    for (let i = 0; i < para.length; i += maxChars) {
      chunks.push(para.slice(i, i + maxChars))
    }
  }
  flush()
  return chunks
}

export function sourceIdFor(relPath: string, chunkIndex: number) {
  const hash = crypto.createHash("sha1").update(relPath).digest("hex").slice(0, 10)
  const base = relPath.replaceAll("\\\\", "/")
  return `${base}#${chunkIndex + 1}:${hash}`
}

