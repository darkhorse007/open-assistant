import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import net from "node:net"
import { Ws } from "@open-assistant/protocol"

type Proc = ReturnType<typeof Bun.spawn>

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BUN_BIN = Bun.which("bun") ?? process.execPath
const OPENCODE_BIN = Bun.which("opencode") ?? Bun.which("opencode.cmd") ?? "opencode"
const expectedExit = new Set<number>()

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

async function waitForHttp(url: string, opts: { timeoutMs: number; intervalMs?: number; headers?: HeadersInit }) {
  const started = Date.now()
  const intervalMs = opts.intervalMs ?? 300

  while (Date.now() - started < opts.timeoutMs) {
    try {
      const res = await fetch(url, { headers: opts.headers })
      if (res.ok) return res
    } catch {
      // ignore
    }
    await sleep(intervalMs)
  }

  throw new Error(`Timed out waiting for HTTP: ${url}`)
}

async function waitForWs(url: string, opts: { timeoutMs: number }) {
  return await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)

    const t = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`Timed out waiting for WS message: ${url}`))
    }, opts.timeoutMs)

    ws.onmessage = () => {
      clearTimeout(t)
      ws.close()
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(t)
      try {
        ws.close()
      } catch {
        // ignore
      }
      reject(new Error(`WebSocket error: ${url}`))
    }
  })
}

async function pickPort(preferred: number) {
  const isOpen = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port })
      const timeout = setTimeout(() => {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
        resolve(false)
      }, 250)

      socket.on("connect", () => {
        clearTimeout(timeout)
        try {
          socket.end()
        } catch {
          // ignore
        }
        resolve(true)
      })
      socket.on("error", () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })

  const tryListen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.unref()
      server.on("error", (err) => reject(err))
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address()
        const selected = typeof addr === "object" && addr ? addr.port : port
        server.close(() => resolve(selected))
      })
    })

  if (!(await isOpen(preferred))) return preferred
  return await tryListen(0)
}

function spawn(name: string, cmd: string[], cwd: string, env?: Record<string, string | undefined>) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? process.env,
  })

  const pid = proc.pid
  proc.exited
    .then((code) => {
      if (code === 0) return
      if (pid && expectedExit.has(pid)) return
      log(`[${name}] exited with code ${code}`)
    })
    .catch(() => {})

  return proc
}

async function kill(proc: Proc) {
  const pid = proc.pid
  if (pid) {
    try {
      expectedExit.add(pid)
      if (process.platform === "win32") {
        await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited
      } else {
        process.kill(pid, "SIGKILL")
      }
    } catch {
      // ignore
    }
  }
  try {
    proc.kill()
  } catch {
    // ignore
  }
  await proc.exited.catch(() => {})
}

