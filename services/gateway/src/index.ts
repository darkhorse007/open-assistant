import { Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import { Ws } from "@open-assistant/protocol"
import z from "zod/v4"
import { loadConfig } from "./config"
import * as OpenCode from "./opencode"
import { runGlobalEventLoop } from "./opencode-events"
import { connectAsr } from "./asr"
import { createAuditLogger } from "./audit"
import { openAuditDb } from "./audit-db"
import { MetricsRegistry } from "./metrics"
import { createTtsScheduler } from "./tts-scheduler"
import { createAsrScheduler } from "./asr-scheduler"
import { createAuthenticator, type Identity } from "./auth"
import * as TTS from "./tts"
import * as Media from "./media"
import * as Rag from "./rag"
import { createMcpHandler } from "./mcp"

const config = loadConfig()
const auditDb = config.OA_AUDIT_DB_PATH && config.OA_AUDIT_MODE !== "off" ? openAuditDb({ dbPath: config.OA_AUDIT_DB_PATH, maxRows: config.OA_AUDIT_DB_MAX_ROWS }) : undefined
const audit = createAuditLogger({ mode: config.OA_AUDIT_MODE, onEntry: (entry) => auditDb?.insert(entry) })
const auth = createAuthenticator(config, { audit })

const metrics = new MetricsRegistry()
const metricActiveSessions = metrics.gauge("oa_gateway_active_sessions", "Active Open Assistant WS sessions.")
const metricTurns = metrics.counter("oa_gateway_turn_total", "Number of turns processed by the gateway.")
const metricAborts = metrics.counter("oa_gateway_abort_total", "Number of aborted turns.")
const metricErrors = metrics.counter("oa_gateway_errors_total", "Number of gateway errors.")
const metricTurnDurationMs = metrics.histogram("oa_gateway_turn_duration_ms", "Turn duration in ms.", [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000,
])
const metricTtsFirstAudioMs = metrics.histogram("oa_gateway_tts_first_audio_ms", "Time to first TTS audio in ms.", [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000,
])
const metricTtsQueueDepth = metrics.gauge("oa_gateway_tts_queue_depth", "Pending TTS segments (global).")
const metricAsrActiveDecoders = metrics.gauge("oa_gateway_asr_active_decoders", "Active ASR decoders (global).")
const metricAsrQueueDepth = metrics.gauge("oa_gateway_asr_queue_depth", "Queued ASR audio frames (global).")
const metricAsrDroppedFrames = metrics.counter("oa_gateway_asr_dropped_frames_total", "Dropped ASR audio frames due to queue overflow.")
const metricAsrFinalLatencyMs = metrics.histogram("oa_gateway_asr_final_latency_ms", "Time to ASR final (from first audio) in ms.", [
  50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000, 10000,
])

const ttsScheduler = createTtsScheduler({
  maxConcurrent: config.OA_GW_TTS_MAX_CONCURRENT_SYNTHESIS,
  align: ({ sessionID, text, signal }) =>
    TTS.align({ baseUrl: config.OA_TTS_BASE_URL, mode: config.OA_TTS_MODE }, { sessionID, text, signal }),
  synthesize: ({ sessionID, text, signal }) =>
    TTS.synthesize({ baseUrl: config.OA_TTS_BASE_URL, mode: config.OA_TTS_MODE }, { sessionID, text, signal }),
  onDepth: (n) => metricTtsQueueDepth.set(undefined, n),
})
metricTtsQueueDepth.set(undefined, 0)
metricAsrQueueDepth.set(undefined, 0)
metricAsrActiveDecoders.set(undefined, 0)

function parseBearer(value: string | undefined | null) {
  if (!value) return
  const m = value.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || undefined
}

function checkAdminAuth(c: any) {
  const token = c.req.query("token") ?? parseBearer(c.req.header("authorization"))
  const expected = config.OA_ADMIN_TOKEN ?? config.OA_METRICS_TOKEN
  if (expected && token !== expected) {
    return { ok: false as const }
  }
  return { ok: true as const, token }
}

function httpBaseFromWsUrl(wsUrl: string) {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === "wss:" ? "https:" : "http:"
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

const app = new Hono()

const AssetID = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
const ASSET_ALLOW_TTL_MS = 5 * 60 * 1000
const assetAllowCache = new Map<string, { ok: boolean; expiresAt: number }>()

type Session = {
  id: string
  connID: string
  sub: string
  tenant: string
  project: string
  tokenHash?: string
  tags?: string[]
  ws: WSContext
  state: Ws.StateValue
  presentAssetId?: string
  createdAt: number
  lastSeenAt: number
  lastSubtitleSentAt?: number
  lastSubtitleText?: string
  opencodeSessionID?: string
  asrSegmentStartedAt?: number
  turn?: {
    id: string
    abort: AbortController
    startedAt: number
    timeout?: ReturnType<typeof setTimeout>
    firstAudioAt?: number
    phase?: "thinking" | "speaking"
  }
  ttsSeq: number
  lastAudioAckAt?: number
}

const sessions = new Map<string, Session>()
const opencodeSessionToClient = new Map<string, string>()

const asrScheduler = createAsrScheduler({
  maxConcurrent: config.OA_GW_ASR_MAX_CONCURRENT_DECODE,
  idleReleaseMs: config.OA_GW_ASR_IDLE_RELEASE_MS,
  queueMaxFrames: config.OA_GW_ASR_QUEUE_MAX_FRAMES,
  connect: (sessionID) =>
    connectAsr({ url: config.OA_ASR_WS_URL }, sessionID, (asr) => {
      const session = sessions.get(sessionID)
      if (!session) return
      send(session, asr)
      if (asr.type === "asr.final") {
        const startedAt = session.asrSegmentStartedAt
        if (startedAt) {
          metricAsrFinalLatencyMs.observe({ tenant: session.tenant, project: session.project }, Date.now() - startedAt)
        }
        session.asrSegmentStartedAt = undefined
        handleUtterance(session, asr.text, { emitAsrFinal: false }).catch(() => {})
      }
    }),
  onQueueDepth: (n) => metricAsrQueueDepth.set(undefined, n),
  onActive: (n) => metricAsrActiveDecoders.set(undefined, n),
  onDrop: (sessionID, droppedFrames) => {
    const session = sessions.get(sessionID)
    if (!session) return
    metricAsrDroppedFrames.inc({ tenant: session.tenant, project: session.project }, droppedFrames)
    audit("asr.queue.drop", {
      sessionID,
      tenant: session.tenant,
      project: session.project,
      sub: session.sub,
      droppedFrames,
    })
  },
})

function sendToWs(ws: WSContext, message: Ws.GatewayToClient) {
  ws.send(JSON.stringify(message))
}

function touch(session: Session) {
  session.lastSeenAt = Date.now()
}

function send(session: Session, message: Ws.GatewayToClient) {
  touch(session)

  if (message.type === "ui.present") {
    session.presentAssetId = message.assetId
  }
  if (message.type === "ui.stop") {
    const target = message.target
    if (target === "video" || target === "all" || typeof target !== "string") {
      session.presentAssetId = undefined
    }
  }

  if (message.type === "tts.audio") {
    const turn = session.turn
    if (turn && !turn.firstAudioAt) {
      turn.firstAudioAt = Date.now()
      const ms = turn.firstAudioAt - turn.startedAt
      metricTtsFirstAudioMs.observe({ tenant: session.tenant, project: session.project }, ms)
      audit("tts.first_audio", { sessionID: session.id, tenant: session.tenant, project: session.project, turnId: turn.id, ms })
    }
  }

  sendToWs(session.ws, message)
}

function setState(session: Session, state: Ws.StateValue) {
  session.state = state
  if (session.turn && (state === "thinking" || state === "speaking")) {
    session.turn.phase = state
  }
  send(session, { v: 0, type: "state", sessionID: session.id, state })
}

function stopClient(session: Session, target: Ws.UiStop["target"]) {
  send(session, { v: 0, type: "ui.stop", sessionID: session.id, target })
}

type AbortReason = "barge-in" | "button" | "timeout" | "superseded" | "error"

function segmentForTts(text: string): string[] {
  const maxChars = Math.max(40, config.OA_GW_TTS_SEGMENT_MAX_CHARS)
  const cleaned = text.replace(/\r\n/g, "\n").trim()
  if (!cleaned) return []

  const sentences: string[] = []
  const lines = cleaned.split(/\n+/).map((l) => l.trim())
  for (const line of lines) {
    if (!line) continue
    const parts = line.match(/[^。！？!?]+[。！？!?]?/g)
    if (parts && parts.length) {
      for (const p of parts) {
        const s = p.trim()
        if (s) sentences.push(s)
      }
    } else {
      sentences.push(line)
    }
  }

  const merged: string[] = []
  let buf = ""
  for (const s of sentences) {
    if (!buf) {
      buf = s
      continue
    }
    const joined = `${buf} ${s}`
    if (joined.length <= maxChars) {
      buf = joined
      continue
    }
    merged.push(buf.trim())
    buf = s
  }
  if (buf.trim()) merged.push(buf.trim())

  const out: string[] = []
  for (const s of merged) {
    if (s.length <= maxChars) {
      out.push(s)
      continue
    }
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars))
  }

  return out.slice(0, 64)
}

