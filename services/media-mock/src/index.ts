import { Hono } from "hono"
import { Mcp } from "@open-assistant/protocol"
import { fileURLToPath } from "node:url"
import path from "node:path"
import z from "zod/v4"

const Env = z.object({
  OA_MEDIA_MOCK_HOST: z.string().default("0.0.0.0"),
  OA_MEDIA_MOCK_PORT: z.coerce.number().int().positive().default(7004),
  OA_MEDIA_MOCK_ASSETS_DIR: z.string().optional(),
  OA_MEDIA_MOCK_DEMO_VIDEO_FILE: z.string().optional(),
  OA_MEDIA_MOCK_DEMO_SLIDES_FILE: z.string().optional(),
  OA_MEDIA_MOCK_DEMO_MODEL_FILE: z.string().optional(),
})

const env = Env.parse(process.env)

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../assets", import.meta.url))
const assetsDir = env.OA_MEDIA_MOCK_ASSETS_DIR ?? DEFAULT_ASSETS_DIR
const demoVideoFile = env.OA_MEDIA_MOCK_DEMO_VIDEO_FILE ?? path.join(assetsDir, "demo.mp4")
const demoSlidesFile = env.OA_MEDIA_MOCK_DEMO_SLIDES_FILE ?? path.join(assetsDir, "demo-slides.html")
const demoModelFile = env.OA_MEDIA_MOCK_DEMO_MODEL_FILE ?? path.join(assetsDir, "demo-model.gltf")

const assets: Mcp.AssetSearchOutput["assets"] = [
  {
    assetId: "demo-video",
    type: "video",
    title: "Demo Video (mock)",
    tags: ["demo"],
  },
  {
    assetId: "demo-slides",
    type: "slides",
    title: "Demo Slides (mock)",
    tags: ["demo"],
  },
  {
    assetId: "demo-model",
    type: "model",
    title: "Demo Model (mock)",
    tags: ["demo"],
  },
  {
    assetId: "private-video",
    type: "video",
    title: "Private Video (mock)",
    tags: ["finance"],
  },
]

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))

app.post("/asset/search", async (c) => {
  const input = Mcp.AssetSearchInput.parse(await c.req.json().catch(() => ({})))
  const q = input.query.trim().toLowerCase()

  const tags = Array.from(
    new Set(
      (input.filters?.tags ?? [])
        .filter((t) => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  )

  const filtered = assets
    .filter((a) => (input.type ? a.type === input.type : true))
    .filter((a) => (tags.length ? tags.some((t) => (a.tags ?? []).includes(t)) : true))
    .filter((a) => {
      if (!q) return true
      return (a.title ?? "").toLowerCase().includes(q) || a.assetId.toLowerCase().includes(q)
    })
    .slice(0, input.topK)

  return c.json({ assets: filtered })
})

function parseRange(range: string | null, size: number): { start: number; end: number } | undefined | null {
  if (!range) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (!m) return null
  const startRaw = m[1]
  const endRaw = m[2]

  const hasStart = startRaw !== ""
  const hasEnd = endRaw !== ""

  if (!hasStart && !hasEnd) return null

  if (!hasStart && hasEnd) {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isFinite(start) || start < 0) return null

  const end = hasEnd ? Number(endRaw) : size - 1
  if (!Number.isFinite(end) || end < start) return null

  const clampedEnd = Math.min(size - 1, end)
  if (start > clampedEnd) return null
  return { start, end: clampedEnd }
}

function serveFile(req: Request, filePath: string, contentType: string): Response {
  const file = Bun.file(filePath)
  const size = file.size
  if (!Number.isFinite(size) || size <= 0) {
    return new Response(JSON.stringify({ ok: false, error: "asset_missing" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })
  }

  const headers = new Headers()
  headers.set("content-type", contentType)
  headers.set("accept-ranges", "bytes")
  headers.set("cache-control", "no-store")

  const rangeHeader = req.headers.get("range")
  const range = parseRange(rangeHeader, size)
  if (rangeHeader && range === null) {
    headers.set("content-range", `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  if (!range) {
    headers.set("content-length", String(size))
    return new Response(req.method === "HEAD" ? null : file, { status: 200, headers })
  }

  const { start, end } = range
  const chunk = file.slice(start, end + 1)
  headers.set("content-range", `bytes ${start}-${end}/${size}`)
  headers.set("content-length", String(end - start + 1))
  return new Response(req.method === "HEAD" ? null : chunk, { status: 206, headers })
}

app.get("/assets/:assetId", (c) => {
  const assetId = c.req.param("assetId") ?? ""
  if (!assets.some((a) => a.assetId === assetId)) return c.json({ ok: false, error: "not_found" }, 404)
  if (assetId === "demo-video") return serveFile(c.req.raw, demoVideoFile, "video/mp4")
  if (assetId === "private-video") return serveFile(c.req.raw, demoVideoFile, "video/mp4")
  if (assetId === "demo-slides") return serveFile(c.req.raw, demoSlidesFile, "text/html; charset=utf-8")
  if (assetId === "demo-model") return serveFile(c.req.raw, demoModelFile, "model/gltf+json")
  return c.json({ ok: false, error: "not_supported" }, 404)
})

app.on("HEAD", "/assets/:assetId", (c) => {
  const assetId = c.req.param("assetId") ?? ""
  if (!assets.some((a) => a.assetId === assetId)) return c.json({ ok: false, error: "not_found" }, 404)
  if (assetId === "demo-video") return serveFile(c.req.raw, demoVideoFile, "video/mp4")
  if (assetId === "private-video") return serveFile(c.req.raw, demoVideoFile, "video/mp4")
  if (assetId === "demo-slides") return serveFile(c.req.raw, demoSlidesFile, "text/html; charset=utf-8")
  if (assetId === "demo-model") return serveFile(c.req.raw, demoModelFile, "model/gltf+json")
  return c.json({ ok: false, error: "not_supported" }, 404)
})

const server = Bun.serve({
  hostname: env.OA_MEDIA_MOCK_HOST,
  port: env.OA_MEDIA_MOCK_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-media-mock listening on ${server.url}`)