async function main() {
  const procs: Array<{ name: string; proc: Proc; keep?: boolean }> = []

  try {
    const ports = {
      gateway: await pickPort(7001),
      gatewayTags: await pickPort(7011),
      asr: await pickPort(7002),
      tts: await pickPort(7003),
      media: await pickPort(7004),
      rag: await pickPort(7005),
      web: await pickPort(5173),
      opencode: await pickPort(4096),
    }
    const gatewayHttp = `http://127.0.0.1:${ports.gateway}`
    const gatewayWs = `ws://127.0.0.1:${ports.gateway}`
    const gatewayTagsHttp = `http://127.0.0.1:${ports.gatewayTags}`
    const gatewayTagsWs = `ws://127.0.0.1:${ports.gatewayTags}`
    const webOrigin = `http://localhost:${ports.web}`

    log(
      `Using ports: gw=${ports.gateway} gwTags=${ports.gatewayTags} asr=${ports.asr} tts=${ports.tts} media=${ports.media} rag=${ports.rag} web=${ports.web} oc=${ports.opencode}`,
    )

    log("1) 启动 mocks + gateway + web（并验证 WS state）")
    const asr = spawn("asr-mock", [BUN_BIN, "run", "dev:asr"], ROOT, {
      ...process.env,
      OA_ASR_MOCK_HOST: "127.0.0.1",
      OA_ASR_MOCK_PORT: String(ports.asr),
    })
    procs.push({ name: "asr-mock", proc: asr })
    await waitForHttp(`http://127.0.0.1:${ports.asr}/healthz`, { timeoutMs: 20_000 })

    const tts = spawn("tts-mock", [BUN_BIN, "run", "dev:tts"], ROOT, {
      ...process.env,
      OA_TTS_MOCK_HOST: "127.0.0.1",
      OA_TTS_MOCK_PORT: String(ports.tts),
    })
    procs.push({ name: "tts-mock", proc: tts })
    await waitForHttp(`http://127.0.0.1:${ports.tts}/healthz`, { timeoutMs: 20_000 })

    const media = spawn("media-mock", [BUN_BIN, "run", "dev:media:mock"], ROOT, {
      ...process.env,
      OA_MEDIA_MOCK_HOST: "127.0.0.1",
      OA_MEDIA_MOCK_PORT: String(ports.media),
    })
    procs.push({ name: "media-mock", proc: media })
    await waitForHttp(`http://127.0.0.1:${ports.media}/healthz`, { timeoutMs: 20_000 })

    const rag = spawn("rag-mock", [BUN_BIN, "run", "dev:rag:mock"], ROOT, {
      ...process.env,
      OA_RAG_MOCK_HOST: "127.0.0.1",
      OA_RAG_MOCK_PORT: String(ports.rag),
    })
    procs.push({ name: "rag-mock", proc: rag })
    await waitForHttp(`http://127.0.0.1:${ports.rag}/healthz`, { timeoutMs: 20_000 })

    const gw = spawn("gateway", [BUN_BIN, "run", "dev:gateway"], ROOT, {
      ...process.env,
      OA_GATEWAY_HOST: "127.0.0.1",
      OA_GATEWAY_PORT: String(ports.gateway),
      OA_LLM_MODE: "mock",
      OA_OPENCODE_EVENTS_MODE: "disabled",
      OA_AUDIT_DB_PATH: ":memory:",
      OA_AUTH_MODE: "disabled",
      OA_ASR_MODE: "mock",
      OA_ASR_WS_URL: `ws://127.0.0.1:${ports.asr}/asr`,
      OA_TTS_MODE: "mock",
      OA_TTS_BASE_URL: `http://127.0.0.1:${ports.tts}`,
      OA_MEDIA_MODE: "mock",
      OA_MEDIA_BASE_URL: `http://127.0.0.1:${ports.media}`,
      OA_RAG_MODE: "mock",
      OA_RAG_BASE_URL: `http://127.0.0.1:${ports.rag}`,
    })
    procs.push({ name: "gateway", proc: gw })
    await waitForHttp(`${gatewayHttp}/healthz`, { timeoutMs: 20_000 })

    const web = spawn("web", [BUN_BIN, "run", "--cwd", "apps/web", "dev", "--", "--port", String(ports.web)], ROOT, {
      ...process.env,
      VITE_GATEWAY_PROXY_TARGET: gatewayHttp,
    })
    procs.push({ name: "web", proc: web })
    await waitForHttp(`http://127.0.0.1:${ports.web}`, { timeoutMs: 40_000 })

    await waitForWs(`${gatewayWs}/ws?sessionID=devready`, { timeoutMs: 10_000 })
    await new Promise<void>((resolve, reject) => {
      const url = `${gatewayWs}/ws?sessionID=devready-text`
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error("Timed out waiting for tts.text"))
      }, 10_000)

      ws.onopen = () => {
        ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID: "devready-text", text: "你好" }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg?.type === "tts.text") {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${url}`))
      }
    })

    log("\n1a2) 验证 tts.align + segmentId 绑定（tts.audio）")
    await new Promise<void>((resolve, reject) => {
      const sessionID = "devready-align"
      const url = `${gatewayWs}/ws?sessionID=${encodeURIComponent(sessionID)}`
      const ws = new WebSocket(url)

      let alignSegCount = 0
      const alignSegIds = new Set<string>()
      const audioSegIds = new Set<string>()

      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(
          new Error(
            `Timed out waiting for tts.align binding: alignSegCount=${alignSegCount} alignSegIds=${alignSegIds.size} audioSegIds=${audioSegIds.size}`,
          ),
        )
      }, 15_000)

      const maybeDone = () => {
        if (alignSegCount <= 0) return
        if (alignSegIds.size <= 0) return
        if (audioSegIds.size <= 0) return
        for (const id of alignSegIds) {
          if (audioSegIds.has(id)) {
            clearTimeout(timeout)
            ws.close()
            resolve()
            return
          }
        }
      }

      ws.onopen = () => {
        ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID, text: "你好" }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = Ws.GatewayToClient.parse(JSON.parse(String(event.data)))
          if (msg.type === "tts.align") {
            alignSegCount += msg.segments.length
            if (typeof msg.segmentId === "string" && msg.segmentId.trim()) alignSegIds.add(msg.segmentId.trim())
            maybeDone()
          } else if (msg.type === "tts.audio") {
            if (typeof msg.segmentId === "string" && msg.segmentId.trim()) audioSegIds.add(msg.segmentId.trim())
            maybeDone()
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${url}`))
      }
    })
    log("✓ tts.align binding OK")

    await new Promise<void>((resolve, reject) => {
      const url = `${gatewayWs}/ws?sessionID=devready-audio`
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error("Timed out waiting for ASR->TTS chain"))
      }, 15_000)

      ws.onopen = () => {
        const silent = btoa("\u0000".repeat(512))
        for (let i = 0; i < 10; i++) {
          ws.send(
            JSON.stringify({
              v: 0,
              type: "audio.in",
              sessionID: "devready-audio",
              seq: i,
              format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
              data: silent,
            }),
          )
        }
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg?.type === "tts.text") {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${url}`))
      }
    })
    log("✓ gateway/web 基础联通 OK")

    log("\n1b) 验证 ui.present(video) -> ui.stop(video)")
    await new Promise<void>((resolve, reject) => {
      const url = `${gatewayWs}/ws?sessionID=devready-ui`
      const ws = new WebSocket(url)
      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error("Timed out waiting for ui.present"))
      }, 10_000)

      ws.onopen = () => {
        ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID: "devready-ui", text: "/present demo-video" }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg?.type === "ui.present") {
            ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID: "devready-ui", text: "/stop video" }))
            return
          }
          if (msg?.type === "ui.stop" && (msg?.target === "video" || msg?.target === "all" || !msg?.target)) {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${url}`))
      }
    })
    log("✓ ui.present/ui.stop OK")

    log("\n1c) 验证 interrupt 会停止 tts+video 并可继续对话")
    await new Promise<void>((resolve, reject) => {
      const sessionID = "devready-interrupt"
      const url = `${gatewayWs}/ws?sessionID=${encodeURIComponent(sessionID)}`
      const ws = new WebSocket(url)

      let phase: "waitPresent" | "waitTtsText" | "waitStopAll" | "waitTtsText2" = "waitPresent"
      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // ignore
        }
        reject(new Error(`Timed out waiting for interrupt flow (phase=${phase})`))
      }, 20_000)

      ws.onopen = () => {
        ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID, text: "/present demo-video" }))
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))

          if (phase === "waitPresent" && msg?.type === "ui.present") {
            phase = "waitTtsText"
            ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID, text: "你好" }))
            return
          }

          if (phase === "waitTtsText" && msg?.type === "tts.text") {
            phase = "waitStopAll"
            ws.send(JSON.stringify({ v: 0, type: "interrupt", sessionID, reason: "button" }))
            return
          }

          if (phase === "waitStopAll" && msg?.type === "ui.stop" && msg?.target === "all") {
            phase = "waitTtsText2"
            ws.send(JSON.stringify({ v: 0, type: "text.in", sessionID, text: "继续" }))
            return
          }

          if (phase === "waitTtsText2" && msg?.type === "tts.text") {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${url}`))
      }
    })
    log("✓ interrupt stop(all) + continue OK")

    log("\n1d) 验证 /assets Range（video）")
    const assetsHead = await fetch(`${gatewayHttp}/assets/demo-video`, { method: "HEAD" })
    if (!assetsHead.ok) throw new Error(`/assets/demo-video HEAD failed: ${assetsHead.status}`)
    const ct = assetsHead.headers.get("content-type") ?? ""
    if (!ct.includes("video/")) throw new Error(`/assets content-type unexpected: ${ct}`)
    const ar = assetsHead.headers.get("accept-ranges")
    if (ar !== "bytes") throw new Error(`/assets accept-ranges unexpected: ${ar ?? "(null)"}`)
    const assetsRange = await fetch(`${gatewayHttp}/assets/demo-video`, { headers: { Range: "bytes=0-31" } })
    if (assetsRange.status !== 206) throw new Error(`/assets range expected 206, got ${assetsRange.status}`)
    const rangeBytes = await assetsRange.arrayBuffer()
    if (rangeBytes.byteLength <= 0) throw new Error("/assets range returned empty body")
    log("✓ /assets Range OK")

    log("\n1d2) 验证 /audit/healthz + /audit/search")
    const auditHealth = await fetch(`${gatewayHttp}/audit/healthz`).then((r) => r.json().catch(() => ({})))
    if (auditHealth?.ok !== true) throw new Error(`/audit/healthz unexpected: ${JSON.stringify(auditHealth)}`)
    const auditSearch = await fetch(`${gatewayHttp}/audit/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5, order: "desc" }),
    }).then((r) => r.json().catch(() => ({})))
    if (auditSearch?.ok !== true || !Array.isArray(auditSearch?.events)) {
      throw new Error(`/audit/search unexpected: ${JSON.stringify(auditSearch)}`)
    }
    log("✓ /audit health/search OK")

    log("\n1d2b) 验证 /audit/sessions")
    const auditSessions = await fetch(`${gatewayHttp}/audit/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5, order: "desc" }),
    }).then((r) => r.json().catch(() => ({})))
    if (auditSessions?.ok !== true || !Array.isArray(auditSessions?.sessions)) {
      throw new Error(`/audit/sessions unexpected: ${JSON.stringify(auditSessions)}`)
    }
    log("✓ /audit sessions OK")

    log("\n1d3) 验证 /audit/emit（rag.ingest.*）")
    const auditEmit = await fetch(`${gatewayHttp}/audit/emit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "rag.ingest.test",
        fields: { tenant: "default", project: "open-assistant", file: "dev-ready.md", reason: "dev-ready" },
      }),
    }).then((r) => r.json().catch(() => ({})))
    if (auditEmit?.ok !== true) {
      throw new Error(`/audit/emit unexpected: ${JSON.stringify(auditEmit)}`)
    }

    const auditSearch2 = await fetch(`${gatewayHttp}/audit/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "rag.ingest.test", file: "dev-ready.md", reason: "dev-ready", limit: 5, order: "desc" }),
    }).then((r) => r.json().catch(() => ({})))
    if (auditSearch2?.ok !== true || !Array.isArray(auditSearch2?.events) || auditSearch2?.events.length < 1) {
      throw new Error(`/audit/search after emit unexpected: ${JSON.stringify(auditSearch2)}`)
    }
    log("✓ /audit emit OK")

    log("\n1e) 验证 Gateway MCP（tools/list + ui.present/ui.stop）")
    const mcpUrl = `${gatewayHttp}/mcp`
    const wsSessionId = `devready-mcp-${Date.now()}`
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${gatewayWs}/ws?sessionID=${encodeURIComponent(wsSessionId)}`)
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for WS open")), 8000)
      ws.onopen = () => {
        clearTimeout(timeout)
        ws.close()
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error("WS open failed"))
      }
    })

    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "dev-ready", version: "0.0.0" } },
    }
    const initRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(initReq),
    })
    if (!initRes.ok) throw new Error(`MCP initialize failed: ${initRes.status}`)
    const mcpSessionId = initRes.headers.get("mcp-session-id")
    if (!mcpSessionId) throw new Error("MCP initialize missing mcp-session-id header")
    await initRes.json().catch(() => {})

    const notifyRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    if (notifyRes.status !== 202) throw new Error(`MCP initialized notification expected 202, got ${notifyRes.status}`)

    const toolsRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
    if (!toolsRes.ok) throw new Error(`MCP tools/list failed: ${toolsRes.status}`)
    const toolsJson = await toolsRes.json()
    const toolNames: string[] = (toolsJson?.result?.tools ?? []).map((t: any) => String(t?.name ?? ""))
    for (const name of ["rag.search", "asset.search", "ui.present", "ui.stop"]) {
      if (!toolNames.includes(name)) throw new Error(`MCP tools/list missing tool: ${name}`)
    }

    const uiWs = new WebSocket(`${gatewayWs}/ws?sessionID=${encodeURIComponent(wsSessionId)}`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for ui.present")), 10_000)
      let called = false
      let callTimer: ReturnType<typeof setTimeout> | undefined

      const callUiPresent = () => {
        if (called) return
        called = true
        void (async () => {
          const callPresent = await fetch(mcpUrl, {
            method: "POST",
            headers: {
              Accept: "application/json, text/event-stream",
              "content-type": "application/json",
              "mcp-session-id": mcpSessionId,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "ui.present", arguments: { sessionID: wsSessionId, assetId: "demo-video", autoplay: false } },
            }),
          })
          if (!callPresent.ok) reject(new Error(`MCP ui.present call failed: ${callPresent.status}`))
        })().catch((err) => reject(err))
      }

      uiWs.onopen = () => {
        // Session registration in Gateway happens after async auth; give it a moment.
        callTimer = setTimeout(callUiPresent, 200)
      }

      uiWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          // Wait for the session to be fully registered (auth + session map) before calling MCP.
          if (!called && msg?.type === "state") {
            if (callTimer) clearTimeout(callTimer)
            callTimer = undefined
            callUiPresent()
          }
          if (msg?.type === "ui.present") {
            clearTimeout(timeout)
            if (callTimer) clearTimeout(callTimer)
            uiWs.close()
            resolve()
          }
        } catch {
          // ignore
        }
      }
      uiWs.onerror = () => {
        clearTimeout(timeout)
        if (callTimer) clearTimeout(callTimer)
        reject(new Error("WS error (ui.present)"))
      }
    })

    await fetch(mcpUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": mcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ui.stop", arguments: { sessionID: wsSessionId, target: "video" } },
      }),
    }).catch(() => {})

    log("✓ MCP tools/list + ui.present/ui.stop OK")

    log("\n1f) 验证 tags 强制（rag.search/asset.search/ui.present + /assets 访问控制）")
    const gwTags = spawn("gateway-tags", [BUN_BIN, "run", "dev:gateway"], ROOT, {
      ...process.env,
      OA_GATEWAY_HOST: "127.0.0.1",
      OA_GATEWAY_PORT: String(ports.gatewayTags),
      OA_LLM_MODE: "mock",
      OA_OPENCODE_EVENTS_MODE: "disabled",
      OA_AUDIT_DB_PATH: ":memory:",
      OA_AUTH_MODE: "disabled",
      OA_AUTH_TAGS_MODE: "enforce",
      OA_AUTH_TAGS: "demo",
      OA_ASR_MODE: "mock",
      OA_ASR_WS_URL: `ws://127.0.0.1:${ports.asr}/asr`,
      OA_TTS_MODE: "mock",
      OA_TTS_BASE_URL: `http://127.0.0.1:${ports.tts}`,
      OA_MEDIA_MODE: "mock",
      OA_MEDIA_BASE_URL: `http://127.0.0.1:${ports.media}`,
      OA_RAG_MODE: "mock",
      OA_RAG_BASE_URL: `http://127.0.0.1:${ports.rag}`,
    })
    procs.push({ name: "gateway-tags", proc: gwTags })
    await waitForHttp(`${gatewayTagsHttp}/healthz`, { timeoutMs: 20_000 })

    const mcpTagsUrl = `${gatewayTagsHttp}/mcp`
    const tagsSessionId = `devready-tags-${Date.now()}`

    const tagsWs = new WebSocket(`${gatewayTagsWs}/ws?sessionID=${encodeURIComponent(tagsSessionId)}`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for tags WS state")), 10_000)
      tagsWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg?.type === "state") {
            clearTimeout(timeout)
            resolve()
          }
        } catch {
          // ignore
        }
      }
      tagsWs.onerror = () => {
        clearTimeout(timeout)
        reject(new Error("tags WS error"))
      }
    })

    const tagsInitRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(initReq),
    })
    if (!tagsInitRes.ok) throw new Error(`MCP(tags) initialize failed: ${tagsInitRes.status}`)
    const tagsMcpSessionId = tagsInitRes.headers.get("mcp-session-id")
    if (!tagsMcpSessionId) throw new Error("MCP(tags) initialize missing mcp-session-id header")
    await tagsInitRes.json().catch(() => {})

    const tagsNotifyRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    if (tagsNotifyRes.status !== 202) throw new Error(`MCP(tags) initialized notification expected 202, got ${tagsNotifyRes.status}`)

    const ragOkRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "rag.search", arguments: { sessionID: tagsSessionId, query: "demo", topK: 5 } } }),
    })
    if (!ragOkRes.ok) throw new Error(`MCP(tags) rag.search failed: ${ragOkRes.status}`)
    const ragOkJson = await ragOkRes.json()
    const ragOkPassages = ragOkJson?.result?.structuredContent?.passages ?? []
    if (ragOkJson?.result?.isError || !Array.isArray(ragOkPassages) || ragOkPassages.length < 1) {
      throw new Error(`MCP(tags) rag.search unexpected: ${JSON.stringify(ragOkJson)}`)
    }

    const ragBadRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "rag.search", arguments: { sessionID: tagsSessionId, query: "demo", topK: 5, filters: { tags: ["finance"] } } },
      }),
    })
    if (!ragBadRes.ok) throw new Error(`MCP(tags) rag.search(bad) HTTP failed: ${ragBadRes.status}`)
    const ragBadJson = await ragBadRes.json()
    if (!ragBadJson?.result?.isError) throw new Error(`MCP(tags) rag.search(bad) expected isError: ${JSON.stringify(ragBadJson)}`)

    const assetOkRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "asset.search", arguments: { sessionID: tagsSessionId, query: "video", topK: 20 } } }),
    })
    if (!assetOkRes.ok) throw new Error(`MCP(tags) asset.search failed: ${assetOkRes.status}`)
    const assetOkJson = await assetOkRes.json()
    const assets = assetOkJson?.result?.structuredContent?.assets ?? []
    if (assetOkJson?.result?.isError || !Array.isArray(assets)) throw new Error(`MCP(tags) asset.search unexpected: ${JSON.stringify(assetOkJson)}`)
    if (assets.some((a: any) => String(a?.assetId ?? "") === "private-video")) throw new Error("MCP(tags) asset.search leaked private-video")

    const assetBadRes = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "asset.search", arguments: { sessionID: tagsSessionId, query: "video", topK: 20, filters: { tags: ["finance"] } } },
      }),
    })
    if (!assetBadRes.ok) throw new Error(`MCP(tags) asset.search(bad) HTTP failed: ${assetBadRes.status}`)
    const assetBadJson = await assetBadRes.json()
    if (!assetBadJson?.result?.isError) throw new Error(`MCP(tags) asset.search(bad) expected isError: ${JSON.stringify(assetBadJson)}`)

    const waitUiPresent = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for ui.present (tags)")), 10_000)
      tagsWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg?.type === "ui.present" && msg?.assetId === "demo-video") {
            clearTimeout(timeout)
            resolve()
          }
        } catch {
          // ignore
        }
      }
      tagsWs.onerror = () => {
        clearTimeout(timeout)
        reject(new Error("tags WS error while waiting ui.present"))
      }
    })

    const uiOk = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "ui.present", arguments: { sessionID: tagsSessionId, assetId: "demo-video", autoplay: false } },
      }),
    })
    if (!uiOk.ok) throw new Error(`MCP(tags) ui.present failed: ${uiOk.status}`)
    const uiOkJson = await uiOk.json()
    if (uiOkJson?.result?.isError) throw new Error(`MCP(tags) ui.present unexpected: ${JSON.stringify(uiOkJson)}`)

    await waitUiPresent

    const uiBad = await fetch(mcpTagsUrl, {
      method: "POST",
      headers: { Accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-session-id": tagsMcpSessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: { name: "ui.present", arguments: { sessionID: tagsSessionId, assetId: "private-video", autoplay: false } },
      }),
    })
    if (!uiBad.ok) throw new Error(`MCP(tags) ui.present(private) HTTP failed: ${uiBad.status}`)
    const uiBadJson = await uiBad.json()
    if (!uiBadJson?.result?.isError) throw new Error(`MCP(tags) ui.present(private) expected isError: ${JSON.stringify(uiBadJson)}`)

    const assetsOk = await fetch(`${gatewayTagsHttp}/assets/demo-video`, { method: "HEAD" })
    if (!assetsOk.ok) throw new Error(`/assets/demo-video(tags) HEAD failed: ${assetsOk.status}`)
    const assetsDenied = await fetch(`${gatewayTagsHttp}/assets/private-video`, { method: "HEAD" })
    if (assetsDenied.status !== 404) throw new Error(`/assets/private-video(tags) expected 404, got ${assetsDenied.status}`)

    try {
      tagsWs.close()
    } catch {
      // ignore
    }
    log("✓ tags enforce (mcp + /assets) OK")

    log("\n2) 验证 OpenCode Server：/global/health + CORS")
    const opencodeHealthUrl = `http://127.0.0.1:${ports.opencode}/global/health`
    let opencodeRunning = false
    try {
      const res = await fetch(opencodeHealthUrl)
      opencodeRunning = res.ok
    } catch {
      opencodeRunning = false
    }

    if (!opencodeRunning) {
      const oc = spawn(
        "opencode",
        [OPENCODE_BIN, "serve", "--port", String(ports.opencode), "--hostname", "127.0.0.1", "--cors", webOrigin],
        ROOT,
      )
      procs.push({ name: "opencode", proc: oc })
      await waitForHttp(opencodeHealthUrl, { timeoutMs: 40_000 })
    }

    const origin = webOrigin
    const res = await fetch(opencodeHealthUrl, { headers: { Origin: origin } })
    if (!res.ok) throw new Error(`OpenCode /global/health failed: ${res.status}`)
    const allowOrigin = res.headers.get("access-control-allow-origin")
    if (allowOrigin !== "*" && allowOrigin !== origin) {
      throw new Error(`OpenCode CORS not configured. got access-control-allow-origin=${allowOrigin ?? "(null)"}`)
    }
    log("✓ OpenCode /global/health + CORS OK")

    log("\n3) 验证 Phase 0 集成路线（mock 优先）")
    const ready = await fetch(`${gatewayHttp}/readyz`).then((r) => r.json())
    log(`✓ gateway /readyz: ${JSON.stringify(ready)}`)

    log("\n全部开发就绪检查通过。可以开始推进 Phase 0。")
  } finally {
    for (const { proc } of procs.reverse()) {
      await kill(proc)
    }
  }
}

await main()