function ocConfig(): OpenCode.OpenCodeConfig {
  return {
    baseUrl: config.OA_OPENCODE_BASE_URL,
    directory: config.OA_OPENCODE_DIRECTORY,
    username: config.OA_OPENCODE_USERNAME,
    password: config.OA_OPENCODE_PASSWORD,
  }
}

function abortTurn(
  session: Session,
  reason: AbortReason,
  opts?: {
    stopTarget?: Ws.UiStop["target"]
    detail?: Record<string, unknown>
  },
) {
  const turn = session.turn
  session.turn = undefined

  if (opts?.stopTarget) {
    audit("ui.stop", { sessionID: session.id, tenant: session.tenant, project: session.project, target: opts.stopTarget, source: reason })
    stopClient(session, opts.stopTarget)
  }

  if (!turn) return
  if (turn.timeout) clearTimeout(turn.timeout)
  try {
    turn.abort.abort()
  } catch {
    // ignore
  }

  if (config.OA_TTS_MODE !== "disabled") {
    TTS.cancel({ baseUrl: config.OA_TTS_BASE_URL, mode: config.OA_TTS_MODE }, { sessionID: session.id }).catch(() => {})
  }

  metricAborts.inc({ reason, tenant: session.tenant, project: session.project })
  metricTurns.inc({ status: "aborted", reason, tenant: session.tenant, project: session.project })
  metricTurnDurationMs.observe({ tenant: session.tenant, project: session.project, status: "aborted" }, Date.now() - turn.startedAt)

  audit("abort", {
    sessionID: session.id,
    tenant: session.tenant,
    project: session.project,
    reason,
    turnId: turn.id,
    elapsedMs: Date.now() - turn.startedAt,
    ...opts?.detail,
  })

  if (session.opencodeSessionID) {
    OpenCode.abort(ocConfig(), session.opencodeSessionID).catch(() => {})
  }
}

function cleanupSession(session: Session) {
  if (session.opencodeSessionID) opencodeSessionToClient.delete(session.opencodeSessionID)

  asrScheduler.closeSession(session.id)

  abortTurn(session, "error")
}

function sweepSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastSeenAt <= config.OA_GW_SESSION_IDLE_TTL_MS) continue

    audit("session.sweep", {
      sessionID: id,
      tenant: session.tenant,
      project: session.project,
      idleMs: now - session.lastSeenAt,
    })
    cleanupSession(session)
    sessions.delete(id)
    try {
      session.ws.close(1000, "idle timeout")
    } catch {
      // ignore
    }
  }

  metricActiveSessions.set(undefined, sessions.size)
}

{
  const interval = setInterval(sweepSessions, config.OA_GW_SESSION_SWEEP_INTERVAL_MS)
  // Best-effort: avoid keeping the process alive solely for the sweeper.
  if (typeof (interval as any)?.unref === "function") (interval as any).unref()
}

function scopeKey(scope: { tenant: string; project: string; tags?: string[] }, assetId: string) {
  const tagsKey = config.OA_AUTH_TAGS_MODE === "enforce" ? (scope.tags ?? []).join("\u0000") : ""
  return `${scope.tenant}:${scope.project}:${tagsKey}:${assetId}`
}

function clearAssetAllowCache(scope: { tenant: string; project: string }, assetId: string) {
  const prefix = `${scope.tenant}:${scope.project}:`
  const suffix = `:${assetId}`
  for (const key of assetAllowCache.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) assetAllowCache.delete(key)
  }
}

async function isAllowedAsset(assetId: string, scope: { tenant: string; project: string; tags?: string[] }) {
  const now = Date.now()
  const key = scopeKey(scope, assetId)
  const cached = assetAllowCache.get(key)
  if (cached && cached.expiresAt > now) return cached.ok

  if (config.OA_MEDIA_MODE === "disabled") return false
  const enforceTags = config.OA_AUTH_TAGS_MODE === "enforce"
  if (enforceTags && (!scope.tags || scope.tags.length === 0)) return false
  const ok = await Media.assetExists(
    { baseUrl: config.OA_MEDIA_BASE_URL },
    assetId,
    { tenant: scope.tenant, project: scope.project, tags: enforceTags ? scope.tags : undefined },
  ).catch(() => false)
  assetAllowCache.set(key, { ok, expiresAt: now + ASSET_ALLOW_TTL_MS })
  return ok
}

async function proxyAsset(c: any) {
  const assetId = AssetID.parse(c.req.param("assetId") ?? "")
  const queryToken = c.req.query("token")
  const token = parseBearer(queryToken) ?? queryToken ?? parseBearer(c.req.header("authorization"))
  const identity = await auth.authenticate(token)
  if (!identity) return c.json({ ok: false, error: "unauthorized" }, 401)

  if (config.OA_MEDIA_MODE === "disabled") {
    return c.json({ ok: false, error: "media_disabled" }, 503)
  }

  const allowed = await isAllowedAsset(assetId, identity)
  if (!allowed) return c.json({ ok: false, error: "not_allowed" }, 404)

  const range = c.req.header("range")
  const ifRange = c.req.header("if-range")
  const ifModifiedSince = c.req.header("if-modified-since")
  const ifNoneMatch = c.req.header("if-none-match")

  const headers: Record<string, string> = {}
  if (range) headers["range"] = range
  if (ifRange) headers["if-range"] = ifRange
  if (ifModifiedSince) headers["if-modified-since"] = ifModifiedSince
  if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch

  const upstreamUrl = new URL(`/assets/${encodeURIComponent(assetId)}`, config.OA_MEDIA_BASE_URL)
  upstreamUrl.searchParams.set("tenant", identity.tenant)
  upstreamUrl.searchParams.set("project", identity.project)
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: c.req.method, headers, redirect: "manual" })
  } catch (err) {
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return c.json({ ok: false, error: "redirect_not_allowed" }, 502)
  }

  const outHeaders = new Headers()
  for (const key of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key)
    if (value) outHeaders.set(key, value)
  }
  outHeaders.set("cache-control", "no-store")
  const origin = c.req.header("origin")
  if (origin) {
    outHeaders.set("access-control-allow-origin", origin)
    outHeaders.set("vary", "Origin")
  } else {
    outHeaders.set("access-control-allow-origin", "*")
  }

  return new Response(c.req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: outHeaders })
}

