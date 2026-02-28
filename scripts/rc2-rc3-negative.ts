import { setTimeout as sleep } from "node:timers/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

type Proc = ReturnType<typeof Bun.spawn>

type ProbeResult = {
  sessionID: string
  opened: boolean
  closed: boolean
  code?: number
  ws?: WebSocket
}

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BUN_BIN = Bun.which("bun") ?? process.execPath

const ports = {
  gateway: Number(process.env.OA_RC23_GATEWAY_PORT ?? 17001),
  media: Number(process.env.OA_RC23_MEDIA_PORT ?? 17004),
  rag: Number(process.env.OA_RC23_RAG_PORT ?? 17005),
  oidc: Number(process.env.OA_RC23_OIDC_PORT ?? 19100),
}

const host = "127.0.0.1"
const gatewayBase = `http://${host}:${ports.gateway}`
const gatewayWs = `ws://${host}:${ports.gateway}`
const issuerRoot = `http://${host}:${ports.oidc}`
const issuer = `${issuerRoot}/realms/openassistant`
const mcpToken = process.env.OA_RC23_MCP_TOKEN ?? "rc-mcp-token"

const procs: Array<{ name: string; proc: Proc }> = []
const openSockets: WebSocket[] = []
const expectedExit = new Set<number>()

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message)
}

function b64urlFromBytes(bytes: Uint8Array): string {
  const bin = String.fromCharCode(...bytes)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function b64urlFromJson(obj: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(obj)))
}

async function signJwt(params: {
  privateKey: CryptoKey
  kid: string
  iss: string
  aud: string
  sub: string
  tenant: string
  project: string
  tags?: string[]
  expiresInSec?: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = {
    iss: params.iss,
    aud: params.aud,
    sub: params.sub,
    iat: now,
    exp: now + (params.expiresInSec ?? 600),
    tenant: params.tenant,
    project: params.project,
  }
  if (params.tags !== undefined) payload.tags = params.tags

  const header = { alg: "RS256", typ: "JWT", kid: params.kid }
  const encodedHeader = b64urlFromJson(header)
  const encodedPayload = b64urlFromJson(payload)
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    params.privateKey,
    new TextEncoder().encode(signingInput),
  )

  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`
}

function spawnProc(name: string, cmd: string[], env?: Record<string, string | undefined>) {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    env: env ?? process.env,
    stdout: "ignore",
    stderr: "pipe",
  })
  procs.push({ name, proc })
  const pid = proc.pid
  proc.exited.then((code) => {
    if (pid && expectedExit.has(pid)) return
    if (code !== 0) {
      log(`[${name}] exited with code ${code}`)
    }
  })
  return proc
}

async function killProc(proc: Proc) {
  const pid = proc.pid
  if (pid) {
    expectedExit.add(pid)
    try {
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

async function waitForHttp(url: string, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // ignore
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for HTTP: ${url}`)
}

async function wsProbe(token: string | undefined, opts?: { keepAlive?: boolean; settleMs?: number }): Promise<ProbeResult> {
  const keepAlive = Boolean(opts?.keepAlive)
  const settleMs = opts?.settleMs ?? 1200
  const sessionID = `rc2-${Date.now()}-${Math.random().toString(36).slice(2)}`

  const q = new URLSearchParams({ sessionID })
  if (token) q.set("token", token)
  const url = `${gatewayWs}/ws?${q.toString()}`

  return await new Promise<ProbeResult>((resolve) => {
    const ws = new WebSocket(url)
    let opened = false
    let done = false

    const finish = (result: ProbeResult) => {
      if (done) return
      done = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (keepAlive) {
          openSockets.push(ws)
          finish({ sessionID, opened, closed: false, ws })
        } else {
          try {
            ws.close(1000, "probe done")
          } catch {
            // ignore
          }
          finish({ sessionID, opened, closed: false })
        }
      } else {
        finish({ sessionID, opened, closed: true })
      }
    }, settleMs)

    ws.onopen = () => {
      opened = true
    }

    ws.onclose = (evt) => {
      clearTimeout(timer)
      finish({ sessionID, opened, closed: true, code: evt.code })
    }

    ws.onerror = () => {
      // close event should follow
    }
  })
}

