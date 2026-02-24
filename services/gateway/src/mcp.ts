import { Mcp, Ws } from "@open-assistant/protocol"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import * as Media from "./media"
import * as Rag from "./rag"

export type McpDeps = {
  config: {
    OA_AUTH_TAGS_MODE: "disabled" | "enforce"
    OA_MEDIA_MODE: "mock" | "external" | "disabled"
    OA_MEDIA_BASE_URL: string
    OA_RAG_MODE: "mock" | "external" | "disabled"
    OA_RAG_BASE_URL: string
  }
  audit?: (event: string, fields: Record<string, unknown>) => void
  hasSession: (sessionID: string) => boolean
  getSessionScope?: (sessionID: string) => { sub?: string; tenant: string; project: string; tags?: string[] } | undefined
  getSessionTurn?: (sessionID: string) => { id: string; startedAt: number; firstAudioAt?: number } | undefined
  sendToClient: (sessionID: string, message: Ws.GatewayToClient) => void
  setClientState: (sessionID: string, state: Ws.StateValue) => void
}

function ok(structuredContent: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(structuredContent) }],
    structuredContent,
  }
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  }
}

function isInitializeBody(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body]
  return msgs.some((m) => typeof m === "object" && m !== null && "method" in m && (m as any).method === "initialize")
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  const normalized = Array.from(new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))).sort()
  return normalized.length ? normalized : undefined
}

type Runtime = {
  server: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastSeenAt: number
}