async function proxyAdminAsset(c: any) {
  if (config.OA_MEDIA_MODE !== "external") {
    return c.json({ ok: false, error: "media_not_external" }, 503)
  }

  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const tenant = (c.req.query("tenant") ?? "").trim()
  const project = (c.req.query("project") ?? "").trim()
  if (!tenant || !project) {
    return c.json({ ok: false, error: "missing_scope", detail: "tenant and project query params are required" }, 400)
  }

  const assetId = AssetID.parse(c.req.param("assetId") ?? "")

  const startedAt = Date.now()

  const headers: Record<string, string> = {}
  for (const key of ["range", "if-range", "if-modified-since", "if-none-match"]) {
    const v = c.req.header(key)
    if (v) headers[key] = v
  }
  if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL(`/admin/assets/${encodeURIComponent(assetId)}`, config.OA_MEDIA_BASE_URL)
  upstreamUrl.searchParams.set("tenant", tenant)
  upstreamUrl.searchParams.set("project", project)

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: c.req.method, headers, redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.preview", {
      tenant,
      project,
      assetId,
      method: c.req.method,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return c.json({ ok: false, error: "redirect_not_allowed" }, 502)
  }

  audit("admin.media.asset.preview", {
    tenant,
    project,
    assetId,
    method: c.req.method,
    ok: upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
  })

  const outHeaders = new Headers()
  for (const key of ["content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key)
    if (value) outHeaders.set(key, value)
  }
  outHeaders.set("cache-control", "no-store")
  const origin = c.req.header("origin")
  if (origin) {
    outHeaders.set("access-control-allow-origin", origin)
    outHeaders.set("vary", "Origin")
  } else {
    outHeaders.set("access-control-allow-origin", "*")
  }

  return new Response(c.req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: outHeaders })
}

async function ensureOpenCodeSession(session: Session) {
  if (session.opencodeSessionID) {
    opencodeSessionToClient.set(session.opencodeSessionID, session.id)
    return session.opencodeSessionID
  }

  const created = await OpenCode.createSession(ocConfig(), `Open Assistant (${session.id})`)
  session.opencodeSessionID = created
  opencodeSessionToClient.set(created, session.id)
  return created
}

function startOpenCodeEvents() {
  if (config.OA_LLM_MODE !== "opencode") return
  if (config.OA_OPENCODE_EVENTS_MODE !== "sse") return

  const oc: OpenCode.OpenCodeConfig = ocConfig()
  const toolStatusCache = new Map<string, string>()

  let lastWarnAt = 0
  runGlobalEventLoop(oc, {
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (config.OA_OPENCODE_DIRECTORY && event.directory !== config.OA_OPENCODE_DIRECTORY) return

      const payloadType = event.payload.type
      const props: any = event.payload.properties

      if (payloadType === "message.part.updated") {
        const part = props?.part as any
        if (!part || typeof part !== "object") return
        const ocSessionID = part.sessionID
        if (typeof ocSessionID !== "string") return

        const clientSessionID = opencodeSessionToClient.get(ocSessionID)
        if (!clientSessionID) return
        const session = sessions.get(clientSessionID)
        if (!session) return

        if (part.type === "text") {
          const text = typeof part.text === "string" ? part.text : ""
          if (!text) return

          const now = Date.now()
          if (session.lastSubtitleSentAt && now - session.lastSubtitleSentAt < 250) return
          if (session.lastSubtitleText === text) return

          session.lastSubtitleSentAt = now
          session.lastSubtitleText = text
          audit("opencode.text", {
            sessionID: session.id,
            tenant: session.tenant,
            project: session.project,
            messageID: part.messageID,
            partID: part.id,
            text,
          })
        } else if (part.type === "tool") {
          const status = typeof part.state?.status === "string" ? part.state.status : "unknown"
          const tool = typeof part.tool === "string" ? part.tool : ""
          const cacheKey = `${session.id}:${part.id}`
          if (tool && toolStatusCache.get(cacheKey) === status) return
          if (tool) toolStatusCache.set(cacheKey, status)
          if (toolStatusCache.size > 5000) toolStatusCache.clear()

          // Keep logs minimal & safe (details are also emitted via MCP audit).
          audit("opencode.tool", {
            sessionID: session.id,
            tenant: session.tenant,
            project: session.project,
            tool,
            status,
            callID: part.callID,
          })

          if (status === "completed") {
            if (tool === "openassistant_ui_present") setState(session, "presenting")
            if (tool === "openassistant_ui_stop") setState(session, session.presentAssetId ? "presenting" : "listening")
          }
        }

        return
      }

      // Future: tool/session status events (audit + state sync).
    },
    onError: (err) => {
      const now = Date.now()
      if (now - lastWarnAt < 5000) return
      lastWarnAt = now
      // eslint-disable-next-line no-console
      console.warn(`open-assistant-gateway: OpenCode event stream error: ${err instanceof Error ? err.message : String(err)}`)
    },
  }).catch(() => {})
}

async function handleInterrupt(session: Session, reason: Ws.Interrupt["reason"] | undefined) {
  audit("interrupt", { sessionID: session.id, tenant: session.tenant, project: session.project, reason })
  const abortReason: AbortReason = reason === "vad" ? "barge-in" : "button"
  abortTurn(session, abortReason, { stopTarget: "all", detail: { interruptReason: reason } })
  setState(session, "listening")
}

