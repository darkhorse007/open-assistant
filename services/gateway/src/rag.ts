import { Mcp } from "@open-assistant/protocol"

type RagConfig = {
  baseUrl: string
}

function makeUrl(baseUrl: string, path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\//, ""), base)
}

export async function health(cfg: RagConfig, opts?: { signal?: AbortSignal }) {
  const res = await fetch(makeUrl(cfg.baseUrl, "/healthz"), { method: "GET", signal: opts?.signal })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`RAG health failed: ${res.status} ${res.statusText} ${text}`)
  }
}

export async function search(cfg: RagConfig, input: Mcp.RagSearchInput, opts?: { signal?: AbortSignal }) {
  const res = await fetch(makeUrl(cfg.baseUrl, "/search"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: opts?.signal,
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`RAG search failed: ${res.status} ${res.statusText} ${text}`)
  }
  return Mcp.RagSearchOutput.parse(await res.json())
}

