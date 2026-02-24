import crypto from "node:crypto"
import path from "node:path"
import type { MediaAssetType } from "./db"

export function inferTypeFromExt(filePath: string): MediaAssetType | undefined {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".mp4" || ext === ".webm") return "video"
  if (ext === ".pdf" || ext === ".html" || ext === ".htm") return "slides"
  if (ext === ".glb" || ext === ".gltf") return "model"
  return undefined
}

export function toAssetId(input: string) {
  const base = input
    .replaceAll("\\\\", "/")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
  const hash = crypto.createHash("sha1").update(input).digest("hex").slice(0, 8)
  const short = base.split("/").pop() ?? base
  const slug = short.replace(/\.[a-z0-9]+$/i, "")
  return `${slug}-${hash}`.slice(0, 128)
}

