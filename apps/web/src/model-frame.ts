import "@google/model-viewer"

import { $needsRender, $scene } from "@google/model-viewer/lib/model-viewer-base.js"

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

type Viseme = "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS" | "nn" | "RR" | "aa" | "E" | "ih" | "oh" | "ou"

const VisemeOrder: Viseme[] = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"]
const VisemeSet = new Set<Viseme>(["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"])

function asViseme(v: unknown): Viseme {
  const s = String(v ?? "")
  return (VisemeSet.has(s as Viseme) ? s : "sil") as Viseme
}

function normName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function uniq<T>(items: T[]) {
  return Array.from(new Set(items))
}

type MorphBinding = {
  meshName: string
  influences: number[]
  managed: number[]
  jawOpenIndex?: number
  visemeIndex: Partial<Record<Viseme, number>>
}

type MorphMapConfig = {
  jawOpen?: string[]
  viseme?: Partial<Record<Viseme, string[]>>
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

function parseMorphMapConfig(raw: any): MorphMapConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined

  const cfg: MorphMapConfig = {}
  const jawOpen = asStringArray(raw.jawOpen)
  if (jawOpen) cfg.jawOpen = jawOpen

  const viseme = raw.viseme
  if (viseme && typeof viseme === "object") {
    for (const [k, v] of Object.entries(viseme as Record<string, unknown>)) {
      if (!VisemeSet.has(k as Viseme)) continue
      const names = asStringArray(v)
      if (!names) continue
      if (!cfg.viseme) cfg.viseme = {}
      cfg.viseme[k as Viseme] = names
    }
  }

  if (!cfg.jawOpen && !cfg.viseme) return undefined
  return cfg
}

function findMorphIndex(dict: Record<string, number>, candidates: string[]) {
  for (const c of candidates) {
    const idx = dict[c]
    if (typeof idx === "number" && Number.isFinite(idx)) return idx
  }

  const byNorm = new Map<string, number>()
  for (const [k, v] of Object.entries(dict)) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue
    byNorm.set(normName(k), v)
  }
  for (const c of candidates) {
    const idx = byNorm.get(normName(c))
    if (typeof idx === "number" && Number.isFinite(idx)) return idx
  }

  return undefined
}

function visemeCandidates(v: Viseme) {
  const base = [v, v.toLowerCase(), v.toUpperCase(), `viseme_${v}`, `viseme${v}`, `Viseme_${v}`, `Viseme${v}`]

  // Common vowel blendshape sets (VRM / simple rigs)
  if (v === "aa") base.push("A", "a", "vrc.v_a", "v_a", "mouthA", "mouth_a")
  if (v === "ih") base.push("I", "i", "vrc.v_i", "v_i", "mouthI", "mouth_i")
  if (v === "ou") base.push("U", "u", "vrc.v_u", "v_u", "mouthU", "mouth_u")
  if (v === "E") base.push("E", "e", "vrc.v_e", "v_e", "mouthE", "mouth_e")
  if (v === "oh") base.push("O", "o", "vrc.v_o", "v_o", "mouthO", "mouth_o")

  // Some rigs only expose "MouthOpen"/"MouthClose"
  if (v === "PP") base.push("mouthClose", "MouthClose", "mouth_close", "vrc.v_m", "v_m", "M", "m")

  if (v === "sil") base.push("rest", "Rest", "neutral", "Neutral")

  return uniq(base)
}

function jawOpenCandidates() {
  return uniq(["jawOpen", "JawOpen", "jaw_open", "jawopen", "mouthOpen", "MouthOpen", "mouth_open", "mouthopen", "vrc.v_jawopen", "v_jawopen"])
}

