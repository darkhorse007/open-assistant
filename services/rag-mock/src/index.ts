import { Hono } from "hono"
import { Mcp } from "@open-assistant/protocol"
import z from "zod/v4"

const Env = z.object({
  OA_RAG_MOCK_HOST: z.string().default("0.0.0.0"),
  OA_RAG_MOCK_PORT: z.coerce.number().int().positive().default(7005),
})

const env = Env.parse(process.env)

const app = new Hono()

app.get("/healthz", (c) => c.json({ ok: true }))

app.post("/search", async (c) => {
  const input = Mcp.RagSearchInput.parse(await c.req.json().catch(() => ({})))
  const tenant = input.filters?.tenant ?? "default"
  const project = input.filters?.project ?? "default"

  const requestedTags = Array.from(
    new Set(
      (input.filters?.tags ?? [])
        .filter((t) => typeof t === "string")
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  )

  const corpus: Array<Mcp.RagSearchOutput["passages"][number] & { tags?: string[] }> = [
    {
      text: `（mock）与“${input.query}”相关的片段 A；tenant=${tenant}; project=${project}`,
      sourceId: "mock:passage:A",
      score: 0.93,
      meta: { tenant, project, tags: ["demo"] },
      tags: ["demo"],
    },
    {
      text: `（mock）与“${input.query}”相关的片段 B（用于占位验证 RAG->prompt 注入）`,
      sourceId: "mock:passage:B",
      score: 0.84,
      meta: { tenant, project, tags: ["finance"] },
      tags: ["finance"],
    },
  ]

  const filtered = corpus
    .filter((p) => (requestedTags.length ? requestedTags.some((t) => (p.tags ?? []).includes(t)) : true))
    .slice(0, input.topK)

  const passages: Mcp.RagSearchOutput["passages"] = filtered.map(({ tags: _tags, ...p }) => p)

  return c.json({ passages })
})

const server = Bun.serve({
  hostname: env.OA_RAG_MOCK_HOST,
  port: env.OA_RAG_MOCK_PORT,
  fetch: app.fetch,
})

console.log(`open-assistant-rag-mock listening on ${server.url}`)
