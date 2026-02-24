import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { Ws } from "@open-assistant/protocol"

const VisemeValues = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"] as const satisfies readonly Ws.Viseme[]
const VisemeValueSet = new Set<string>(VisemeValues)

type ModelMorphMap = {
  jawOpen?: string[]
  viseme?: Partial<Record<Ws.Viseme, string[]>>
}

function asStringArray(value: unknown) {
  if (typeof value === "string") {
    const s = value.trim()
    return s ? [s] : undefined
  }
  if (Array.isArray(value)) {
    const out = value.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    return out.length ? out : undefined
  }
  return undefined
}

function parseModelMorphMapText(text: string): { map?: ModelMorphMap; error?: string } {
  const raw = text.trim()
  if (!raw) return { map: undefined, error: "" }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { map: undefined, error: "Invalid JSON" }
  }

  if (!json || typeof json !== "object") return { map: undefined, error: "Expected a JSON object" }

  const obj = json as any
  const out: ModelMorphMap = {}

  const jawOpen = asStringArray(obj.jawOpen)
  if (jawOpen) out.jawOpen = jawOpen

  const viseme = obj.viseme
  if (viseme && typeof viseme === "object") {
    for (const [k, v] of Object.entries(viseme as Record<string, unknown>)) {
      if (!VisemeValueSet.has(k)) continue
      const names = asStringArray(v)
      if (!names) continue
      if (!out.viseme) out.viseme = {}
      out.viseme[k as Ws.Viseme] = names
    }
  }

  if (!out.jawOpen && !out.viseme) return { map: undefined, error: "" }
  return { map: out, error: "" }
}

