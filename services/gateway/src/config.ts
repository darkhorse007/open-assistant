import z from "zod/v4"

export const Config = z.object({
  OA_GATEWAY_HOST: z.string().default("0.0.0.0"),
  OA_GATEWAY_PORT: z.coerce.number().int().positive().default(7001),
  OA_GW_MAX_SESSIONS: z.coerce.number().int().positive().default(10),
  OA_GW_SESSION_IDLE_TTL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  OA_GW_SESSION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 1000),
  OA_GW_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 1000),
  OA_GW_ASR_MAX_CONCURRENT_DECODE: z.coerce.number().int().positive().default(4),
  OA_GW_ASR_QUEUE_MAX_FRAMES: z.coerce.number().int().min(0).default(50),
  OA_GW_ASR_IDLE_RELEASE_MS: z.coerce.number().int().positive().default(5000),
  OA_GW_TTS_MAX_CONCURRENT_SYNTHESIS: z.coerce.number().int().positive().default(2),
  OA_GW_TTS_SEGMENT_MAX_CHARS: z.coerce.number().int().positive().default(180),
  OA_AUDIT_MODE: z.enum(["off", "hash", "full"]).default("hash"),
  OA_AUDIT_DB_PATH: z.string().optional(),
  OA_AUDIT_DB_MAX_ROWS: z.coerce.number().int().positive().default(20000),
  OA_AUTH_MODE: z.enum(["disabled", "static", "oidc"]).default("disabled"),
  OA_AUTH_TOKEN: z.string().min(1).optional(),
  OA_AUTH_TENANT: z.string().min(1).default("default"),
  OA_AUTH_PROJECT: z.string().min(1).default("open-assistant"),
  OA_AUTH_TAGS_MODE: z.enum(["disabled", "enforce"]).default("disabled"),
  OA_AUTH_TAGS: z.string().optional(),
  OA_OIDC_ISSUER: z.string().url().optional(),
  OA_OIDC_AUDIENCE: z.string().min(1).optional(),
  OA_OIDC_JWKS_URL: z.string().url().optional(),
  OA_OIDC_REQUIRE_TENANT_PROJECT: z.coerce.boolean().default(true),
  OA_OIDC_REQUIRE_TAGS: z.coerce.boolean().default(false),
  OA_AUTH_SUB_CLAIM: z.string().min(1).default("sub"),
  OA_AUTH_TENANT_CLAIM: z.string().min(1).default("tenant"),
  OA_AUTH_PROJECT_CLAIM: z.string().min(1).default("project"),
  OA_AUTH_TAGS_CLAIM: z.string().min(1).default("tags"),
  OA_METRICS_TOKEN: z.string().min(1).optional(),
  OA_ADMIN_TOKEN: z.string().min(1).optional(),

  OA_ASR_MODE: z.enum(["mock", "external", "disabled"]).default("mock"),
  OA_ASR_WS_URL: z.string().url().default("ws://127.0.0.1:7002/asr"),

  OA_TTS_MODE: z.enum(["mock", "external", "disabled"]).default("mock"),
  OA_TTS_BASE_URL: z.string().url().default("http://127.0.0.1:7003"),

  OA_MEDIA_MODE: z.enum(["mock", "external", "disabled"]).default("mock"),
  OA_MEDIA_BASE_URL: z.string().url().default("http://127.0.0.1:7004"),

  OA_RAG_MODE: z.enum(["mock", "external", "disabled"]).default("mock"),
  OA_RAG_BASE_URL: z.string().url().default("http://127.0.0.1:7005"),

  OA_LLM_MODE: z.enum(["opencode", "mock"]).default("opencode"),
  OA_OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:4096"),
  OA_OPENCODE_DIRECTORY: z.string().min(1).optional(),
  OA_OPENCODE_USERNAME: z.string().min(1).optional(),
  OA_OPENCODE_PASSWORD: z.string().min(1).optional(),
  OA_OPENCODE_EVENTS_MODE: z.enum(["sse", "disabled"]).default("sse"),
})

export type Config = z.infer<typeof Config>

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const normalized: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    normalized[k] = typeof v === "string" && !v.trim() ? undefined : v
  }
  return Config.parse(normalized)
}
