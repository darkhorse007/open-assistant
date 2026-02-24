import z from "zod/v4"

export namespace Ws {
  export const Version = z.literal(0)
  export type Version = z.infer<typeof Version>

  export const SessionID = z.string().min(1)
  export type SessionID = z.infer<typeof SessionID>

  export const StateValue = z.enum(["idle", "listening", "thinking", "speaking", "presenting"])
  export type StateValue = z.infer<typeof StateValue>

  export const PresentAssetType = z.enum(["video", "slides", "model"])
  export type PresentAssetType = z.infer<typeof PresentAssetType>

  export const AudioFormat = z.object({
    codec: z.enum(["pcm_s16le", "opus"]).default("pcm_s16le"),
    sampleRate: z.number().int().positive().default(16000),
    channels: z.number().int().positive().default(1),
  })
  export type AudioFormat = z.infer<typeof AudioFormat>

  export const AudioIn = z.object({
    v: Version,
    type: z.literal("audio.in"),
    sessionID: SessionID,
    seq: z.number().int().nonnegative(),
    format: AudioFormat,
    data: z.string().min(1),
  })
  export type AudioIn = z.infer<typeof AudioIn>

  export const TextIn = z.object({
    v: Version,
    type: z.literal("text.in"),
    sessionID: SessionID,
    text: z.string().min(1),
  })
  export type TextIn = z.infer<typeof TextIn>

  export const Interrupt = z.object({
    v: Version,
    type: z.literal("interrupt"),
    sessionID: SessionID,
    reason: z.enum(["vad", "button"]).optional(),
  })
  export type Interrupt = z.infer<typeof Interrupt>

  export const ClientToGateway = z.discriminatedUnion("type", [AudioIn, TextIn, Interrupt])
  export type ClientToGateway = z.infer<typeof ClientToGateway>

  export const AsrPartial = z.object({
    v: Version,
    type: z.literal("asr.partial"),
    sessionID: SessionID,
    text: z.string(),
  })
  export type AsrPartial = z.infer<typeof AsrPartial>

  export const AsrFinal = z.object({
    v: Version,
    type: z.literal("asr.final"),
    sessionID: SessionID,
    text: z.string(),
  })
  export type AsrFinal = z.infer<typeof AsrFinal>

  // A small, standard-ish viseme set compatible with OVRLipSync naming.
  export const Viseme = z.enum([
    "sil",
    "PP",
    "FF",
    "TH",
    "DD",
    "kk",
    "CH",
    "SS",
    "nn",
    "RR",
    "aa",
    "E",
    "ih",
    "oh",
    "ou",
  ])
  export type Viseme = z.infer<typeof Viseme>

  export const TtsMark = z.object({
    // Milliseconds since the start of this audio chunk.
    tMs: z.number().int().nonnegative(),
    // Normalized mouth-open value (0..1). Used for lipsync without client-side FFT/RMS.
    open: z.number().min(0).max(1),
  })
  export type TtsMark = z.infer<typeof TtsMark>

  export const TtsAudio = z.object({
    v: Version,
    type: z.literal("tts.audio"),
    sessionID: SessionID,
    seq: z.number().int().nonnegative(),
    // Stable identifier that binds `tts.align` to `tts.audio` chunks for a single TTS segment.
    segmentId: z.string().min(1).optional(),
    // Chunk sequence within the segment (0-based). Useful for debugging.
    segmentSeq: z.number().int().nonnegative().optional(),
    mime: z.string().min(1),
    sampleRate: z.number().int().positive(),
    data: z.string().min(1),
    marks: z.array(TtsMark).optional(),
  })
  export type TtsAudio = z.infer<typeof TtsAudio>

  export const TtsText = z.object({
    v: Version,
    type: z.literal("tts.text"),
    sessionID: SessionID,
    seq: z.number().int().nonnegative().optional(),
    text: z.string(),
    final: z.boolean().optional(),
  })
  export type TtsText = z.infer<typeof TtsText>

  export const TtsAlignSegment = z
    .object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      viseme: Viseme,
      phoneme: z.string().min(1).optional(),
      word: z.string().min(1).optional(),
    })
    .refine((x) => x.endMs > x.startMs, { message: "endMs must be greater than startMs" })
  export type TtsAlignSegment = z.infer<typeof TtsAlignSegment>

  export const TtsAlign = z.object({
    v: Version,
    type: z.literal("tts.align"),
    sessionID: SessionID,
    seq: z.number().int().nonnegative().optional(),
    turnId: z.string().min(1).optional(),
    // Must match `tts.audio.segmentId` for this segment.
    segmentId: z.string().min(1).optional(),
    segments: z.array(TtsAlignSegment).default([]),
  })
  export type TtsAlign = z.infer<typeof TtsAlign>

  export const UiPresent = z.object({
    v: Version,
    type: z.literal("ui.present"),
    sessionID: SessionID,
    assetId: z.string().min(1),
    assetType: PresentAssetType.optional(),
    autoplay: z.boolean().optional(),
    layout: z.enum(["side-by-side", "full", "pip"]).optional(),
    startAtSeconds: z.number().min(0).optional(),
    sync: z
      .object({
        mode: z.enum(["tts"]).default("tts"),
        offsetMs: z.number().int().optional(),
        turnId: z.string().min(1).optional(),
      })
      .optional(),
  })
  export type UiPresent = z.infer<typeof UiPresent>

  export const UiStop = z.object({
    v: Version,
    type: z.literal("ui.stop"),
    sessionID: SessionID,
    target: z.enum(["tts", "video", "all"]).optional(),
  })
  export type UiStop = z.infer<typeof UiStop>

  export const State = z.object({
    v: Version,
    type: z.literal("state"),
    sessionID: SessionID,
    state: StateValue,
  })
  export type State = z.infer<typeof State>

  export const GatewayToClient = z.discriminatedUnion("type", [
    AsrPartial,
    AsrFinal,
    TtsAudio,
    TtsText,
    TtsAlign,
    UiPresent,
    UiStop,
    State,
  ])
  export type GatewayToClient = z.infer<typeof GatewayToClient>
}