function newSessionID() {
  return globalThis.crypto?.randomUUID?.() ?? String(Date.now())
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function clampAudioSample(s: number) {
  return Math.max(-1, Math.min(1, s))
}

function float32ToInt16PCM(input: Float32Array) {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = clampAudioSample(input[i] ?? 0)
    output[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return output
}

function base64FromBytes(bytes: Uint8Array) {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function bytesFromBase64(b64: string) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function App() {
  const [sessionID] = createSignal(newSessionID())
  const gatewayWsUrl = createMemo(() => {
    const explicit = import.meta.env.VITE_GATEWAY_WS_URL
    if (explicit) return explicit
    try {
      const url = new URL("/ws", window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return "ws://localhost:7001/ws"
    }
  })
  const gatewayHttpBaseUrl = createMemo(() => {
    const fallback = "http://localhost:7001"
    try {
      const ws = new URL(gatewayWsUrl())
      ws.protocol = ws.protocol === "wss:" ? "https:" : "http:"
      ws.pathname = ""
      ws.search = ""
      ws.hash = ""
      return ws.toString().replace(/\/$/, "")
    } catch {
      return fallback
    }
  })

  const [status, setStatus] = createSignal<"disconnected" | "connecting" | "connected">("disconnected")
  const [connectionError, setConnectionError] = createSignal<string>("")
  const [lastState, setLastState] = createSignal<Ws.StateValue>("idle")
  const [userSubtitle, setUserSubtitle] = createSignal<string>("")
  const [assistantSubtitle, setAssistantSubtitle] = createSignal<string>("")
  const [draftText, setDraftText] = createSignal<string>("")
  const [micStatus, setMicStatus] = createSignal<"off" | "on">("off")
  const [ttsMode, setTtsMode] = createSignal<"audio" | "speech">(import.meta.env.VITE_TTS_MODE ?? "audio")
  const [authToken, setAuthToken] = createSignal<string>(sessionStorage.getItem("oa_token") ?? import.meta.env.VITE_OA_TOKEN ?? "")
  const [presentSrc, setPresentSrc] = createSignal<string>("")
  const [presentAssetId, setPresentAssetId] = createSignal<string>("")
  const [presentAssetType, setPresentAssetType] = createSignal<Ws.PresentAssetType>("video")
  const [presentLayout, setPresentLayout] = createSignal<Ws.UiPresent["layout"]>("side-by-side")
  const [presentStartAt, setPresentStartAt] = createSignal<number | undefined>(undefined)
  const [presentAutoplay, setPresentAutoplay] = createSignal<boolean>(true)
  const [presentSyncMode, setPresentSyncMode] = createSignal<"none" | "tts">("none")
  const [presentSyncTurnId, setPresentSyncTurnId] = createSignal<string>("")
  const [timelinePresentAtMs, setTimelinePresentAtMs] = createSignal<number | undefined>(undefined)
  const [timelineTtsStartAtMs, setTimelineTtsStartAtMs] = createSignal<number | undefined>(undefined)
  const [timelineVideoMetaAtMs, setTimelineVideoMetaAtMs] = createSignal<number | undefined>(undefined)
  const [timelineVideoPlayAtMs, setTimelineVideoPlayAtMs] = createSignal<number | undefined>(undefined)
  const [presentError, setPresentError] = createSignal<string>("")
  const [mouthOpen, setMouthOpen] = createSignal<number>(0)
  const [mouthViseme, setMouthViseme] = createSignal<Ws.Viseme>("sil")
  const [mouthPhoneme, setMouthPhoneme] = createSignal<string>("")
  const [mouthWord, setMouthWord] = createSignal<string>("")
  const [lipsyncMode, setLipsyncMode] = createSignal<"none" | "align">("none")

  let initialModelMorphMapText = ""
  try {
    initialModelMorphMapText = localStorage.getItem("oa_model_morph_map") ?? ""
  } catch {
    // ignore
  }
  const modelMorphMapExample = `{
  "jawOpen": ["jawOpen", "MouthOpen"],
  "viseme": {
    "aa": ["viseme_aa", "A"],
    "ih": ["viseme_ih", "I"],
    "ou": ["viseme_ou", "U"],
    "E": ["viseme_E", "E"],
    "oh": ["viseme_oh", "O"],
    "PP": ["viseme_PP", "MouthClose"]
  }
}`
  const [modelMorphMapText, setModelMorphMapText] = createSignal<string>(initialModelMorphMapText)
  const [modelMorphMapError, setModelMorphMapError] = createSignal<string>("")
  const [modelMorphMapConfig, setModelMorphMapConfig] = createSignal<ModelMorphMap | undefined>(undefined)

  function fmtMs(ms: number | undefined) {
    return typeof ms === "number" ? `${Math.round(ms)}ms` : "-"
  }

  function fmtDeltaMs(a: number | undefined, b: number | undefined) {
    if (typeof a !== "number" || typeof b !== "number") return "-"
    const d = a - b
    return `${d >= 0 ? "+" : ""}${Math.round(d)}ms`
  }

  let ws: WebSocket | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  let manualDisconnect = false
  let wsConnSeq = 0
  let activeWsConn = 0
  let audioContext: AudioContext | undefined
  let micStream: MediaStream | undefined
  let processor: ScriptProcessorNode | undefined
  let audioSeq = 0
  let lastVoiceAt = 0
  let lastInterruptAt = 0

  let ttsAudioContext: AudioContext | undefined
  let ttsNextTime = 0
  let ttsSources: AudioBufferSourceNode[] = []
  let ttsAnalyser: AnalyserNode | undefined
  let ttsAnalyserBuffer: Float32Array | undefined
  let ttsLipsyncRaf: number | undefined
  let ttsFirstAudioStartPerfMs: number | undefined

  type OpenCue = { tPerfMs: number; open: number }
  let ttsOpenCues: OpenCue[] = []
  let ttsOpenCueIndex = 0

  type TtsAlignInfo = { segments: Ws.TtsAlignSegment[]; estimatedMs: number }
  type TtsSegment = {
    segmentId: string
    startPerfMs?: number
    durationMs: number
    finalized: boolean
    scale: number
    align?: TtsAlignInfo
  }
  const ttsSegments = new Map<string, TtsSegment>()
  let ttsTimeline: TtsSegment[] = []
  let ttsLastAudioSegmentId: string | undefined

  let presentSyncedStarted = false

  let videoEl: HTMLVideoElement | undefined
  let modelFrameEl: HTMLIFrameElement | undefined
  let lastModelLipsyncPerfMs = 0

  function sendModelMorphMap() {
    const win = modelFrameEl?.contentWindow
    if (!win) return

    const cfg = modelMorphMapConfig()
    try {
      win.postMessage({ type: "oa.morphmap", jawOpen: cfg?.jawOpen, viseme: cfg?.viseme }, "*")
    } catch {
      // ignore
    }
  }

  function maybeSendModelLipsync(nowPerfMs: number) {
    if (presentAssetType() !== "model") return
    const win = modelFrameEl?.contentWindow
    if (!win) return
    if (nowPerfMs - lastModelLipsyncPerfMs < 33) return
    lastModelLipsyncPerfMs = nowPerfMs

    try {
      win.postMessage(
        { type: "oa.lipsync", open: mouthOpen(), viseme: mouthViseme(), phoneme: mouthPhoneme(), word: mouthWord() },
        "*",
      )
    } catch {
      // ignore
    }
  }

  createEffect(() => {
    const t = authToken().trim()
    if (t) sessionStorage.setItem("oa_token", t)
    else sessionStorage.removeItem("oa_token")
  })

  createEffect(() => {
    const text = modelMorphMapText()
    try {
      localStorage.setItem("oa_model_morph_map", text)
    } catch {
      // ignore
    }

    const parsed = parseModelMorphMapText(text)
    if (parsed.error) {
      setModelMorphMapError(parsed.error)
      return
    }
    setModelMorphMapError("")
    setModelMorphMapConfig(parsed.map)
  })

  createEffect(() => {
    if (presentAssetType() !== "model") return
    // Re-send mapping when config changes.
    modelMorphMapConfig()
    sendModelMorphMap()
  })

  function assetUrl(assetId: string) {
    const url = new URL(`/assets/${encodeURIComponent(assetId)}`, gatewayHttpBaseUrl())
    const t = authToken().trim()
    if (t) url.searchParams.set("token", t)
    return url.toString()
  }

  function scheduleReconnect() {
    if (manualDisconnect) return
    if (reconnectTimer) return
    const attempt = reconnectAttempts++
    const delay = Math.min(1000 * 2 ** attempt, 10_000)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delay)
  }

  function resetClientOutputs() {
    stopSpeech()
    stopTtsAudio()
    stopPresent()
    setUserSubtitle("")
    setAssistantSubtitle("")
    setLastState("idle")
  }

  function ensureTtsAnalyser(ctx: AudioContext) {
    if (ttsAnalyser) return ttsAnalyser
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ttsAnalyserBuffer = new Float32Array(analyser.fftSize)
    analyser.connect(ctx.destination)
    ttsAnalyser = analyser
    return analyser
  }

  function resetTtsSegments() {
    ttsSegments.clear()
    ttsTimeline = []
    ttsLastAudioSegmentId = undefined
  }

  function ensureTtsSegment(segmentId: string) {
    const id = segmentId.trim()
    if (!id) return undefined

    const existing = ttsSegments.get(id)
    if (existing) return existing

    const seg: TtsSegment = { segmentId: id, durationMs: 0, finalized: false, scale: 1 }
    ttsSegments.set(id, seg)
    return seg
  }

  function estimateAlignMs(segments: Ws.TtsAlignSegment[]) {
    let max = 0
    for (const s of segments) {
      if (typeof s.endMs === "number" && Number.isFinite(s.endMs)) max = Math.max(max, s.endMs)
    }
    return Math.max(0, Math.floor(max))
  }

  function setTtsAlign(segmentId: string, segments: Ws.TtsAlignSegment[]) {
    const seg = ensureTtsSegment(segmentId)
    if (!seg) return
    seg.align = { segments, estimatedMs: estimateAlignMs(segments) }
  }

  function noteTtsAudioChunk(segmentId: string, chunkStartPerfMs: number, chunkDurationMs: number) {
    const seg = ensureTtsSegment(segmentId)
    if (!seg) return

    if (typeof seg.startPerfMs !== "number") {
      seg.startPerfMs = chunkStartPerfMs
      ttsTimeline.push(seg)
    }

    seg.durationMs += Math.max(0, chunkDurationMs)
    ttsLastAudioSegmentId = seg.segmentId
  }

  function finalizeTtsSegment(segmentId: string) {
    const seg = ttsSegments.get(segmentId)
    if (!seg || seg.finalized) return
    seg.finalized = true

    const estimatedMs = seg.align?.estimatedMs ?? 0
    if (estimatedMs > 0) {
      const raw = seg.durationMs / estimatedMs
      seg.scale = clamp(raw, 0.25, 4)
    } else {
      seg.scale = 1
    }
  }

  function finalizeLastTtsSegment() {
    const last = ttsLastAudioSegmentId
    if (!last) return
    finalizeTtsSegment(last)
  }

  function currentPlaybackSegment(nowPerfMs: number): TtsSegment | undefined {
    if (ttsTimeline.length === 0) return

    let candidate: TtsSegment | undefined
    for (const seg of ttsTimeline) {
      const start = seg.startPerfMs
      if (typeof start !== "number") continue
      if (start <= nowPerfMs) candidate = seg
      else break
    }

    if (!candidate || typeof candidate.startPerfMs !== "number") return
    const endPerfMs = candidate.startPerfMs + candidate.durationMs
    if (Number.isFinite(endPerfMs) && nowPerfMs > endPerfMs + 250) return
    return candidate
  }

  function findAlignSegment(segments: Ws.TtsAlignSegment[], tMs: number): Ws.TtsAlignSegment | undefined {
    if (!Number.isFinite(tMs)) return
    const ms = Math.max(0, tMs)
    let lo = 0
    let hi = segments.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = segments[mid]
      if (!seg) return
      if (ms < seg.startMs) hi = mid - 1
      else if (ms >= seg.endMs) lo = mid + 1
      else return seg
    }
    return undefined
  }

  function startTtsLipsync() {
    if (ttsLipsyncRaf) return

    const tick = () => {
      const now = performance.now()
      let target: number | undefined

      // 1) Viseme/phoneme/word: bind `tts.align` to the active TTS segment, and scale against actual audio duration when available.
      const active = currentPlaybackSegment(now)
      const align = active?.align
      if (active && typeof active.startPerfMs === "number" && align?.segments?.length) {
        const elapsedMs = Math.max(0, now - active.startPerfMs)
        const scale = active.scale > 0 ? active.scale : 1
        const seg = findAlignSegment(align.segments, elapsedMs / scale)

        if (lipsyncMode() !== "align") setLipsyncMode("align")

        const viseme = seg?.viseme ?? "sil"
        const phoneme = seg?.phoneme ?? ""
        const word = seg?.word ?? ""

        if (viseme !== mouthViseme()) setMouthViseme(viseme)
        if (phoneme !== mouthPhoneme()) setMouthPhoneme(phoneme)
        if (word !== mouthWord()) setMouthWord(word)
      } else {
        if (lipsyncMode() !== "none") setLipsyncMode("none")
        if (mouthViseme() !== "sil") setMouthViseme("sil")
        if (mouthPhoneme() !== "") setMouthPhoneme("")
        if (mouthWord() !== "") setMouthWord("")
      }

      // 2) Mouth-open: prefer backend marks if available (more deterministic than client FFT/RMS).
      if (ttsOpenCues.length > 0) {
        while (ttsOpenCueIndex + 1 < ttsOpenCues.length && (ttsOpenCues[ttsOpenCueIndex + 1]?.tPerfMs ?? Infinity) <= now) {
          ttsOpenCueIndex += 1
        }
        const cue = ttsOpenCues[ttsOpenCueIndex]
        target = cue && cue.tPerfMs <= now ? cue.open : 0

        if (ttsOpenCueIndex > 256) {
          ttsOpenCues = ttsOpenCues.slice(ttsOpenCueIndex)
          ttsOpenCueIndex = 0
        }
      }

      // Fallback: analyser RMS -> mouthOpen (0..1).
      if (typeof target !== "number") {
        if (!ttsAnalyser || !ttsAnalyserBuffer) {
          ttsLipsyncRaf = undefined
          return
        }

        ttsAnalyser.getFloatTimeDomainData(ttsAnalyserBuffer)
        let sumSquares = 0
        for (let i = 0; i < ttsAnalyserBuffer.length; i++) {
          const s = ttsAnalyserBuffer[i] ?? 0
          sumSquares += s * s
        }
        const rms = Math.sqrt(sumSquares / Math.max(1, ttsAnalyserBuffer.length))
        target = clamp((rms - 0.02) / 0.12, 0, 1)
        if (lipsyncMode() !== "align" && mouthViseme() !== "sil") setMouthViseme("sil")
      }

      const prev = mouthOpen()
      setMouthOpen(prev * 0.85 + target * 0.15)
      maybeSendModelLipsync(now)

      ttsLipsyncRaf = requestAnimationFrame(tick)
    }

    ttsLipsyncRaf = requestAnimationFrame(tick)
  }

  function stopTtsLipsync() {
    if (ttsLipsyncRaf) {
      cancelAnimationFrame(ttsLipsyncRaf)
      ttsLipsyncRaf = undefined
    }
    setLipsyncMode("none")
    setMouthOpen(0)
    setMouthViseme("sil")
    setMouthPhoneme("")
    setMouthWord("")
    maybeSendModelLipsync(performance.now())
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    manualDisconnect = false
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    setConnectionError("")
    resetClientOutputs()

    setStatus("connecting")
    const conn = ++wsConnSeq
    activeWsConn = conn
    const url = new URL(gatewayWsUrl())
    url.searchParams.set("sessionID", sessionID())
    const t = authToken().trim()
    if (t) url.searchParams.set("token", t)
    ws = new WebSocket(url.toString())

    ws.onopen = () => {
      if (conn !== activeWsConn) return
      reconnectAttempts = 0
      setStatus("connected")
      setConnectionError("")
    }
    ws.onclose = (event) => {
      if (conn !== activeWsConn) return
      setStatus("disconnected")
      ws = undefined
      resetClientOutputs()

      const detail = event.reason ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
      setConnectionError(manualDisconnect ? "" : `连接已断开${detail}`)
      scheduleReconnect()
    }
    ws.onerror = () => {
      if (conn !== activeWsConn) return
      setStatus("disconnected")
      setConnectionError("WebSocket error")
    }
    ws.onmessage = (event) => {
      if (conn !== activeWsConn) return
      try {
        const msg = JSON.parse(String(event.data)) as Ws.GatewayToClient
        if (msg.type === "state") {
          const prev = lastState()
          setLastState(msg.state)
          if (prev === "speaking" && msg.state !== "speaking") finalizeLastTtsSegment()
        }
        if (msg.type === "asr.partial" || msg.type === "asr.final") setUserSubtitle(msg.text)
        if (msg.type === "tts.text") {
          if (msg.final) {
            ttsFirstAudioStartPerfMs = undefined
            ttsOpenCues = []
            ttsOpenCueIndex = 0
            resetTtsSegments()
            setTimelineTtsStartAtMs(undefined)
            setMouthViseme("sil")
            setMouthPhoneme("")
            setMouthWord("")
            setLipsyncMode("none")
          }
          setAssistantSubtitle(msg.text)
          if (ttsMode() === "speech" && msg.final) speak(msg.text)
        }
        if (msg.type === "tts.align") {
          const segmentId = typeof msg.segmentId === "string" ? msg.segmentId : ""
          if (segmentId) {
            if (ttsLastAudioSegmentId && ttsLastAudioSegmentId !== segmentId) finalizeTtsSegment(ttsLastAudioSegmentId)
            setTtsAlign(segmentId, msg.segments ?? [])
          }
        }
        if (msg.type === "tts.audio") {
          if (ttsMode() === "audio") playPcm16leChunk(msg.data, msg.sampleRate, msg.marks, msg.segmentId)
        }
        if (msg.type === "ui.present") {
          setPresentError("")
          const wantSync = msg.sync?.mode === "tts" && ttsMode() === "audio"
          setPresentSyncMode(wantSync ? "tts" : "none")
          setPresentSyncTurnId(msg.sync?.turnId ?? "")
          setTimelinePresentAtMs(performance.now())
          setTimelineTtsStartAtMs(undefined)
          setTimelineVideoMetaAtMs(undefined)
          setTimelineVideoPlayAtMs(undefined)
          presentSyncedStarted = false
          setPresentAssetId(msg.assetId)
          setPresentAssetType(msg.assetType ?? "video")
          setPresentLayout(msg.layout ?? "side-by-side")
          setPresentStartAt(msg.startAtSeconds)
          setPresentAutoplay(msg.autoplay ?? true)
          setPresentSrc(assetUrl(msg.assetId))
          tryStartSyncedVideo()
        }
        if (msg.type === "ui.stop") {
          if (msg.target === "tts" || msg.target === "all" || !msg.target) {
            stopSpeech()
            stopTtsAudio()
          }
          if (msg.target === "video" || msg.target === "all" || !msg.target) stopPresent()
        }
      } catch {
        // ignore
      }
    }
  }

  function disconnect() {
    manualDisconnect = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    ws?.close()
    ws = undefined
    setStatus("disconnected")
    setConnectionError("")
    resetClientOutputs()
  }

  async function startMic() {
    if (micStream) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setUserSubtitle("（浏览器不支持 getUserMedia）")
      return
    }

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioContext = new AudioContext({ sampleRate: 16000 })
    const source = audioContext.createMediaStreamSource(micStream)

    processor = audioContext.createScriptProcessor(1024, 1, 1)
    const gain = audioContext.createGain()
    gain.gain.value = 0

    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return

      const input = e.inputBuffer.getChannelData(0)
      let sum = 0
      for (let i = 0; i < input.length; i++) {
        const s = input[i] ?? 0
        sum += s * s
      }
      const rms = Math.sqrt(sum / Math.max(1, input.length))

      const now = performance.now()
      const threshold = 0.02
      const inHangover = now - lastVoiceAt < 250
      const isVoice = rms > threshold
      if (isVoice) lastVoiceAt = now

      if (!isVoice && !inHangover) return

      if (isVoice && (lastState() === "speaking" || lastState() === "presenting") && now - lastInterruptAt > 800) {
        lastInterruptAt = now
        sendInterrupt("vad")
      }

      const pcm = float32ToInt16PCM(input)
      const data = base64FromBytes(new Uint8Array(pcm.buffer))

      const msg: Ws.AudioIn = {
        v: 0,
        type: "audio.in",
        sessionID: sessionID(),
        seq: audioSeq++,
        format: { codec: "pcm_s16le", sampleRate: 16000, channels: 1 },
        data,
      }
      ws.send(JSON.stringify(msg))
    }

    source.connect(processor)
    processor.connect(gain)
    gain.connect(audioContext.destination)

    setMicStatus("on")
  }

  async function stopMic() {
    processor?.disconnect()
    processor = undefined

    await audioContext?.close().catch(() => {})
    audioContext = undefined

    micStream?.getTracks().forEach((t) => t.stop())
    micStream = undefined

    setMicStatus("off")
  }

  function stopSpeech() {
    globalThis.speechSynthesis?.cancel()
  }

  function speak(text: string) {
    if (!globalThis.speechSynthesis) return
    stopSpeech()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = "zh-CN"
    globalThis.speechSynthesis.speak(utter)
  }

  function stopTtsAudio() {
    for (const s of ttsSources) {
      try {
        s.stop()
      } catch {
        // ignore
      }
    }
    ttsSources = []
    ttsNextTime = 0
    ttsFirstAudioStartPerfMs = undefined
    ttsOpenCues = []
    ttsOpenCueIndex = 0
    resetTtsSegments()
    setLipsyncMode("none")
    stopTtsLipsync()
  }

  function tryStartSyncedVideo() {
    if (presentSyncedStarted) return
    if (presentSyncMode() !== "tts") return
    if (!presentAutoplay()) return
    if (presentAssetType() !== "video") return
    if (!videoEl) return
    if (!presentSrc()) return
    if (typeof ttsFirstAudioStartPerfMs !== "number") return

    const now = performance.now()
    const elapsedSec = Math.max(0, (now - ttsFirstAudioStartPerfMs) / 1000)
    const baseStartAt = presentStartAt() ?? 0
    const targetTime = baseStartAt + elapsedSec

    try {
      videoEl.currentTime = targetTime
    } catch {
      // ignore
    }

    videoEl.play().catch((err) => {
      setPresentError(err instanceof Error ? err.message : String(err))
    })

    presentSyncedStarted = true
  }

  function stopPresent() {
    if (videoEl) {
      try {
        videoEl.pause()
      } catch {
        // ignore
      }
      videoEl.removeAttribute("src")
      videoEl.load()
    }
    setPresentSrc("")
    setPresentAssetId("")
    setPresentError("")
    setPresentStartAt(undefined)
    setPresentAssetType("video")
    setPresentSyncMode("none")
    setPresentSyncTurnId("")
    presentSyncedStarted = false
    setTimelinePresentAtMs(undefined)
    setTimelineTtsStartAtMs(undefined)
    setTimelineVideoMetaAtMs(undefined)
    setTimelineVideoPlayAtMs(undefined)
  }

  function ensureTtsAudioUnlocked() {
    try {
      if (!ttsAudioContext) ttsAudioContext = new AudioContext()
      if (ttsAudioContext.state === "suspended") void ttsAudioContext.resume()
    } catch {
      // ignore
    }
  }

  function playPcm16leChunk(base64: string, sampleRate: number, marks: Ws.TtsMark[] | undefined, segmentId: string | undefined) {
    const bytes = bytesFromBase64(base64)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const samples = Math.floor(bytes.byteLength / 2)

    if (!ttsAudioContext) ttsAudioContext = new AudioContext()
    const ctx = ttsAudioContext
    const analyser = ensureTtsAnalyser(ctx)

    const audioBuffer = ctx.createBuffer(1, samples, sampleRate)
    const channel = audioBuffer.getChannelData(0)
    for (let i = 0; i < samples; i++) {
      const s = view.getInt16(i * 2, true)
      channel[i] = s / 0x8000
    }

    const source = ctx.createBufferSource()
    source.buffer = audioBuffer
    source.connect(analyser)

    const scheduledAtCtx = ctx.currentTime
    const startAt = Math.max(scheduledAtCtx + 0.02, ttsNextTime || scheduledAtCtx + 0.02)
    const chunkStartPerfMs = performance.now() + (startAt - scheduledAtCtx) * 1000
    if (typeof ttsFirstAudioStartPerfMs !== "number") {
      ttsFirstAudioStartPerfMs = chunkStartPerfMs
      setTimelineTtsStartAtMs(ttsFirstAudioStartPerfMs)
      tryStartSyncedVideo()
    }

    const segId = typeof segmentId === "string" && segmentId.trim() ? segmentId.trim() : "seg:unknown"
    if (ttsLastAudioSegmentId && ttsLastAudioSegmentId !== segId) finalizeTtsSegment(ttsLastAudioSegmentId)
    noteTtsAudioChunk(segId, chunkStartPerfMs, audioBuffer.duration * 1000)

    if (marks?.length) {
      for (const m of marks) {
        const tPerfMs = chunkStartPerfMs + m.tMs
        if (!Number.isFinite(tPerfMs)) continue
        ttsOpenCues.push({ tPerfMs, open: clamp(m.open, 0, 1) })
      }
    }
    source.start(startAt)
    ttsNextTime = startAt + audioBuffer.duration
    ttsSources.push(source)
    source.onended = () => {
      ttsSources = ttsSources.filter((x) => x !== source)
      if (ttsSources.length === 0) stopTtsLipsync()
    }

    startTtsLipsync()
  }

  createEffect(() => {
    const src = presentSrc()
    const startAt = presentStartAt()
    if (presentAssetType() !== "video") return
    if (!videoEl) return
    if (!src) return

    videoEl.src = src
    videoEl.load()

    if (presentAutoplay() && presentSyncMode() !== "tts" && typeof startAt !== "number") {
      videoEl.play().catch((err) => {
        setPresentError(err instanceof Error ? err.message : String(err))
      })
    }

    if (presentSyncMode() === "tts") tryStartSyncedVideo()
  })

  function sendInterrupt(reason: Ws.Interrupt["reason"]) {
    stopSpeech()
    stopTtsAudio()
    stopPresent()
    const msg: Ws.Interrupt = { v: 0, type: "interrupt", sessionID: sessionID(), reason }
    ws?.send(JSON.stringify(msg))
  }

  function sendText() {
    const text = draftText().trim()
    if (!text) return

    ensureTtsAudioUnlocked()
    const msg: Ws.TextIn = { v: 0, type: "text.in", sessionID: sessionID(), text }
    ws?.send(JSON.stringify(msg))
    setDraftText("")
  }

  function sendDevCommand(command: string) {
    ensureTtsAudioUnlocked()
    const msg: Ws.TextIn = { v: 0, type: "text.in", sessionID: sessionID(), text: command }
    ws?.send(JSON.stringify(msg))
  }

  onMount(connect)
  onCleanup(() => {
    manualDisconnect = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopSpeech()
    stopTtsAudio()
    stopPresent()
    stopMic()
    disconnect()
  })

  return (
    <div class="min-h-screen p-6">
      <div class="mx-auto max-w-3xl space-y-4">
        <header class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-semibold">Open Assistant</h1>
            <div class="text-sm text-slate-300">
              sessionID: <span class="font-mono">{sessionID()}</span>
            </div>
          </div>
          <div class="flex gap-2">
            <a
              class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
              href="/admin.html"
              target="_blank"
              rel="noreferrer"
            >
              Admin
            </a>
            <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={connect}>
              Connect
            </button>
            <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </header>

        <section class="rounded border border-slate-800 bg-slate-900 p-4">
          <div class="mb-3">
            <div class="text-xs text-slate-400">Auth token (OIDC JWT / service token). 修改后点击 Disconnect/Connect 生效。</div>
            <input
              class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
              placeholder="Bearer token (可留空：OA_AUTH_MODE=disabled)"
              value={authToken()}
              onInput={(e) => setAuthToken(e.currentTarget.value)}
            />
          </div>
          <div class="flex items-center justify-between">
            <div class="text-sm">
              Status: <span class="font-mono" data-testid="ws-status">{status()}</span>
            </div>
            <div class="text-sm">
              State: <span class="font-mono" data-testid="oa-state">{lastState()}</span>
            </div>
          </div>
          {connectionError() ? <div class="mt-2 text-sm text-rose-300">{connectionError()}</div> : null}
          <div class="mt-3 text-sm text-slate-200" data-testid="user-subtitle">
            User: {userSubtitle()}
          </div>
          <div class="mt-1 text-sm text-slate-200" data-testid="assistant-subtitle">
            Assistant: {assistantSubtitle()}
          </div>
          <div class="mt-4 flex gap-2">
            <button
              class="rounded bg-indigo-600 px-3 py-2 text-sm hover:bg-indigo-500"
              data-testid="btn-interrupt"
              onClick={() => sendInterrupt("button")}
            >
              Interrupt
            </button>
            <button
              class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              data-testid="btn-mic"
              onClick={() => (micStatus() === "on" ? stopMic() : startMic())}
            >
              Mic: {micStatus()}
            </button>
            <button
              class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              onClick={() => setTtsMode((m) => (m === "audio" ? "speech" : "audio"))}
            >
              TTS: {ttsMode()}
            </button>
          </div>
          <div class="mt-4 flex gap-2">
            <input
              class="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
              data-testid="dev-input"
              placeholder="Dev: 输入文本（模拟 ASR final）"
              value={draftText()}
              onInput={(e) => setDraftText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendText()
              }}
            />
            <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" data-testid="btn-send" onClick={sendText}>
              Send
            </button>
          </div>
        </section>

        <section class="rounded border border-slate-800 bg-slate-900 p-4">
          <div class="text-sm text-slate-300">Avatar / Player</div>
          <div class="mt-2 text-sm text-slate-200">
            Now playing: <span class="font-mono">{presentAssetId() || "(none)"}</span>
          </div>
          <div class="mt-1 text-xs text-slate-400">
            mouthOpen:{" "}
            <span class="font-mono" data-testid="mouth-open">
              {mouthOpen().toFixed(2)}
            </span>
          </div>
          <div class="mt-1 text-xs text-slate-400">
            lipsync:{" "}
            <span class="font-mono" data-testid="lipsync-mode">
              {lipsyncMode()}
            </span>
          </div>
          <div class="mt-1 text-xs text-slate-400">
            viseme:{" "}
            <span class="font-mono" data-testid="mouth-viseme">
              {mouthViseme()}
            </span>{" "}
            {mouthPhoneme() ? (
              <>
                phoneme:{" "}
                <span class="font-mono" data-testid="mouth-phoneme">
                  {mouthPhoneme()}
                </span>{" "}
              </>
            ) : null}
            {mouthWord() ? (
              <>
                word:{" "}
                <span class="font-mono" data-testid="mouth-word">
                  {mouthWord()}
                </span>
              </>
            ) : null}
          </div>
          <div class="mt-2 text-xs text-slate-400">
            sync: <span class="font-mono">{presentSyncMode()}</span>
            {presentSyncMode() === "tts" ? (
              <>
                {" "}
                turnId: <span class="font-mono">{presentSyncTurnId() || "(unknown)"}</span>
              </>
            ) : null}
          </div>
          <div class="mt-1 text-xs text-slate-400">
            timeline: present {fmtMs(timelinePresentAtMs())} / tts {fmtMs(timelineTtsStartAtMs())} / meta {fmtMs(timelineVideoMetaAtMs())} / play{" "}
            {fmtMs(timelineVideoPlayAtMs())}
          </div>
          <div class="mt-1 text-xs text-slate-400">
            offset: tts-present {fmtDeltaMs(timelineTtsStartAtMs(), timelinePresentAtMs())} / play-tts {fmtDeltaMs(timelineVideoPlayAtMs(), timelineTtsStartAtMs())}
          </div>
          <div class="mt-2 flex gap-2">
            <button
              class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              onClick={() => sendDevCommand("/present demo-video")}
            >
              Play demo-video
            </button>
            <button
              class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              onClick={() => sendDevCommand("/present demo-slides slides")}
            >
              Present demo-slides
            </button>
            <button
              class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
              onClick={() => sendDevCommand("/present demo-model model")}
            >
              Present demo-model
            </button>
            <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={() => sendDevCommand("/stop video")}>
              Stop video
            </button>
          </div>
          <div class="mt-1 text-sm text-rose-300">{presentError()}</div>

          <details class="mt-3 rounded border border-slate-800 bg-slate-950 px-3 py-2" classList={{ hidden: presentAssetType() !== "model" }}>
            <summary class="cursor-pointer select-none text-xs text-slate-300">Model lipsync mapping (optional)</summary>
            <div class="mt-2 text-xs text-slate-400">为真实 avatar 配置 blendshape 映射（保存到 localStorage）。</div>
            <textarea
              class="mt-2 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-200 outline-none focus:border-slate-700"
              rows={8}
              placeholder={modelMorphMapExample}
              value={modelMorphMapText()}
              onInput={(e) => setModelMorphMapText(e.currentTarget.value)}
            />
            <div class="mt-2 flex gap-2">
              <button class="rounded bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700" onClick={sendModelMorphMap}>
                Apply
              </button>
              <button class="rounded bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700" onClick={() => setModelMorphMapText(modelMorphMapExample)}>
                Load example
              </button>
              <button class="rounded bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700" onClick={() => setModelMorphMapText("")}>
                Clear
              </button>
            </div>
            {modelMorphMapError() ? <div class="mt-1 text-xs text-rose-300">{modelMorphMapError()}</div> : null}
          </details>

          <div
            class="mt-3 grid gap-4"
            classList={{
              "grid-cols-2": presentLayout() !== "full",
              "grid-cols-1": presentLayout() === "full",
            }}
          >
            {presentLayout() === "full" ? null : (
              <div class="aspect-video rounded bg-slate-800 p-4">
                <div class="flex h-full items-center justify-center">
                  <div class="relative h-40 w-40 rounded-full bg-slate-700">
                  <div class="absolute left-12 top-14 h-2 w-2 rounded-full bg-slate-200" />
                    <div class="absolute right-12 top-14 h-2 w-2 rounded-full bg-slate-200" />
                    <div
                      class="absolute bottom-10 left-1/2 -translate-x-1/2 bg-rose-300"
                      style={(() => {
                        const open = mouthOpen()
                        const v = mouthViseme()
                        const height = 4 + open * 18

                        const shape =
                          v === "sil" || v === "PP"
                            ? { width: 44, radius: 999 }
                            : v === "FF" || v === "TH" || v === "DD" || v === "SS" || v === "CH" || v === "nn" || v === "RR" || v === "ih"
                              ? { width: 56, radius: 999 }
                              : v === "E"
                                ? { width: 64, radius: 10 }
                                : v === "aa"
                                  ? { width: 62, radius: 10 }
                                  : v === "oh" || v === "ou"
                                    ? { width: 40, radius: 999 }
                                    : { width: 54, radius: 999 }

                        return {
                          height: `${height}px`,
                          width: `${shape.width}px`,
                          "border-radius": `${shape.radius}px`,
                        }
                      })()}
                    />
                  </div>
                </div>
              </div>
            )}
            <div class="aspect-video overflow-hidden rounded bg-black">
              {presentSrc() ? (
                presentAssetType() === "slides" ? (
                  <iframe
                    class="h-full w-full bg-white"
                    data-testid="slides-frame"
                    src={presentSrc()}
                    sandbox="allow-scripts"
                    referrerpolicy="no-referrer"
                  />
                ) : presentAssetType() === "model" ? (
                  <iframe
                    class="h-full w-full bg-black"
                    data-testid="model-frame"
                    src={`/model-frame.html?src=${encodeURIComponent(presentSrc())}`}
                    sandbox="allow-scripts allow-same-origin"
                    referrerpolicy="no-referrer"
                    ref={(el) => (modelFrameEl = el)}
                    onLoad={() => {
                      sendModelMorphMap()
                      maybeSendModelLipsync(performance.now())
                    }}
                  />
                ) : (
                  <video
                    ref={(el) => (videoEl = el)}
                    class="h-full w-full"
                    controls
                    playsinline
                    onLoadedMetadata={() => {
                      const startAt = presentStartAt()
                      if (!videoEl) return
                      setTimelineVideoMetaAtMs(performance.now())
                      if (typeof startAt === "number") {
                        try {
                          videoEl.currentTime = startAt
                        } catch {
                          // ignore
                        }
                      }
                      if (presentSyncMode() === "tts") {
                        tryStartSyncedVideo()
                        return
                      }
                      if (presentAutoplay()) {
                        videoEl.play().catch((err) => {
                          setPresentError(err instanceof Error ? err.message : String(err))
                        })
                      }
                    }}
                    onPlaying={() => setTimelineVideoPlayAtMs(performance.now())}
                    onError={() => setPresentError("Video load/play error")}
                  />
                )
              ) : (
                <div class="flex h-full items-center justify-center text-sm text-slate-400">(no asset)</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
