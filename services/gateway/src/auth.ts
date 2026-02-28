import { createHash } from "node:crypto"
import z from "zod/v4"
import { createRemoteJWKSet, jwtVerify } from "jose"

export type AuthMode = "disabled" | "static" | "oidc"

export type Identity = {
  sub: string
  tenant: string
  project: string
  tokenHash?: string
  tags?: string[]
}

export type AuthConfig = {
  OA_AUTH_MODE: AuthMode
  OA_AUTH_TOKEN?: string
  OA_AUTH_TENANT: string
  OA_AUTH_PROJECT: string
  OA_AUTH_TAGS?: string

  OA_OIDC_ISSUER?: string
  OA_OIDC_AUDIENCE?: string
  OA_OIDC_JWKS_URL?: string
  OA_OIDC_REQUIRE_TENANT_PROJECT?: boolean
  OA_OIDC_REQUIRE_TAGS?: boolean
  OA_AUTH_SUB_CLAIM: string
  OA_AUTH_TENANT_CLAIM: string
  OA_AUTH_PROJECT_CLAIM: string
  OA_AUTH_TAGS_CLAIM: string
}

const OidcDiscovery = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.string().url(),
})

function sha256Hex(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

function claimToString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0]
  return undefined
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  const normalized = Array.from(new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))).sort()
  return normalized.length ? normalized : undefined
}

function parseCsvTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const tags = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return normalizeTags(tags)
}

function claimToStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const tags = trimmed.includes(",")
      ? trimmed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [trimmed]
    return normalizeTags(tags)
  }
  if (Array.isArray(value)) {
    const tags = value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean)
    return normalizeTags(tags)
  }
  return undefined
}

async function discoverJwksUrl(issuer: string): Promise<string> {
  const trimmed = issuer.trim().replace(/\/+$/, "")
  const url = new URL(`${trimmed}/.well-known/openid-configuration`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`)
  const json = await res.json()
  return OidcDiscovery.parse(json).jwks_uri
}

export function createAuthenticator(cfg: AuthConfig, opts?: { audit?: (event: string, fields: Record<string, unknown>) => void }) {
  const mode = cfg.OA_AUTH_MODE
  const audit = opts?.audit

  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined
  let jwksInit: Promise<void> | undefined

  const defaultTags = parseCsvTags(cfg.OA_AUTH_TAGS)

  async function ensureJwks() {
    if (jwks) return
    if (jwksInit) return await jwksInit

    jwksInit = (async () => {
      const issuer = cfg.OA_OIDC_ISSUER
      if (!issuer) throw new Error("Missing OA_OIDC_ISSUER")

      const jwksUrl = cfg.OA_OIDC_JWKS_URL ? cfg.OA_OIDC_JWKS_URL : await discoverJwksUrl(issuer)
      jwks = createRemoteJWKSet(new URL(jwksUrl))
      audit?.("auth.oidc.jwks_ready", { issuer, jwksUrl })
    })()

    return await jwksInit
  }

  async function authenticate(token: string | undefined): Promise<Identity | undefined> {
    if (mode === "disabled") {
      return { sub: "disabled", tenant: cfg.OA_AUTH_TENANT, project: cfg.OA_AUTH_PROJECT, tags: defaultTags }
    }

    if (mode === "static") {
      if (!cfg.OA_AUTH_TOKEN) return undefined
      if (!token) return undefined
      if (token !== cfg.OA_AUTH_TOKEN) return undefined
      return {
        sub: "static",
        tenant: cfg.OA_AUTH_TENANT,
        project: cfg.OA_AUTH_PROJECT,
        tokenHash: sha256Hex(token).slice(0, 16),
        tags: defaultTags,
      }
    }

    await ensureJwks()
    if (!token) return undefined
    if (!jwks) return undefined

    const issuer = cfg.OA_OIDC_ISSUER
    if (!issuer) return undefined

    const audiences =
      cfg.OA_OIDC_AUDIENCE?.split(",").map((s) => s.trim()).filter(Boolean) ?? []

    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: audiences.length ? audiences : undefined,
    })

    const payload: Record<string, unknown> = verified.payload as any
    const sub = claimToString(payload[cfg.OA_AUTH_SUB_CLAIM]) ?? claimToString(payload["sub"]) ?? undefined
    const tenant = claimToString(payload[cfg.OA_AUTH_TENANT_CLAIM]) ?? undefined
    const project = claimToString(payload[cfg.OA_AUTH_PROJECT_CLAIM]) ?? undefined
    const tags = claimToStringArray(payload[cfg.OA_AUTH_TAGS_CLAIM]) ?? claimToStringArray(payload["tags"]) ?? defaultTags

    if (!sub) return undefined

    const requireScope = cfg.OA_OIDC_REQUIRE_TENANT_PROJECT !== false
    const resolvedTenant = tenant ?? cfg.OA_AUTH_TENANT
    const resolvedProject = project ?? cfg.OA_AUTH_PROJECT

    if (requireScope && (!tenant || !project)) {
      audit?.("auth.oidc.missing_scope", { sub, hasTenant: Boolean(tenant), hasProject: Boolean(project) })
      return undefined
    }

    if (cfg.OA_OIDC_REQUIRE_TAGS && (!tags || tags.length === 0)) {
      audit?.("auth.oidc.missing_tags", { sub, claim: cfg.OA_AUTH_TAGS_CLAIM })
      return undefined
    }

    return {
      sub,
      tenant: resolvedTenant,
      project: resolvedProject,
      tokenHash: sha256Hex(token).slice(0, 16),
      tags,
    }
  }

  return { authenticate }
}
