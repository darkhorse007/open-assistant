import z from "zod/v4"

export namespace Mcp {
  export const RagSearchInput = z.object({
    sessionID: z.string().min(1).optional(),
    query: z.string().min(1),
    topK: z.number().int().positive().max(50).default(8),
    filters: z
      .object({
        tenant: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).max(20).optional(),
      })
      .optional(),
  })
  export type RagSearchInput = z.infer<typeof RagSearchInput>

  export const RagSearchOutput = z.object({
    passages: z.array(
      z.object({
        text: z.string(),
        sourceId: z.string(),
        score: z.number(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
  })
  export type RagSearchOutput = z.infer<typeof RagSearchOutput>

  export const AssetType = z.enum(["video", "slides", "model"])
  export type AssetType = z.infer<typeof AssetType>

  export const AssetSearchInput = z.object({
    sessionID: z.string().min(1).optional(),
    query: z.string().min(1),
    type: AssetType.optional(),
    topK: z.number().int().positive().max(50).default(5),
    filters: z
      .object({
        tenant: z.string().min(1).optional(),
        project: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).max(20).optional(),
      })
      .optional(),
  })
  export type AssetSearchInput = z.infer<typeof AssetSearchInput>

  export const AssetSearchOutput = z.object({
    assets: z.array(
      z.object({
        assetId: z.string().min(1),
        type: AssetType,
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        url: z.string().url().optional(),
      }),
    ),
  })
  export type AssetSearchOutput = z.infer<typeof AssetSearchOutput>

  export const UiLayout = z.enum(["side-by-side", "full", "pip"])
  export type UiLayout = z.infer<typeof UiLayout>

  export const UiPresentInput = z.object({
    sessionID: z.string().min(1),
    assetId: z.string().min(1),
    assetType: AssetType.optional(),
    autoplay: z.boolean().optional(),
    layout: UiLayout.optional(),
    startAtSeconds: z.number().min(0).optional(),
  })
  export type UiPresentInput = z.infer<typeof UiPresentInput>

  export const UiPresentOutput = z.object({
    ok: z.boolean(),
  })
  export type UiPresentOutput = z.infer<typeof UiPresentOutput>

  export const UiStopInput = z.object({
    sessionID: z.string().min(1),
    target: z.enum(["tts", "video", "all"]).optional(),
  })
  export type UiStopInput = z.infer<typeof UiStopInput>
}