function withDefaults(overrides: Partial<{ aud: string; iss: string; tags: string[] | undefined }>) {
  return {
    aud: overrides.aud ?? "open-assistant-web",
    iss: overrides.iss ?? issuer,
    tags: overrides.tags,
  }
}

async function main() {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair

  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<string, unknown>
  const kid = "rc2rc3-k1"
  const jwk = { ...publicJwk, kid, alg: "RS256", use: "sig" }

  const oidcServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuerRoot)
    if (url.pathname === "/realms/openassistant/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuerRoot}/jwks` }))
      return
    }
    if (url.pathname === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404)
    res.end("not found")
  })

  await new Promise<void>((resolve, reject) => {
    oidcServer.once("error", reject)
    oidcServer.listen(ports.oidc, host, () => resolve())
  })

  const makeToken = async (overrides: Partial<{ aud: string; iss: string; tags: string[] | undefined }>) => {
    const o = withDefaults(overrides)
    return await signJwt({
      privateKey: keyPair.privateKey,
      kid,
      iss: o.iss,
      aud: o.aud,
      sub: "demo-user",
      tenant: "default",
      project: "open-assistant",
      tags: o.tags,
    })
  }

  try {
    log("Starting RC2/RC3 negative-check stack...")

    spawnProc("media-mock", [BUN_BIN, "run", "dev:media:mock"], {
      ...process.env,
      OA_MEDIA_MOCK_HOST: host,
      OA_MEDIA_MOCK_PORT: String(ports.media),
    })

    spawnProc("rag-mock", [BUN_BIN, "run", "dev:rag:mock"], {
      ...process.env,
      OA_RAG_MOCK_HOST: host,
      OA_RAG_MOCK_PORT: String(ports.rag),
    })

    await waitForHttp(`http://${host}:${ports.media}/healthz`)
    await waitForHttp(`http://${host}:${ports.rag}/healthz`)

    spawnProc("gateway", [BUN_BIN, "run", "dev:gateway"], {
      ...process.env,
      OA_GATEWAY_HOST: host,
      OA_GATEWAY_PORT: String(ports.gateway),
      OA_AUTH_MODE: "oidc",
      OA_OIDC_ISSUER: issuer,
      OA_OIDC_JWKS_URL: `${issuerRoot}/jwks`,
      OA_OIDC_AUDIENCE: "open-assistant-web",
      OA_OIDC_REQUIRE_TAGS: "true",
      OA_AUTH_TAGS_MODE: "enforce",
      OA_OPENCODE_MCP_TOKEN: mcpToken,
      OA_ASR_MODE: "disabled",
      OA_TTS_MODE: "disabled",
      OA_MEDIA_MODE: "mock",
      OA_MEDIA_BASE_URL: `http://${host}:${ports.media}`,
      OA_RAG_MODE: "mock",
      OA_RAG_BASE_URL: `http://${host}:${ports.rag}`,
      OA_LLM_MODE: "mock",
      OA_OPENCODE_EVENTS_MODE: "disabled",
    })

    await waitForHttp(`${gatewayBase}/healthz`)

    const validToken = await makeToken({ tags: ["demo"] })
    const wrongAudToken = await makeToken({ tags: ["demo"], aud: "wrong-aud" })
    const wrongIssuerToken = await makeToken({ tags: ["demo"], iss: `${issuerRoot}/realms/other` })
    const missingTagsToken = await makeToken({ tags: undefined })

    const wsMissingToken = await wsProbe(undefined)
    const wsWrongAud = await wsProbe(wrongAudToken)
    const wsWrongIssuer = await wsProbe(wrongIssuerToken)
    const wsMissingTags = await wsProbe(missingTagsToken)
    const wsValid = await wsProbe(validToken, { keepAlive: true })

    const mcpNoToken = await fetch(`${gatewayBase}/mcp`)
    const mcpWithToken = await fetch(`${gatewayBase}/mcp?token=${encodeURIComponent(mcpToken)}`)

    const initializeRes = await fetch(`${gatewayBase}/mcp?token=${encodeURIComponent(mcpToken)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "rc2rc3-negative", version: "1.0.0" },
        },
      }),
    })

    const mcpSessionID = initializeRes.headers.get("mcp-session-id") ?? ""

    const mismatchRes = await fetch(`${gatewayBase}/mcp?token=${encodeURIComponent(mcpToken)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": mcpSessionID,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "rag.search",
          arguments: {
            sessionID: wsValid.sessionID,
            query: "hello",
            filters: { tags: ["forbidden-tag"] },
          },
        },
      }),
    })
    const mismatchJson: any = await mismatchRes.json().catch(() => undefined)

    const allowedRes = await fetch(`${gatewayBase}/mcp?token=${encodeURIComponent(mcpToken)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": mcpSessionID,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "rag.search",
          arguments: {
            sessionID: wsValid.sessionID,
            query: "hello",
            filters: { tags: ["demo"] },
          },
        },
      }),
    })
    const allowedJson: any = await allowedRes.json().catch(() => undefined)

    const assetsMissingToken = await fetch(`${gatewayBase}/assets/demo-video`)
    const assetsWrongAud = await fetch(`${gatewayBase}/assets/demo-video?token=${encodeURIComponent(wrongAudToken)}`)
    const assetsWrongIssuer = await fetch(`${gatewayBase}/assets/demo-video?token=${encodeURIComponent(wrongIssuerToken)}`)
    const assetsMissingTags = await fetch(`${gatewayBase}/assets/demo-video?token=${encodeURIComponent(missingTagsToken)}`)

    const checks = [
      { ok: wsMissingToken.closed, name: "ws_missing_token_rejected" },
      { ok: wsWrongAud.closed, name: "ws_wrong_aud_rejected" },
      { ok: wsWrongIssuer.closed, name: "ws_wrong_issuer_rejected" },
      { ok: wsMissingTags.closed, name: "ws_missing_tags_rejected" },
      { ok: wsValid.opened && !wsValid.closed, name: "ws_valid_token_allowed" },

      { ok: mcpNoToken.status === 401, name: "mcp_without_token_401" },
      { ok: mcpWithToken.status === 400, name: "mcp_with_token_no_init_400" },
      { ok: initializeRes.status === 200 && Boolean(mcpSessionID), name: "mcp_initialize_ok" },

      { ok: mismatchRes.status === 200, name: "tags_mismatch_call_200" },
      { ok: Boolean(mismatchJson?.result?.isError), name: "tags_mismatch_is_error" },
      { ok: String(mismatchJson?.result?.content?.[0]?.text ?? "").includes("tag mismatch"), name: "tags_mismatch_message" },
      { ok: allowedRes.status === 200, name: "tags_allowed_call_200" },
      { ok: !Boolean(allowedJson?.result?.isError), name: "tags_allowed_success" },

      { ok: assetsMissingToken.status === 401, name: "assets_missing_token_401" },
      { ok: assetsWrongAud.status === 401, name: "assets_wrong_aud_401" },
      { ok: assetsWrongIssuer.status === 401, name: "assets_wrong_issuer_401" },
      { ok: assetsMissingTags.status === 401, name: "assets_missing_tags_401" },
    ]

    const failed = checks.filter((c) => !c.ok).map((c) => c.name)

    const result = {
      ok: failed.length === 0,
      failed,
      context: {
        gatewayBase,
        gatewayWs,
        issuer,
      },
      status: {
        wsMissingToken,
        wsWrongAud,
        wsWrongIssuer,
        wsMissingTags,
        wsValid: { sessionID: wsValid.sessionID, opened: wsValid.opened, closed: wsValid.closed },
        mcpNoToken: mcpNoToken.status,
        mcpWithToken: mcpWithToken.status,
        mcpInitialize: initializeRes.status,
        assetsMissingToken: assetsMissingToken.status,
        assetsWrongAud: assetsWrongAud.status,
        assetsWrongIssuer: assetsWrongIssuer.status,
        assetsMissingTags: assetsMissingTags.status,
      },
    }

    const out = JSON.stringify(result, null, 2)
    log(out)

    const outFile = process.env.OA_RC23_OUTPUT_FILE?.trim()
    if (outFile) {
      await Bun.write(outFile, `${out}\n`)
      log(`Output written: ${outFile}`)
    }

    if (failed.length) process.exitCode = 1
  } finally {
    for (const ws of openSockets) {
      try {
        ws.close(1000, "done")
      } catch {
        // ignore
      }
    }
    for (const { proc } of procs.reverse()) {
      await killProc(proc)
    }
    await new Promise<void>((resolve) => oidcServer.close(() => resolve()))
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