async function handleUtterance(session: Session, text: string, opts: { emitAsrFinal: boolean }) {
  const source = opts.emitAsrFinal ? "text.in" : "asr.final"
  const trimmed = text.trim()

  // Dev commands: do not supersede current turn by default.
  if (trimmed.startsWith("/present ") || trimmed.startsWith("/play ")) {
    if (opts.emitAsrFinal) send(session, { v: 0, type: "asr.final", sessionID: session.id, text })

    const parts = trimmed.split(/\s+/).filter(Boolean)
    const assetId = parts[1] ?? ""
    const arg2 = parts[2]
    const arg3 = parts[3]

    let startAtSeconds: number | undefined = undefined
    let assetType: Ws.PresentAssetType = "video"
    if (arg2) {
      const n = Number(arg2)
      if (Number.isFinite(n)) startAtSeconds = n
      else if (arg2 === "video" || arg2 === "slides" || arg2 === "model") assetType = arg2
    }
    if (arg3) {
      if (arg3 === "video" || arg3 === "slides" || arg3 === "model") assetType = arg3
    }

    try {
      const parsedAssetId = AssetID.parse(assetId)
      if (config.OA_MEDIA_MODE === "disabled") throw new Error("media disabled")
      const allowed = await isAllowedAsset(parsedAssetId, session)
      if (!allowed) throw new Error(`asset not found: ${parsedAssetId}`)

      const turn = session.turn
      const sync = turn
        ? {
            mode: "tts" as const,
            offsetMs: typeof turn.firstAudioAt === "number" ? Math.max(0, Math.floor(Date.now() - turn.firstAudioAt)) : undefined,
            turnId: turn.id,
          }
        : undefined

      audit("ui.present", {
        sessionID: session.id,
        tenant: session.tenant,
        project: session.project,
        turnId: sync?.turnId,
        syncMode: sync ? sync.mode : "none",
        syncOffsetMs: sync?.offsetMs,
        assetId: parsedAssetId,
        assetType,
        autoplay: true,
        layout: "side-by-side",
        startAtSeconds: Number.isFinite(startAtSeconds as number) ? (startAtSeconds as number) : undefined,
        source: "devcmd",
      })
      send(session, {
        v: 0,
        type: "ui.present",
        sessionID: session.id,
        assetId: parsedAssetId,
        assetType,
        autoplay: true,
        layout: "side-by-side",
        startAtSeconds: Number.isFinite(startAtSeconds as number) ? (startAtSeconds as number) : undefined,
        sync,
      })
      setState(session, "presenting")
    } catch (err) {
      send(session, {
        v: 0,
        type: "asr.partial",
        sessionID: session.id,
        text: `（ui.present 参数错误）${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return
  }

  if (trimmed === "/stop" || trimmed === "/stop video") {
    if (opts.emitAsrFinal) send(session, { v: 0, type: "asr.final", sessionID: session.id, text })
    audit("ui.stop", { sessionID: session.id, tenant: session.tenant, project: session.project, target: "video", source: "devcmd" })
    send(session, { v: 0, type: "ui.stop", sessionID: session.id, target: "video" })
    if (session.turn) {
      setState(session, session.turn.phase ?? "speaking")
    } else {
      setState(session, "listening")
    }
    return
  }
  if (trimmed === "/stop all") {
    if (opts.emitAsrFinal) send(session, { v: 0, type: "asr.final", sessionID: session.id, text })
    if (session.turn) abortTurn(session, "button", { detail: { by: "devcmd" } })
    audit("ui.stop", { sessionID: session.id, tenant: session.tenant, project: session.project, target: "all", source: "devcmd" })
    send(session, { v: 0, type: "ui.stop", sessionID: session.id, target: "all" })
    setState(session, "listening")
    return
  }

  if (session.turn) {
    abortTurn(session, "superseded", { stopTarget: "tts", detail: { by: source } })
  }

  if (opts.emitAsrFinal) send(session, { v: 0, type: "asr.final", sessionID: session.id, text })

  const turnAbort = new AbortController()
  const turn: NonNullable<Session["turn"]> = {
    id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    abort: turnAbort,
    startedAt: Date.now(),
  }
  turn.timeout = setTimeout(() => {
    if (session.turn !== turn) return
    abortTurn(session, "timeout", { stopTarget: "tts", detail: { timeoutMs: config.OA_GW_TURN_TIMEOUT_MS } })
    setState(session, session.presentAssetId ? "presenting" : "listening")
    send(session, { v: 0, type: "asr.partial", sessionID: session.id, text: "（请求超时，已取消）" })
  }, config.OA_GW_TURN_TIMEOUT_MS)
  session.turn = turn

  metricTurns.inc({ status: "started", tenant: session.tenant, project: session.project })
  audit("turn.start", { sessionID: session.id, tenant: session.tenant, project: session.project, text, source, turnId: turn.id })
  setState(session, "thinking")

  const sessionContext = `当前浏览器会话 sessionID="${session.id}"。\n当前租户：tenant="${session.tenant}" project="${session.project}"。\n如需调用工具：\n- openassistant_rag_search / openassistant_asset_search 必须传入 sessionID="${session.id}"；tenant/project 由网关注入并强校验（不要自行构造；如传 filters.tenant/project 必须与会话一致）。rag.search / asset.search 可选传 filters.tags（用于按标签过滤，仅缩小范围）。\n- 使用 openassistant_ui_present 时必须传入 sessionID="${session.id}"（只用 assetId，不要 URL）\n- 使用 openassistant_ui_stop 时必须传入 sessionID="${session.id}"`

  let ragSystem: string | undefined
  if (config.OA_RAG_MODE !== "disabled") {
    try {
      const enforceTags = config.OA_AUTH_TAGS_MODE === "enforce"
      const tags = enforceTags ? session.tags : undefined
      if (enforceTags && (!tags || tags.length === 0)) {
        audit("rag.search.skipped", {
          sessionID: session.id,
          tenant: session.tenant,
          project: session.project,
          reason: "missing_tags",
          source: "gateway",
        })
      } else {
        audit("rag.search", {
          sessionID: session.id,
          tenant: session.tenant,
          project: session.project,
          query: text,
          topK: 4,
          tags,
          tagsMode: enforceTags ? "enforce" : "disabled",
          source: "gateway",
        })
        const out = await Rag.search(
          { baseUrl: config.OA_RAG_BASE_URL },
          { query: text, topK: 4, filters: { tenant: session.tenant, project: session.project, tags } },
          { signal: turnAbort.signal },
        )
        audit("rag.search.result", {
          sessionID: session.id,
          tenant: session.tenant,
          project: session.project,
          count: out.passages.length,
          tags,
          source: "gateway",
        })
        if (out.passages.length) {
          const lines = out.passages.map((p, i) => `- [${i + 1}] (${p.sourceId}) ${p.text}`)
          ragSystem =
            "你可以参考以下检索到的资料片段（可能包含噪声）。回答时优先基于片段；若片段不足以支撑结论，请明确说明不确定性。\n\n" +
            lines.join("\n")
        }
      }
    } catch (err) {
      if (turnAbort.signal.aborted) return
      metricErrors.inc({ stage: "rag", tenant: session.tenant, project: session.project })
      ragSystem = undefined
    }
  }

  let assistant = ""
  try {
    if (config.OA_LLM_MODE === "mock") {
      assistant = ragSystem ? `（mock）我收到了：${text}\n\n（RAG 已注入）` : `（mock）我收到了：${text}`
    } else {
      const system = [sessionContext, ragSystem].filter(Boolean).join("\n\n")
      const ocSessionID = await ensureOpenCodeSession(session)
      assistant = await OpenCode.prompt(ocConfig(), ocSessionID, {
        agent: "open-assistant",
        system,
        text,
        signal: turnAbort.signal,
      })
      if (!assistant) assistant = "（空响应）"
    }
  } catch (err) {
    if (turnAbort.signal.aborted) return
    metricErrors.inc({ stage: "llm", tenant: session.tenant, project: session.project })
    assistant = `（生成失败）${err instanceof Error ? err.message : String(err)}`
  }

  if (session.turn !== turn) return

  setState(session, "speaking")
  send(session, { v: 0, type: "tts.text", sessionID: session.id, seq: session.ttsSeq++, text: assistant, final: true })

  try {
    const segments = segmentForTts(assistant)
    const units = segments.length ? segments : [assistant]

    for (let i = 0; i < units.length; i++) {
      const unit = units[i]!
      const segmentId = `${turn.id}:${i}`
      if (turnAbort.signal.aborted) return
      if (session.turn !== turn) return

      await ttsScheduler.enqueue({
        sessionID: session.id,
        text: unit,
        signal: turnAbort.signal,
        onAlign: (alignment) => {
          if (turnAbort.signal.aborted) return
          if (session.turn !== turn) return

          const segments = alignment.segments ?? []
          send(session, { v: 0, type: "tts.align", sessionID: session.id, seq: session.ttsSeq++, turnId: turn.id, segmentId, segments })
          audit("tts.align", {
            sessionID: session.id,
            tenant: session.tenant,
            project: session.project,
            turnId: turn.id,
            segmentId,
            segmentCount: segments.length,
          })
        },
        onChunk: (chunk) => {
          if (turnAbort.signal.aborted) return
          if (session.turn !== turn) return
          send(session, {
            v: 0,
            type: "tts.audio",
            sessionID: session.id,
            seq: session.ttsSeq++,
            segmentId,
            segmentSeq: chunk.seq,
            mime: chunk.mime,
            sampleRate: chunk.sampleRate,
            data: chunk.data,
            marks: chunk.marks,
          })
        },
      })
    }
  } catch (err) {
    if (session.turn === turn && !turnAbort.signal.aborted) {
      metricErrors.inc({ stage: "tts", tenant: session.tenant, project: session.project })
      send(session, {
        v: 0,
        type: "asr.partial",
        sessionID: session.id,
        text: `（TTS 失败）${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  if (session.turn !== turn) return

  if (turn.timeout) clearTimeout(turn.timeout)
  session.turn = undefined
  setState(session, session.presentAssetId ? "presenting" : "listening")
  metricTurns.inc({ status: "completed", tenant: session.tenant, project: session.project })
  metricTurnDurationMs.observe({ tenant: session.tenant, project: session.project, status: "completed" }, Date.now() - turn.startedAt)
  audit("turn.finish", {
    sessionID: session.id,
    tenant: session.tenant,
    project: session.project,
    turnId: turn.id,
    elapsedMs: Date.now() - turn.startedAt,
  })
}

app.get("/healthz", (c) => c.json({ ok: true }))

app.get("/metrics", (c) => {
  const token = c.req.query("token") ?? parseBearer(c.req.header("authorization"))
  if (config.OA_METRICS_TOKEN && token !== config.OA_METRICS_TOKEN) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  return new Response(metrics.renderPrometheus(), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  })
})

const AuditSearchInput = z.object({
  tenant: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  sessionID: z.string().min(1).optional(),
  event: z.string().min(1).optional(),
  eventPrefix: z.string().min(1).optional(),
  assetId: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  since: z.union([z.number(), z.string()]).optional(),
  until: z.union([z.number(), z.string()]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200),
  cursor: z.coerce.number().int().positive().optional(),
  order: z.enum(["desc", "asc"]).default("desc"),
})

const AuditSessionsInput = z.object({
  tenant: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  since: z.union([z.number(), z.string()]).optional(),
  until: z.union([z.number(), z.string()]).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(50),
  cursor: z.coerce.number().int().positive().optional(),
  order: z.enum(["desc", "asc"]).default("desc"),
})

function parseMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v)
  if (typeof v !== "string") return undefined
  const trimmed = v.trim()
  if (!trimmed) return undefined
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber)) return Math.floor(asNumber)
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

app.get("/audit/healthz", (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  return c.json({ ok: true, enabled: Boolean(auditDb), mode: config.OA_AUDIT_MODE })
})

app.post("/audit/search", async (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  if (!auditDb) return c.json({ ok: false, error: "audit_db_disabled" }, 503)

  const input = AuditSearchInput.parse(await c.req.json().catch(() => ({})))
  const out = auditDb.search({
    tenant: input.tenant,
    project: input.project,
    sessionID: input.sessionID,
    event: input.event,
    eventPrefix: input.eventPrefix,
    assetId: input.assetId,
    file: input.file,
    reason: input.reason,
    sinceMs: parseMs(input.since),
    untilMs: parseMs(input.until),
    limit: input.limit,
    cursor: input.cursor,
    order: input.order,
  })
  return c.json({ ok: true, ...out })
})

app.post("/audit/sessions", async (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  if (!auditDb) return c.json({ ok: false, error: "audit_db_disabled" }, 503)

  const input = AuditSessionsInput.parse(await c.req.json().catch(() => ({})))
  const out = auditDb.sessions({
    tenant: input.tenant,
    project: input.project,
    query: input.query,
    sinceMs: parseMs(input.since),
    untilMs: parseMs(input.until),
    limit: input.limit,
    cursor: input.cursor,
    order: input.order,
  })
  return c.json({ ok: true, ...out })
})

const AuditEmitInput = z.object({
  event: z.string().min(1).max(120),
  fields: z.record(z.string(), z.unknown()).default({}),
})

app.post("/audit/emit", async (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  if (!auditDb) return c.json({ ok: false, error: "audit_db_disabled" }, 503)

  const input = AuditEmitInput.parse(await c.req.json().catch(() => ({})))
  const event = input.event
  if (!event.startsWith("rag.ingest.")) {
    return c.json({ ok: false, error: "event_not_allowed", detail: "only rag.ingest.* allowed" }, 400)
  }

  const fields = input.fields ?? {}
  const bytes = (() => {
    try {
      return JSON.stringify(fields).length
    } catch {
      return 0
    }
  })()
  if (bytes > 20_000) {
    return c.json({ ok: false, error: "payload_too_large", detail: "fields JSON exceeds 20k chars" }, 400)
  }

  audit(event, fields)
  return c.json({ ok: true })
})

const AuditExportInput = AuditSearchInput.extend({
  format: z.enum(["ndjson", "csv"]).default("ndjson"),
  maxRows: z.coerce.number().int().positive().max(200000).default(5000),
  batchSize: z.coerce.number().int().positive().max(1000).default(500),
})

function csvEscapeCell(value: unknown) {
  const raw = value === null || value === undefined ? "" : String(value)
  if (!raw.includes(",") && !raw.includes('"') && !raw.includes("\n") && !raw.includes("\r")) return raw
  return `"${raw.replaceAll('"', '""')}"`
}

function buildAuditExportResponse(input: z.infer<typeof AuditExportInput>, req: Request) {
  if (!auditDb) {
    return new Response(JSON.stringify({ ok: false, error: "audit_db_disabled" }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }

  const format = input.format
  const maxRows = input.maxRows
  const batchSize = input.batchSize

  const fileExt = format === "csv" ? "csv" : "ndjson"
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const filename = `audit-export-${stamp}.${fileExt}`

  const encoder = new TextEncoder()
  const signal = req.signal

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode("id,ts,tsMs,event,sessionID,tenant,project,dataJson\n"))
        }

        let cursor = input.cursor
        let exported = 0

        while (exported < maxRows) {
          if (signal.aborted) break

          const pageLimit = Math.min(batchSize, maxRows - exported)
          const out = auditDb.search({
            tenant: input.tenant,
            project: input.project,
            sessionID: input.sessionID,
            event: input.event,
            eventPrefix: input.eventPrefix,
            assetId: input.assetId,
            file: input.file,
            reason: input.reason,
            sinceMs: parseMs(input.since),
            untilMs: parseMs(input.until),
            limit: pageLimit,
            cursor,
            order: input.order,
          })

          const events = out.events ?? []
          if (!events.length) break

          for (const ev of events) {
            if (signal.aborted) break
            if (exported >= maxRows) break

            if (format === "csv") {
              const json = JSON.stringify(ev)
              const row = [
                (ev as any)?.id ?? "",
                (ev as any)?.ts ?? "",
                (ev as any)?.tsMs ?? "",
                (ev as any)?.event ?? "",
                (ev as any)?.sessionID ?? "",
                (ev as any)?.tenant ?? "",
                (ev as any)?.project ?? "",
                json,
              ]
                .map(csvEscapeCell)
                .join(",")
              controller.enqueue(encoder.encode(`${row}\n`))
            } else {
              controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`))
            }

            exported += 1
          }

          if (!out.nextCursor) break
          cursor = out.nextCursor
        }
      } catch (err) {
        controller.enqueue(encoder.encode(JSON.stringify({ ok: false, error: "export_failed", detail: err instanceof Error ? err.message : String(err) })))
      } finally {
        controller.close()
      }
    },
  })

  const headers = new Headers()
  headers.set("cache-control", "no-store")
  headers.set("content-disposition", `attachment; filename="${filename}"`)
  headers.set("content-type", format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8")
  return new Response(stream, { status: 200, headers })
}

app.get("/audit/export", async (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const input = AuditExportInput.parse({
    tenant: c.req.query("tenant"),
    project: c.req.query("project"),
    sessionID: c.req.query("sessionID"),
    event: c.req.query("event"),
    eventPrefix: c.req.query("eventPrefix"),
    assetId: c.req.query("assetId"),
    file: c.req.query("file"),
    reason: c.req.query("reason"),
    since: c.req.query("since"),
    until: c.req.query("until"),
    order: c.req.query("order"),
    cursor: c.req.query("cursor"),
    format: c.req.query("format"),
    maxRows: c.req.query("maxRows"),
    batchSize: c.req.query("batchSize"),
  })

  return buildAuditExportResponse(input, c.req.raw)
})

app.post("/audit/export", async (c) => {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const input = AuditExportInput.parse(await c.req.json().catch(() => ({})))
  return buildAuditExportResponse(input, c.req.raw)
})

async function proxyAdminMultipart(c: any, upstreamUrl: URL) {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const contentType = c.req.header("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({ ok: false, error: "bad_content_type", detail: "expected multipart/form-data" }, 400)
  }

  const headers: Record<string, string> = { "content-type": contentType }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: c.req.raw.body, redirect: "manual" })
  } catch (err) {
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

async function proxyAdminJson(c: any, upstreamUrl: URL) {
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const input = await c.req.json().catch(() => ({}))

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
}

app.post("/admin/api/media/upload", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const contentType = c.req.header("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({ ok: false, error: "bad_content_type", detail: "expected multipart/form-data" }, 400)
  }

  const headers: Record<string, string> = { "content-type": contentType }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const tenantHeader = (c.req.header("x-oa-tenant") ?? "").trim() || undefined
  const projectHeader = (c.req.header("x-oa-project") ?? "").trim() || undefined

  const upstreamUrl = new URL("/asset/upload", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: c.req.raw.body, redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.upload", {
      tenant: tenantHeader,
      project: projectHeader,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)

  const tenant = typeof (upstreamJson as any)?.tenant === "string" ? String((upstreamJson as any).tenant) : tenantHeader
  const project = typeof (upstreamJson as any)?.project === "string" ? String((upstreamJson as any).project) : projectHeader
  const assetId = typeof (upstreamJson as any)?.assetId === "string" ? String((upstreamJson as any).assetId) : undefined
  const type = typeof (upstreamJson as any)?.type === "string" ? String((upstreamJson as any).type) : undefined
  const status = typeof (upstreamJson as any)?.status === "string" ? String((upstreamJson as any).status) : undefined
  const titleValue = typeof (upstreamJson as any)?.title === "string" ? String((upstreamJson as any).title) : undefined
  const tags = Array.isArray((upstreamJson as any)?.tags) ? ((upstreamJson as any).tags as unknown[]).map(String) : undefined
  const bytes = typeof (upstreamJson as any)?.bytes === "number" ? Number((upstreamJson as any).bytes) : undefined

  audit("admin.media.asset.upload", {
    tenant,
    project,
    assetId,
    type,
    status,
    tags,
    titleLen: typeof titleValue === "string" ? titleValue.length : undefined,
    bytes,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/media/list", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  return await proxyAdminJson(c, new URL("/asset/list", config.OA_MEDIA_BASE_URL))
})

app.post("/admin/api/media/search", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  return await proxyAdminJson(c, new URL("/asset/search", config.OA_MEDIA_BASE_URL))
})

app.post("/admin/api/media/delete", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const assetId = typeof (input as any)?.assetId === "string" ? String((input as any).assetId) : undefined
  const deleteFile = typeof (input as any)?.deleteFile === "boolean" ? Boolean((input as any).deleteFile) : undefined
  if (tenant && project && assetId) clearAssetAllowCache({ tenant, project }, assetId)

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/asset/delete", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.delete", {
      tenant,
      project,
      assetId,
      deleteFile,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)
  audit("admin.media.asset.delete", {
    tenant,
    project,
    assetId,
    deleteFile,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/media/update", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const assetId = typeof (input as any)?.assetId === "string" ? String((input as any).assetId) : undefined
  const status = typeof (input as any)?.status === "string" ? String((input as any).status) : undefined
  const type = typeof (input as any)?.type === "string" ? String((input as any).type) : undefined
  const titleValue = typeof (input as any)?.title === "string" ? String((input as any).title) : undefined
  const title = typeof titleValue === "string" ? titleValue.trim() : undefined
  const reasonValue = typeof (input as any)?.reason === "string" ? String((input as any).reason) : undefined
  const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : undefined
  const tags =
    Array.isArray((input as any)?.tags) && (input as any).tags.length
      ? (input as any).tags
          .flatMap((v: unknown) => String(v).split(","))
          .map((s: string) => s.trim())
          .filter(Boolean)
          .slice(0, 64)
      : Array.isArray((input as any)?.tags)
        ? []
        : undefined
  if (tenant && project && assetId) clearAssetAllowCache({ tenant, project }, assetId)

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/asset/update", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.update", {
      tenant,
      project,
      assetId,
      status,
      type,
      tags,
      reason,
      reasonLen: typeof reason === "string" ? reason.length : undefined,
      titleLen: typeof title === "string" ? title.length : undefined,
      titleCleared: typeof title === "string" ? title.length === 0 : undefined,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)
  audit("admin.media.asset.update", {
    tenant,
    project,
    assetId,
    status,
    type,
    tags,
    reason,
    reasonLen: typeof reason === "string" ? reason.length : undefined,
    titleLen: typeof title === "string" ? title.length : undefined,
    titleCleared: typeof title === "string" ? title.length === 0 : undefined,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/media/remote", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const assetId = typeof (input as any)?.assetId === "string" ? String((input as any).assetId) : undefined
  const type = typeof (input as any)?.type === "string" ? String((input as any).type) : undefined
  const status = typeof (input as any)?.status === "string" ? String((input as any).status) : undefined
  const urlValue = typeof (input as any)?.url === "string" ? String((input as any).url) : undefined
  const urlLen = typeof urlValue === "string" ? urlValue.length : undefined
  let sourceHost: string | undefined
  try {
    if (typeof urlValue === "string") sourceHost = new URL(urlValue).host
  } catch {
    // ignore
  }

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/asset/remote", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.remote", {
      tenant,
      project,
      assetId,
      type,
      status,
      sourceHost,
      urlLen,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)

  const createdAssetId = typeof (upstreamJson as any)?.asset?.assetId === "string" ? String((upstreamJson as any).asset.assetId) : assetId
  if (tenant && project && createdAssetId) clearAssetAllowCache({ tenant, project }, createdAssetId)

  audit("admin.media.asset.remote", {
    tenant,
    project,
    assetId: createdAssetId,
    type,
    status,
    sourceHost: typeof (upstreamJson as any)?.asset?.sourceHost === "string" ? String((upstreamJson as any).asset.sourceHost) : sourceHost,
    urlLen,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/media/remote/update", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const assetId = typeof (input as any)?.assetId === "string" ? String((input as any).assetId) : undefined
  const type = typeof (input as any)?.type === "string" ? String((input as any).type) : undefined
  const reasonValue = typeof (input as any)?.reason === "string" ? String((input as any).reason) : undefined
  const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : undefined
  const urlValue = typeof (input as any)?.url === "string" ? String((input as any).url) : undefined
  const urlLen = typeof urlValue === "string" ? urlValue.length : undefined
  let sourceHost: string | undefined
  try {
    if (typeof urlValue === "string") sourceHost = new URL(urlValue).host
  } catch {
    // ignore
  }

  if (tenant && project && assetId) clearAssetAllowCache({ tenant, project }, assetId)

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/asset/remote/update", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.media.asset.remote.update", {
      tenant,
      project,
      assetId,
      type,
      reason,
      reasonLen: typeof reason === "string" ? reason.length : undefined,
      sourceHost,
      urlLen,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)

  audit("admin.media.asset.remote.update", {
    tenant,
    project,
    assetId: typeof (upstreamJson as any)?.asset?.assetId === "string" ? String((upstreamJson as any).asset.assetId) : assetId,
    type,
    reason,
    reasonLen: typeof reason === "string" ? reason.length : undefined,
    sourceHost: typeof (upstreamJson as any)?.asset?.sourceHost === "string" ? String((upstreamJson as any).asset.sourceHost) : sourceHost,
    urlLen,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.get("/admin/api/media/config", async (c) => {
  if (config.OA_MEDIA_MODE !== "external") return c.json({ ok: false, error: "media_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const headers: Record<string, string> = {}
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/admin/config", config.OA_MEDIA_BASE_URL)
  let upstream: Response
  try {
    upstream = await fetch(upstreamUrl, { method: "GET", headers, redirect: "manual" })
  } catch (err) {
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/rag/upload", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token

  const contentType = c.req.header("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({ ok: false, error: "bad_content_type", detail: "expected multipart/form-data" }, 400)
  }

  const headers: Record<string, string> = { "content-type": contentType }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const tenantHeader = (c.req.header("x-oa-tenant") ?? "").trim() || undefined
  const projectHeader = (c.req.header("x-oa-project") ?? "").trim() || undefined

  const upstreamUrl = new URL("/doc/upload", config.OA_RAG_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: c.req.raw.body, redirect: "manual" })
  } catch (err) {
    audit("admin.rag.doc.upload", {
      tenant: tenantHeader,
      project: projectHeader,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)

  const tenant = typeof (upstreamJson as any)?.tenant === "string" ? String((upstreamJson as any).tenant) : tenantHeader
  const project = typeof (upstreamJson as any)?.project === "string" ? String((upstreamJson as any).project) : projectHeader
  const file = typeof (upstreamJson as any)?.file === "string" ? String((upstreamJson as any).file) : undefined
  const status = typeof (upstreamJson as any)?.status === "string" ? String((upstreamJson as any).status) : undefined
  const passages = typeof (upstreamJson as any)?.passages === "number" ? Number((upstreamJson as any).passages) : undefined
  const replacedPassages = typeof (upstreamJson as any)?.replacedPassages === "number" ? Number((upstreamJson as any).replacedPassages) : undefined
  const storedBeforeCount = Array.isArray((upstreamJson as any)?.storedBefore) ? ((upstreamJson as any).storedBefore as unknown[]).length : undefined
  const deletedFilesCount = Array.isArray((upstreamJson as any)?.deletedFiles) ? ((upstreamJson as any).deletedFiles as unknown[]).length : undefined
  const fileErrorsCount =
    (upstreamJson as any)?.fileErrors && typeof (upstreamJson as any).fileErrors === "object"
      ? Object.keys((upstreamJson as any).fileErrors ?? {}).length
      : undefined

  audit("admin.rag.doc.upload", {
    tenant,
    project,
    file,
    status,
    passages,
    replacedPassages,
    storedBeforeCount,
    deletedFilesCount,
    fileErrorsCount,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/rag/search", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  return await proxyAdminJson(c, new URL("/admin/search", config.OA_RAG_BASE_URL))
})

app.post("/admin/api/rag/docs/list", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  return await proxyAdminJson(c, new URL("/doc/list", config.OA_RAG_BASE_URL))
})

app.post("/admin/api/rag/docs/update", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const file = typeof (input as any)?.file === "string" ? String((input as any).file) : undefined
  const status = typeof (input as any)?.status === "string" ? String((input as any).status) : undefined
  const reasonValue = typeof (input as any)?.reason === "string" ? String((input as any).reason) : undefined
  const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : undefined
  const tags =
    Array.isArray((input as any)?.tags) && (input as any).tags.length
      ? (input as any).tags
          .flatMap((v: unknown) => String(v).split(","))
          .map((s: string) => s.trim())
          .filter(Boolean)
          .slice(0, 64)
      : Array.isArray((input as any)?.tags)
        ? []
        : undefined

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/doc/update", config.OA_RAG_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.rag.doc.update", {
      tenant,
      project,
      file,
      status,
      tags,
      reason,
      reasonLen: typeof reason === "string" ? reason.length : undefined,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)
  audit("admin.rag.doc.update", {
    tenant,
    project,
    file,
    status,
    tags,
    reason,
    reasonLen: typeof reason === "string" ? reason.length : undefined,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/rag/docs/delete", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const file = typeof (input as any)?.file === "string" ? String((input as any).file) : undefined
  const deleteFile = typeof (input as any)?.deleteFile === "boolean" ? Boolean((input as any).deleteFile) : undefined
  const reasonValue = typeof (input as any)?.reason === "string" ? String((input as any).reason) : undefined
  const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : undefined

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/doc/delete", config.OA_RAG_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.rag.doc.delete", {
      tenant,
      project,
      file,
      deleteFile,
      reason,
      reasonLen: typeof reason === "string" ? reason.length : undefined,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)
  audit("admin.rag.doc.delete", {
    tenant,
    project,
    file,
    deleteFile,
    reason,
    reasonLen: typeof reason === "string" ? reason.length : undefined,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.post("/admin/api/rag/docs/ingest/retry", async (c) => {
  if (config.OA_RAG_MODE !== "external") return c.json({ ok: false, error: "rag_not_external" }, 503)
  const auth = checkAdminAuth(c)
  if (!auth.ok) {
    return c.json({ ok: false, error: "unauthorized" }, 401)
  }
  const token = auth.token
  const input = await c.req.json().catch(() => ({}))

  const tenant = typeof (input as any)?.tenant === "string" ? String((input as any).tenant) : undefined
  const project = typeof (input as any)?.project === "string" ? String((input as any).project) : undefined
  const file = typeof (input as any)?.file === "string" ? String((input as any).file) : undefined
  const maxCharsValue = typeof (input as any)?.maxChars === "number" ? Number((input as any).maxChars) : undefined
  const maxChars = typeof maxCharsValue === "number" && Number.isFinite(maxCharsValue) ? Math.floor(maxCharsValue) : undefined
  const reasonValue = typeof (input as any)?.reason === "string" ? String((input as any).reason) : undefined
  const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim().slice(0, 200) : undefined

  const headers: Record<string, string> = { "content-type": "application/json" }
  const authHeader = c.req.header("authorization")
  if (authHeader) headers["authorization"] = authHeader
  else if (token) headers["authorization"] = `Bearer ${token}`

  const upstreamUrl = new URL("/doc/ingest/retry", config.OA_RAG_BASE_URL)
  let upstream: Response
  const startedAt = Date.now()
  try {
    upstream = await fetch(upstreamUrl, { method: "POST", headers, body: JSON.stringify(input), redirect: "manual" })
  } catch (err) {
    audit("admin.rag.doc.ingest.retry", {
      tenant,
      project,
      file,
      maxChars,
      reason,
      reasonLen: typeof reason === "string" ? reason.length : undefined,
      ok: false,
      error: "upstream_fetch_failed",
      detail: err instanceof Error ? err.message : String(err),
    })
    return c.json({ ok: false, error: "upstream_fetch_failed", detail: err instanceof Error ? err.message : String(err) }, 502)
  }

  const upstreamJson = await upstream.clone().json().catch(() => undefined)
  audit("admin.rag.doc.ingest.retry", {
    tenant,
    project,
    file,
    maxChars,
    reason,
    reasonLen: typeof reason === "string" ? reason.length : undefined,
    ok: (upstreamJson as any)?.ok === true && upstream.status >= 200 && upstream.status < 300,
    upstreamStatus: upstream.status,
    elapsedMs: Date.now() - startedAt,
    upstreamOk: (upstreamJson as any)?.ok,
    upstreamError: (upstreamJson as any)?.error,
  })

  const outHeaders = new Headers()
  const ct = upstream.headers.get("content-type")
  if (ct) outHeaders.set("content-type", ct)
  outHeaders.set("cache-control", "no-store")
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders })
})

app.get("/admin/assets/:assetId", proxyAdminAsset)
app.on("HEAD", "/admin/assets/:assetId", proxyAdminAsset)

app.get("/assets/:assetId", proxyAsset)
app.on("HEAD", "/assets/:assetId", proxyAsset)

const mcpHandler = createMcpHandler({
  config,
  audit,
  hasSession: (sessionID) => sessions.has(sessionID),
  getSessionScope: (sessionID) => {
    const session = sessions.get(sessionID)
    if (!session) return
    return { sub: session.sub, tenant: session.tenant, project: session.project, tags: session.tags }
  },
  getSessionTurn: (sessionID) => {
    const session = sessions.get(sessionID)
    if (!session?.turn) return
    return { id: session.turn.id, startedAt: session.turn.startedAt, firstAudioAt: session.turn.firstAudioAt }
  },
  sendToClient: (sessionID, message) => {
    const session = sessions.get(sessionID)
    if (!session) return
    send(session, message)
  },
  setClientState: (sessionID, state) => {
    const session = sessions.get(sessionID)
    if (!session) return
    if (state === "listening" && session.presentAssetId) {
      setState(session, "presenting")
      return
    }
    setState(session, state)
  },
})

app.get("/readyz", async (c) => {
  const result: {
    ok: boolean
    checks: {
      opencode: { ok: boolean; detail?: string }
      asr: { ok: boolean; detail?: string }
      tts: { ok: boolean; detail?: string }
      media: { ok: boolean; detail?: string }
      rag: { ok: boolean; detail?: string }
    }
  } = {
    ok: true,
    checks: {
      opencode: { ok: true },
      asr: { ok: true },
      tts: { ok: true },
      media: { ok: true },
      rag: { ok: true },
    },
  }

  if (config.OA_LLM_MODE === "opencode") {
    try {
      await OpenCode.health(ocConfig())
    } catch (err) {
      result.ok = false
      result.checks.opencode = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  if (config.OA_ASR_MODE !== "disabled") {
    try {
      const base = httpBaseFromWsUrl(config.OA_ASR_WS_URL)
      const res = await fetch(new URL("/readyz", base))
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let detail = `status ${res.status}`
        try {
          const json = JSON.parse(text) as any
          if (typeof json?.detail === "string" && json.detail.trim()) detail = json.detail
        } catch {
          // ignore
        }
        throw new Error(detail)
      }
    } catch (err) {
      result.ok = false
      result.checks.asr = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  if (config.OA_TTS_MODE !== "disabled") {
    try {
      const res = await fetch(new URL("/readyz", config.OA_TTS_BASE_URL))
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        let detail = `status ${res.status}`
        try {
          const json = JSON.parse(text) as any
          if (typeof json?.detail === "string" && json.detail.trim()) detail = json.detail
        } catch {
          // ignore
        }
        throw new Error(detail)
      }
    } catch (err) {
      result.ok = false
      result.checks.tts = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  if (config.OA_MEDIA_MODE !== "disabled") {
    try {
      await Media.health({ baseUrl: config.OA_MEDIA_BASE_URL })
    } catch (err) {
      result.ok = false
      result.checks.media = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  if (config.OA_RAG_MODE !== "disabled") {
    try {
      await Rag.health({ baseUrl: config.OA_RAG_BASE_URL })
    } catch (err) {
      result.ok = false
      result.checks.rag = { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  return c.json(result, result.ok ? 200 : 503)
})

app.all("/mcp", async (c) => {
  const queryToken = c.req.query("token")
  const token = parseBearer(queryToken) ?? queryToken ?? parseBearer(c.req.header("authorization"))
  const identity = await auth.authenticate(token)
  if (!identity) return c.json({ ok: false, error: "unauthorized" }, 401)
  void identity
  return await mcpHandler(c.req.raw)
})

app.get(
  "/ws",
	  upgradeWebSocket((c) => {
	    const sessionID = Ws.SessionID.parse(c.req.query("sessionID") ?? "")
	    const connID = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
	    const queryToken = c.req.query("token")
	    const token = parseBearer(queryToken) ?? queryToken ?? parseBearer(c.req.header("authorization"))
	    return {
      onOpen(_event, ws) {
        void (async () => {
          let identity: Identity | undefined
          try {
            identity = await auth.authenticate(token)
          } catch (err) {
            sendToWs(ws, {
              v: 0,
              type: "asr.partial",
              sessionID,
              text: `鉴权失败：${err instanceof Error ? err.message : String(err)}`,
            })
            try {
              ws.close(1011, "auth error")
            } catch {
              // ignore
            }
            return
          }

          if (!identity) {
            sendToWs(ws, { v: 0, type: "asr.partial", sessionID, text: "未授权：token 无效/缺失" })
            try {
              ws.close(1008, "unauthorized")
            } catch {
              // ignore
            }
            return
          }

          const now = Date.now()
          const existing = sessions.get(sessionID)
          if (existing) {
            const oldTagsKey = (existing.tags ?? []).join("\u0000")
            const newTagsKey = (identity.tags ?? []).join("\u0000")
            if (existing.sub !== identity.sub || existing.tenant !== identity.tenant || existing.project !== identity.project || oldTagsKey !== newTagsKey) {
              audit("session.hijack_blocked", {
                sessionID,
                tenant: existing.tenant,
                project: existing.project,
                sub: existing.sub,
                tags: existing.tags,
                newSub: identity.sub,
                newTenant: identity.tenant,
                newProject: identity.project,
                newTags: identity.tags,
              })
              sendToWs(ws, { v: 0, type: "asr.partial", sessionID, text: "会话已被占用：请刷新页面生成新的 sessionID" })
              try {
                ws.close(1008, "session bound")
              } catch {
                // ignore
              }
              return
            }

            const oldWs = existing.ws
            existing.connID = connID
            existing.ws = ws
            existing.lastSeenAt = now
            existing.tokenHash = identity.tokenHash
            existing.tags = identity.tags
            send(existing, { v: 0, type: "state", sessionID, state: existing.state })
            audit("session.reconnect", { sessionID, tenant: existing.tenant, project: existing.project, sub: existing.sub })
            metricActiveSessions.set(undefined, sessions.size)
            try {
              oldWs.close(1000, "replaced")
            } catch {
              // ignore
            }
            return
          }

          if (sessions.size >= config.OA_GW_MAX_SESSIONS) {
            sendToWs(ws, {
              v: 0,
              type: "asr.partial",
              sessionID,
              text: `服务器繁忙：最多同时 ${config.OA_GW_MAX_SESSIONS} 路会话`,
            })
            try {
              ws.close(1013, "server busy")
            } catch {
              // ignore
            }
            return
          }

          const session: Session = {
            id: sessionID,
            connID,
            sub: identity.sub,
            tenant: identity.tenant,
            project: identity.project,
            tokenHash: identity.tokenHash,
            tags: identity.tags,
            ws,
            state: "idle",
            ttsSeq: 0,
            createdAt: now,
            lastSeenAt: now,
          }
          sessions.set(sessionID, session)
          setState(session, "idle")
          audit("session.open", { sessionID, tenant: session.tenant, project: session.project, sub: session.sub, tags: session.tags })
          metricActiveSessions.set(undefined, sessions.size)
        })()
      },
      onClose(_event, ws) {
        const session = sessions.get(sessionID)
        if (!session) return
        if (session.connID !== connID) return

        cleanupSession(session)
        sessions.delete(sessionID)
        audit("session.close", { sessionID, tenant: session.tenant, project: session.project, sub: session.sub })
        metricActiveSessions.set(undefined, sessions.size)
      },
      onMessage(event, ws) {
        const session = sessions.get(sessionID)
        if (!session) return
        if (session.connID !== connID) return
        touch(session)

        try {
          const raw = JSON.parse(String(event.data))
          const msg = Ws.ClientToGateway.parse(raw)

          if (msg.type === "interrupt") return handleInterrupt(session, msg.reason)
          if (msg.type === "text.in") return handleUtterance(session, msg.text, { emitAsrFinal: true })

          if (msg.type === "audio.in") {
            if (config.OA_ASR_MODE === "disabled") {
              const now = Date.now()
              if (!session.lastAudioAckAt || now - session.lastAudioAckAt > 800) {
                session.lastAudioAckAt = now
                send(session, { v: 0, type: "asr.partial", sessionID, text: "（采音中…；ASR disabled）" })
              }
              if (session.state === "idle") setState(session, "listening")
              return
            }

            if (session.asrSegmentStartedAt === undefined) session.asrSegmentStartedAt = Date.now()

            const scheduled = asrScheduler.send(sessionID, msg)
            if (scheduled.queued) {
              const now = Date.now()
              if (!session.lastAudioAckAt || now - session.lastAudioAckAt > 800) {
                session.lastAudioAckAt = now
                send(session, {
                  v: 0,
                  type: "asr.partial",
                  sessionID,
                  text: scheduled.droppedFrames > 0 ? "（ASR 排队过长：已丢弃部分音频）" : "（ASR 排队中…）",
                })
              }
            }
            if (session.state === "idle") setState(session, "listening")
            return
          }
        } catch (err) {
          metricErrors.inc({ stage: "ws_parse", tenant: session.tenant, project: session.project })
          sendToWs(ws, {
            v: 0,
            type: "asr.partial",
            sessionID,
            text: `（消息解析失败）${err instanceof Error ? err.message : String(err)}`,
          })
        }
      },
    }
  }),
)

const server = Bun.serve({
  hostname: config.OA_GATEWAY_HOST,
  port: config.OA_GATEWAY_PORT,
  fetch: app.fetch,
  websocket,
})

startOpenCodeEvents()
console.log(`open-assistant-gateway listening on ${server.url}`)