export function createMcpHandler(deps: McpDeps) {
  const runtimes = new Map<string, Runtime>()

  async function closeRuntime(runtime: Runtime | undefined) {
    if (!runtime) return
    try {
      await runtime.server.close()
    } catch {
      // ignore
    }
  }

  async function newRuntime() {
    const server = new McpServer(
      { name: "openassistant", version: "0.0.0" },
      {
        capabilities: {
          tools: {},
        },
      },
    )

    server.registerTool(
      "rag.search",
      {
        description: "RAG search (read-only).",
        inputSchema: Mcp.RagSearchInput,
        outputSchema: Mcp.RagSearchOutput,
      },
      async (input) => {
        if (deps.config.OA_RAG_MODE === "disabled") return err("RAG disabled")
        if (!input.sessionID) return err("Missing sessionID")
        if (!deps.hasSession(input.sessionID)) return err(`Unknown sessionID: ${input.sessionID}`)

        const scope = deps.getSessionScope?.(input.sessionID)
        if (!scope) return err(`Unknown sessionID: ${input.sessionID}`)

        if (input.filters?.tenant && input.filters.tenant !== scope.tenant) {
          return err(`tenant mismatch: expected ${scope.tenant}`)
        }
        if (input.filters?.project && input.filters.project !== scope.project) {
          return err(`project mismatch: expected ${scope.project}`)
        }

        const requestedTags = normalizeTags(input.filters?.tags)
        const enforceTags = deps.config.OA_AUTH_TAGS_MODE === "enforce"
        const allowedTags = normalizeTags(scope.tags)
        if (enforceTags && (!allowedTags || allowedTags.length === 0)) {
          return err("Missing permission tags in identity (OA_AUTH_TAGS_MODE=enforce)")
        }
        if (enforceTags && requestedTags && requestedTags.some((t) => !allowedTags!.includes(t))) {
          return err("tag mismatch: requested tags not allowed")
        }

        const effectiveTags = enforceTags ? (requestedTags ? requestedTags.filter((t) => allowedTags!.includes(t)) : allowedTags) : requestedTags

        const effective: Mcp.RagSearchInput = {
          ...input,
          filters: { tenant: scope.tenant, project: scope.project, tags: effectiveTags },
        }
        deps.audit?.("rag.search", {
          sessionID: input.sessionID,
          tenant: scope.tenant,
          project: scope.project,
          sub: scope.sub,
          query: input.query,
          topK: input.topK,
          tags: effectiveTags,
          tagsRequested: requestedTags,
          tagsMode: enforceTags ? "enforce" : "disabled",
          source: "mcp",
        })
        const out = await Rag.search({ baseUrl: deps.config.OA_RAG_BASE_URL }, effective)
        return ok(out, out.passages.map((p) => p.text).join("\n"))
      },
    )

    server.registerTool(
      "asset.search",
      {
        description: "Search playable assets (read-only).",
        inputSchema: Mcp.AssetSearchInput,
        outputSchema: Mcp.AssetSearchOutput,
      },
      async (input) => {
        if (deps.config.OA_MEDIA_MODE === "disabled") return err("Media disabled")
        if (!input.sessionID) return err("Missing sessionID")
        if (!deps.hasSession(input.sessionID)) return err(`Unknown sessionID: ${input.sessionID}`)

        const scope = deps.getSessionScope?.(input.sessionID)
        if (!scope) return err(`Unknown sessionID: ${input.sessionID}`)

        if (input.filters?.tenant && input.filters.tenant !== scope.tenant) {
          return err(`tenant mismatch: expected ${scope.tenant}`)
        }
        if (input.filters?.project && input.filters.project !== scope.project) {
          return err(`project mismatch: expected ${scope.project}`)
        }

        const requestedTags = normalizeTags(input.filters?.tags)
        const enforceTags = deps.config.OA_AUTH_TAGS_MODE === "enforce"
        const allowedTags = normalizeTags(scope.tags)
        if (enforceTags && (!allowedTags || allowedTags.length === 0)) {
          return err("Missing permission tags in identity (OA_AUTH_TAGS_MODE=enforce)")
        }
        if (enforceTags && requestedTags && requestedTags.some((t) => !allowedTags!.includes(t))) {
          return err("tag mismatch: requested tags not allowed")
        }

        const effectiveTags = enforceTags ? (requestedTags ? requestedTags.filter((t) => allowedTags!.includes(t)) : allowedTags) : requestedTags

        const effective: Mcp.AssetSearchInput = {
          ...input,
          filters: { tenant: scope.tenant, project: scope.project, tags: effectiveTags },
        }

        deps.audit?.("asset.search", {
          sessionID: input.sessionID,
          tenant: scope.tenant,
          project: scope.project,
          sub: scope.sub,
          query: input.query,
          type: input.type,
          topK: input.topK,
          tags: effectiveTags,
          tagsRequested: requestedTags,
          tagsMode: enforceTags ? "enforce" : "disabled",
          source: "mcp",
        })
        const out = await Media.assetSearch({ baseUrl: deps.config.OA_MEDIA_BASE_URL }, effective)
        return ok(out)
      },
    )

    server.registerTool(
      "ui.present",
      {
        description: "Present an asset by assetId (no URL).",
        inputSchema: Mcp.UiPresentInput,
        outputSchema: Mcp.UiPresentOutput,
      },
      async (input) => {
        if (!deps.hasSession(input.sessionID)) return err(`Unknown sessionID: ${input.sessionID}`)
        if (deps.config.OA_MEDIA_MODE === "disabled") return err("Media disabled")

        const scope = deps.getSessionScope?.(input.sessionID)
        const turn = deps.getSessionTurn?.(input.sessionID)
        const sync =
          turn && turn.id
            ? {
                mode: "tts" as const,
                offsetMs: typeof turn.firstAudioAt === "number" ? Math.max(0, Math.floor(Date.now() - turn.firstAudioAt)) : undefined,
                turnId: turn.id,
              }
            : undefined
        const enforceTags = deps.config.OA_AUTH_TAGS_MODE === "enforce"
        const tags = enforceTags ? normalizeTags(scope?.tags) : undefined
        if (enforceTags && (!tags || tags.length === 0)) {
          return err("Missing permission tags in identity (OA_AUTH_TAGS_MODE=enforce)")
        }
        const asset = await Media.assetGet(
          { baseUrl: deps.config.OA_MEDIA_BASE_URL },
          input.assetId,
          scope ? { tenant: scope.tenant, project: scope.project, tags } : undefined,
        )
        if (!asset) return err(`Asset not found: ${input.assetId}`)
        const assetType = input.assetType ?? asset.type

        deps.audit?.("ui.present", {
          sessionID: input.sessionID,
          tenant: scope?.tenant,
          project: scope?.project,
          sub: scope?.sub,
          tags,
          tagsMode: enforceTags ? "enforce" : "disabled",
          assetId: input.assetId,
          assetType,
          autoplay: input.autoplay,
          layout: input.layout,
          startAtSeconds: input.startAtSeconds,
          turnId: sync?.turnId,
          syncMode: sync ? sync.mode : "none",
          syncOffsetMs: sync?.offsetMs,
          source: "mcp",
        })
        deps.sendToClient(input.sessionID, {
          v: 0,
          type: "ui.present",
          sessionID: input.sessionID,
          assetId: input.assetId,
          assetType,
          autoplay: input.autoplay,
          layout: input.layout,
          startAtSeconds: input.startAtSeconds,
          sync,
        })
        deps.setClientState(input.sessionID, "presenting")
        return ok({ ok: true })
      },
    )

    server.registerTool(
      "ui.stop",
      {
        description: "Stop playback for tts/video/all.",
        inputSchema: Mcp.UiStopInput,
      },
      async (input) => {
        if (!deps.hasSession(input.sessionID)) return err(`Unknown sessionID: ${input.sessionID}`)
        deps.audit?.("ui.stop", { sessionID: input.sessionID, target: input.target, source: "mcp" })
        deps.sendToClient(input.sessionID, { v: 0, type: "ui.stop", sessionID: input.sessionID, target: input.target })
        deps.setClientState(input.sessionID, "listening")
        return ok({ ok: true })
      },
    )

    const runtime: Runtime = {
      server,
      transport: undefined as any,
      lastSeenAt: Date.now(),
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        runtime.lastSeenAt = Date.now()
        runtimes.set(sessionId, runtime)
      },
      onsessionclosed: async (sessionId) => {
        const current = runtimes.get(sessionId)
        if (!current) return
        runtimes.delete(sessionId)
        await closeRuntime(current)
      },
    })
    runtime.transport = transport

    await server.connect(transport)
    return runtime
  }

  return async function handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get("mcp-session-id") ?? undefined

    if (sessionId) {
      const runtime = runtimes.get(sessionId)
      if (!runtime) {
        return new Response(JSON.stringify({ error: "session_not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      runtime.lastSeenAt = Date.now()
      return await runtime.transport.handleRequest(req)
    }

    if (req.method === "POST") {
      let parsedBody: unknown = undefined
      try {
        parsedBody = await req.clone().json()
      } catch {
        parsedBody = undefined
      }

      const isInit = isInitializeBody(parsedBody)
      if (!isInit) {
        return new Response(JSON.stringify({ error: "mcp_not_initialized" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      const runtime = await newRuntime()
      const res = await runtime.transport.handleRequest(req, parsedBody === undefined ? undefined : { parsedBody })
      const createdSessionId = res.headers.get("mcp-session-id")
      if (!createdSessionId) {
        await closeRuntime(runtime)
      }
      return res
    }

    return new Response(JSON.stringify({ error: "mcp_not_initialized" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }
}
