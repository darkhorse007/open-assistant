import { Mcp } from "@open-assistant/protocol"

type MediaConfig = {
  baseUrl: string
}

function makeUrl(baseUrl: string, path: string) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\//, ""), base)
}

export async function health(cfg: MediaConfig, opts?: { signal?: AbortSignal }) {
  const res = await fetch(makeUrl(cfg.baseUrl, "/healthz"), { method: "GET", signal: opts?.signal })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Media health failed: ${res.status} ${res.statusText} ${text}`)
  }
}

export async function assetSearch(cfg: MediaConfig, input: Mcp.AssetSearchInput, opts?: { signal?: AbortSignal }) {
  const res = await fetch(makeUrl(cfg.baseUrl, "/asset/search"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: opts?.signal,
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Media asset.search failed: ${res.status} ${res.statusText} ${text}`)
  }
  return Mcp.AssetSearchOutput.parse(await res.json())
}

export async function assetExists(
  cfg: MediaConfig,
  assetId: string,
  filters?: { tenant: string; project: string; tags?: string[] },
  opts?: { signal?: AbortSignal },
) {
  const out = await assetSearch(cfg, { query: assetId, topK: 20, filters }, opts)
  return out.assets.some((a) => a.assetId === assetId)
}

export async function assetGet(
  cfg: MediaConfig,
  assetId: string,
  filters?: { tenant: string; project: string; tags?: string[] },
  opts?: { signal?: AbortSignal },
) {
  const out = await assetSearch(cfg, { query: assetId, topK: 20, filters }, opts)
  return out.assets.find((a) => a.assetId === assetId)
}
