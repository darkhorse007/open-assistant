export type OidcConfig = {
  issuer: string
  clientId: string
  redirectUri: string
  scope: string
}

export type OidcDiscoveryDocument = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
  revocation_endpoint?: string
}

export type OidcTokens = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  tokenType?: string
  scope?: string
  obtainedAtMs: number
  expiresAtMs: number
  refreshExpiresAtMs?: number
}

function base64FromBytes(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

export function base64UrlFromBytes(bytes: Uint8Array) {
  return base64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function bytesFromBase64(b64: string) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesFromBase64Url(input: string) {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4)
  return bytesFromBase64(padded)
}

export function stringFromBase64Url(input: string) {
  const bytes = bytesFromBase64Url(input)
  return new TextDecoder().decode(bytes)
}

export function randomBase64Url(bytes = 32) {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return base64UrlFromBytes(buf)
}

export async function sha256Base64Url(input: string) {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return base64UrlFromBytes(new Uint8Array(digest))
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  const payload = parts[1]
  if (!payload) return undefined
  try {
    const json = stringFromBase64Url(payload)
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object") return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function oidcWellKnownUrl(issuer: string) {
  const trimmed = issuer.trim().replace(/\/+$/, "")
  return `${trimmed}/.well-known/openid-configuration`
}

export async function discoverOidc(issuer: string): Promise<OidcDiscoveryDocument> {
  const res = await fetch(oidcWellKnownUrl(issuer))
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const detail = typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}${detail}`)
  }
  const doc = json as any
  if (typeof doc?.issuer !== "string") throw new Error("OIDC discovery: missing issuer")
  if (typeof doc?.authorization_endpoint !== "string") throw new Error("OIDC discovery: missing authorization_endpoint")
  if (typeof doc?.token_endpoint !== "string") throw new Error("OIDC discovery: missing token_endpoint")
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    end_session_endpoint: typeof doc.end_session_endpoint === "string" ? doc.end_session_endpoint : undefined,
    revocation_endpoint: typeof doc.revocation_endpoint === "string" ? doc.revocation_endpoint : undefined,
  }
}

export function buildAuthorizeUrl(
  doc: OidcDiscoveryDocument,
  cfg: OidcConfig,
  opts: { state: string; codeChallenge: string; prompt?: "login" | "none" },
) {
  const url = new URL(doc.authorization_endpoint)
  url.searchParams.set("client_id", cfg.clientId)
  url.searchParams.set("redirect_uri", cfg.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", cfg.scope)
  url.searchParams.set("state", opts.state)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("code_challenge", opts.codeChallenge)
  if (opts.prompt) url.searchParams.set("prompt", opts.prompt)
  return url.toString()
}

function parseTokenResponse(json: any): OidcTokens {
  const obtainedAtMs = Date.now()
  const accessToken = typeof json?.access_token === "string" ? json.access_token : ""
  const refreshToken = typeof json?.refresh_token === "string" ? json.refresh_token : undefined
  const idToken = typeof json?.id_token === "string" ? json.id_token : undefined
  const tokenType = typeof json?.token_type === "string" ? json.token_type : undefined
  const scope = typeof json?.scope === "string" ? json.scope : undefined
  const expiresIn = Number(json?.expires_in ?? 0)
  const refreshExpiresIn = Number(json?.refresh_expires_in ?? 0)
  if (!accessToken) throw new Error("OIDC token response: missing access_token")
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error("OIDC token response: invalid expires_in")
  const expiresAtMs = obtainedAtMs + expiresIn * 1000
  const refreshExpiresAtMs = Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0 ? obtainedAtMs + refreshExpiresIn * 1000 : undefined
  return { accessToken, refreshToken, idToken, tokenType, scope, obtainedAtMs, expiresAtMs, refreshExpiresAtMs }
}

export async function exchangeCode(
  doc: OidcDiscoveryDocument,
  cfg: OidcConfig,
  opts: { code: string; codeVerifier: string },
) {
  const body = new URLSearchParams()
  body.set("grant_type", "authorization_code")
  body.set("client_id", cfg.clientId)
  body.set("redirect_uri", cfg.redirectUri)
  body.set("code", opts.code)
  body.set("code_verifier", opts.codeVerifier)

  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = typeof json?.error === "string" ? json.error : "token_exchange_failed"
    const detail = typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
    throw new Error(`OIDC token exchange failed (${err})${detail}`)
  }
  return parseTokenResponse(json)
}

export async function refreshTokens(
  doc: OidcDiscoveryDocument,
  cfg: OidcConfig,
  opts: { refreshToken: string },
) {
  const body = new URLSearchParams()
  body.set("grant_type", "refresh_token")
  body.set("client_id", cfg.clientId)
  body.set("refresh_token", opts.refreshToken)

  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = typeof json?.error === "string" ? json.error : "refresh_failed"
    const detail = typeof json?.error_description === "string" ? `: ${json.error_description}` : ""
    throw new Error(`OIDC refresh failed (${err})${detail}`)
  }
  return parseTokenResponse(json)
}