function main() {
  const viewer = document.getElementById("viewer") as HTMLElement | null
  const empty = document.getElementById("empty") as HTMLElement | null
  if (!viewer || !empty) return

  const overlay = document.createElement("div")
  overlay.setAttribute("data-testid", "lipsync-overlay")
  overlay.style.position = "absolute"
  overlay.style.top = "8px"
  overlay.style.left = "8px"
  overlay.style.padding = "6px 8px"
  overlay.style.borderRadius = "6px"
  overlay.style.background = "rgba(15, 23, 42, 0.75)"
  overlay.style.color = "#e2e8f0"
  overlay.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  overlay.style.fontSize = "12px"
  overlay.style.whiteSpace = "pre"
  overlay.style.pointerEvents = "none"
  overlay.textContent = "lipsync: (waiting)"
  document.body.appendChild(overlay)

  let mouthOpen = 0
  let viseme: Viseme = "sil"
  let phoneme = ""
  let word = ""
  let mappingNote = "morph: (loading...)"

  let bindings: MorphBinding[] = []
  let tickRaf: number | undefined
  let appliedOpen = 0

  function renderOverlay() {
    overlay.textContent = `open=${mouthOpen.toFixed(2)} viseme=${viseme}${phoneme ? ` phoneme=${phoneme}` : ""}${word ? ` word=${word}` : ""}\n${mappingNote}`
  }

  function applyMorph() {
    tickRaf = undefined
    const mv = viewer as any
    if (!bindings.length) return

    appliedOpen = appliedOpen * 0.7 + mouthOpen * 0.3
    if (Math.abs(appliedOpen - mouthOpen) < 0.002) appliedOpen = mouthOpen

    const v = viseme
    for (const b of bindings) {
      for (const idx of b.managed) b.influences[idx] = 0

      if (typeof b.jawOpenIndex === "number") b.influences[b.jawOpenIndex] = appliedOpen

      const vi = b.visemeIndex[v]
      if (typeof vi === "number" && v !== "sil") {
        const strength = v === "PP" ? Math.max(0.4, appliedOpen) : appliedOpen
        b.influences[vi] = strength
      }
    }

    try {
      mv[$needsRender]()
    } catch {
      // ignore
    }

    const idle = mouthOpen < 0.01 && appliedOpen < 0.01 && viseme === "sil"
    if (idle) return

    tickRaf = requestAnimationFrame(applyMorph)
  }

  function ensureMorphTick() {
    if (tickRaf) return
    tickRaf = requestAnimationFrame(applyMorph)
  }

  function rebuildMorphBindings() {
    const mv = viewer as any
    if (!mv?.loaded) {
      mappingNote = "morph: (loading...)"
      renderOverlay()
      return false
    }

    let note = "morph: (no model)"
    const out: MorphBinding[] = []

    try {
      const scene = mv[$scene] as any
      const gltf = scene?.currentGLTF as any
      const root = gltf?.scene as any

      if (!root) {
        bindings = []
        mappingNote = note
        renderOverlay()
        return true
      }

      root.traverse((obj: any) => {
        const dict = obj?.morphTargetDictionary as Record<string, number> | undefined
        const influences = obj?.morphTargetInfluences as number[] | undefined
        if (!dict || !influences || !Array.isArray(influences)) return

        const jawOpenIndex = findMorphIndex(dict, jawOpenCandidates())
        const visemeIndex: Partial<Record<Viseme, number>> = {}
        for (const v of VisemeSet) {
          const idx = findMorphIndex(dict, visemeCandidates(v))
          if (typeof idx === "number") visemeIndex[v] = idx
        }

        const managed = uniq([jawOpenIndex, ...Object.values(visemeIndex)].filter((x) => typeof x === "number")) as number[]
        if (!managed.length) return

        out.push({
          meshName: typeof obj?.name === "string" && obj.name ? obj.name : "(mesh)",
          influences,
          managed,
          jawOpenIndex: typeof jawOpenIndex === "number" ? jawOpenIndex : undefined,
          visemeIndex,
        })
      })

      if (out.length) {
        const mappedVisemes = new Set<Viseme>()
        let hasJawOpen = false
        for (const b of out) {
          if (typeof b.jawOpenIndex === "number") hasJawOpen = true
          for (const k of Object.keys(b.visemeIndex) as Viseme[]) mappedVisemes.add(k)
        }

        const mappedCount = out.reduce((sum, b) => sum + Object.keys(b.visemeIndex).length, 0)
        const visemes = VisemeOrder.filter((v) => v !== "sil" && mappedVisemes.has(v)).join(",") || "(none)"
        note = `morph: meshes=${out.length} mapped=${mappedCount} jawOpen=${hasJawOpen ? "yes" : "no"}\nvisemes=${visemes}`
        console.log("[oa.model] morph bindings", out.map((b) => ({ mesh: b.meshName, jawOpen: b.jawOpenIndex, visemes: Object.keys(b.visemeIndex) })))
      } else {
        note = "morph: (no blendshapes found)"
      }
    } catch {
      note = "morph: (scan failed)"
    }

    bindings = out
    mappingNote = note
    renderOverlay()

    if (mouthOpen > 0.01 || viseme !== "sil") ensureMorphTick()
    return true
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const msg = event.data as any
    if (!msg || msg.type !== "oa.lipsync") return

    mouthOpen = clamp(Number(msg.open ?? 0), 0, 1)
    viseme = asViseme(msg.viseme)
    phoneme = String(msg.phoneme ?? "")
    word = String(msg.word ?? "")
    renderOverlay()
    ensureMorphTick()
  })

  let src = ""
  try {
    const url = new URL(window.location.href)
    src = url.searchParams.get("src") ?? ""
  } catch {
    // ignore
  }

  if (!src) {
    viewer.style.display = "none"
    empty.style.display = "flex"
    return
  }

  viewer.addEventListener("load", rebuildMorphBindings)
  viewer.addEventListener("error", () => {
    mappingNote = "morph: (load error)"
    renderOverlay()
  })
  viewer.setAttribute("loading", "eager")
  viewer.setAttribute("src", src)
  viewer.style.display = "block"
  empty.style.display = "none"

  // Fallback: poll for a short period to handle cases where the `load` event is not fired
  // (or fires before the scene graph becomes available).
  let attempts = 0
  const maxAttempts = 80 // ~20s @ 250ms
  const poll = setInterval(() => {
    attempts += 1
    const done = rebuildMorphBindings()
    if (done || attempts >= maxAttempts) clearInterval(poll)
  }, 250)
}

main()
