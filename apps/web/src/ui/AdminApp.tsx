import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"

type Tab = "assets" | "documents" | "sessions" | "audit"

type AuditSearchResponse = {
  ok: boolean
  events?: Array<Record<string, unknown>>
  nextCursor?: number
  error?: string
}

type AuditHealthResponse = {
  ok: boolean
  enabled?: boolean
  mode?: string
  error?: string
}

type AuditSessionSummary = {
  sessionID: string
  tenant?: string
  project?: string
  firstTsMs: number
  lastTsMs: number
  lastId: number
  events: number
  lastEvent?: string
}

type AuditSessionsResponse = {
  ok: boolean
  sessions?: AuditSessionSummary[]
  nextCursor?: number
  error?: string
}

type MediaAssetStatus = "draft" | "approved" | "archived"

type MediaAsset = {
  assetId: string
  type: string
  status?: MediaAssetStatus
  title?: string
  tags?: string[]
  sourceType?: "local" | "remote"
  sourceHost?: string
}

type MediaListResponse = {
  ok: boolean
  assets?: MediaAsset[]
  nextCursor?: string
  error?: string
}

type MediaConfigResponse = {
  ok: boolean
  remoteEnabled?: boolean
  allowHosts?: string[]
  error?: string
  detail?: string
}

type MediaRemoteCreateResponse = {
  ok: boolean
  asset?: MediaAsset & { sourceHost?: string }
  error?: string
  detail?: string
  allowedHosts?: string[]
}

type RagDocStatus = "draft" | "approved" | "archived"

type RagIngestStatus = "idle" | "queued" | "running" | "succeeded" | "failed"

type RagDoc = {
  file: string
  chunks: number
  status?: RagDocStatus
  tags?: string[]
  ingestStatus?: RagIngestStatus
  ingestError?: string
  ingestTotalChunks?: number
  ingestDoneChunks?: number
  ingestStartedAtMs?: number
  ingestFinishedAtMs?: number
  ingestUpdatedAtMs?: number
}

type RagDocListResponse = {
  ok: boolean
  docs?: RagDoc[]
  nextCursor?: string
  error?: string
}

type RagPassage = {
  sourceId: string
  text: string
  score: number
  meta?: Record<string, unknown>
}

type RagSearchResponse = {
  passages?: RagPassage[]
  ok?: boolean
  error?: string
}

function parseBearer(value: string | undefined | null) {
  if (!value) return
  const m = value.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || undefined
}

function authHeaders(token: string) {
  const headers: Record<string, string> = {}
  const t = token.trim()
  if (!t) return headers
  const bare = parseBearer(t) ?? t
  headers["Authorization"] = `Bearer ${bare}`
  return headers
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function AdminApp() {
  const [tab, setTab] = createSignal<Tab>("audit")
  const [token, setToken] = createSignal<string>(sessionStorage.getItem("oa_admin_token") ?? import.meta.env.VITE_OA_ADMIN_TOKEN ?? "")
  const [copyToast, setCopyToast] = createSignal<string>("")
  const [manualCopyOpen, setManualCopyOpen] = createSignal(false)
  const [manualCopyText, setManualCopyText] = createSignal("")
  const [manualCopyLabel, setManualCopyLabel] = createSignal("")
  let copyToastTimeout: number | undefined
  let manualCopyTextarea: HTMLTextAreaElement | undefined

  function showCopyToast(message: string) {
    setCopyToast(message)
    if (copyToastTimeout) clearTimeout(copyToastTimeout)
    copyToastTimeout = window.setTimeout(() => setCopyToast(""), 2200)
  }

  function closeManualCopy() {
    setManualCopyOpen(false)
    setManualCopyText("")
    setManualCopyLabel("")
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // ignore
    }

    try {
      const el = document.createElement("textarea")
      el.value = text
      el.setAttribute("readonly", "true")
      el.style.position = "fixed"
      el.style.left = "-9999px"
      el.style.top = "0"
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand("copy")
      el.remove()
      return ok
    } catch {
      return false
    }
  }

  createEffect(() => {
    if (!manualCopyOpen()) return
    const t = window.setTimeout(() => {
      try {
        manualCopyTextarea?.focus()
        manualCopyTextarea?.select()
      } catch {
        // ignore
      }
    }, 0)
    onCleanup(() => window.clearTimeout(t))
  })

  createEffect(() => {
    const t = token().trim()
    if (t) sessionStorage.setItem("oa_admin_token", t)
    else sessionStorage.removeItem("oa_admin_token")
  })

  onCleanup(() => {
    if (copyToastTimeout) clearTimeout(copyToastTimeout)
  })

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "assets", label: "素材" },
    { id: "documents", label: "文档" },
    { id: "sessions", label: "会话" },
    { id: "audit", label: "审计" },
  ]

  // ---- Assets upload (Media) ----
  const [assetTenant, setAssetTenant] = createSignal<string>("default")
  const [assetProject, setAssetProject] = createSignal<string>("open-assistant")
  const [assetType, setAssetType] = createSignal<"auto" | "video" | "slides" | "model">("auto")
  const [assetTitle, setAssetTitle] = createSignal<string>("")
  const [assetTags, setAssetTags] = createSignal<string>("")
  const [assetId, setAssetId] = createSignal<string>("")
  const [assetFile, setAssetFile] = createSignal<File | undefined>(undefined)
  const [assetUploading, setAssetUploading] = createSignal(false)
  const [assetUploadError, setAssetUploadError] = createSignal("")
  const [assetUploadResult, setAssetUploadResult] = createSignal<Record<string, unknown> | undefined>(undefined)

  const [mediaConfigLoading, setMediaConfigLoading] = createSignal(false)
  const [mediaConfigError, setMediaConfigError] = createSignal("")
  const [mediaRemoteEnabled, setMediaRemoteEnabled] = createSignal<boolean | undefined>(undefined)
  const [mediaAllowHosts, setMediaAllowHosts] = createSignal<string[]>([])

  const [remoteUrl, setRemoteUrl] = createSignal<string>("")
  const [remoteType, setRemoteType] = createSignal<"auto" | "video" | "slides" | "model">("auto")
  const [remoteStatus, setRemoteStatus] = createSignal<MediaAssetStatus>("draft")
  const [remoteTitle, setRemoteTitle] = createSignal<string>("")
  const [remoteTags, setRemoteTags] = createSignal<string>("")
  const [remoteAssetId, setRemoteAssetId] = createSignal<string>("")
  const [remoteReason, setRemoteReason] = createSignal<string>("")
  const [remoteCreating, setRemoteCreating] = createSignal(false)
  const [remoteCreateError, setRemoteCreateError] = createSignal("")
  const [remoteCreateResult, setRemoteCreateResult] = createSignal<Record<string, unknown> | undefined>(undefined)
  const [remoteUpdating, setRemoteUpdating] = createSignal(false)
  const [remoteUpdateError, setRemoteUpdateError] = createSignal("")
  const [remoteUpdateResult, setRemoteUpdateResult] = createSignal<Record<string, unknown> | undefined>(undefined)

  const [assetListQuery, setAssetListQuery] = createSignal<string>("")
  const [assetListTags, setAssetListTags] = createSignal<string>("")
  const [assetListType, setAssetListType] = createSignal<"all" | "video" | "slides" | "model">("all")
  const [assetListStatus, setAssetListStatus] = createSignal<"all" | MediaAssetStatus>("all")
  const [assetListLimit, setAssetListLimit] = createSignal<number>(50)
  const [assetListLoading, setAssetListLoading] = createSignal(false)
  const [assetListError, setAssetListError] = createSignal("")
  const [assetListItems, setAssetListItems] = createSignal<MediaAsset[]>([])
  const [assetListNextCursor, setAssetListNextCursor] = createSignal<string | undefined>(undefined)
  const [assetActionReason, setAssetActionReason] = createSignal<string>("")

  const [assetEditId, setAssetEditId] = createSignal<string>("")
  const [assetEditType, setAssetEditType] = createSignal<"video" | "slides" | "model">("video")
  const [assetEditStatus, setAssetEditStatus] = createSignal<MediaAssetStatus>("draft")
  const [assetEditTitle, setAssetEditTitle] = createSignal<string>("")
  const [assetEditTags, setAssetEditTags] = createSignal<string>("")
  const [assetEditReason, setAssetEditReason] = createSignal<string>("")
  const [assetEditSaving, setAssetEditSaving] = createSignal(false)
  const [assetEditError, setAssetEditError] = createSignal("")
  const [assetEditResult, setAssetEditResult] = createSignal<Record<string, unknown> | undefined>(undefined)

  function adminAssetHref(assetIdToOpen: string) {
    const qs = new URLSearchParams()
    const tenant = assetTenant().trim()
    const project = assetProject().trim()
    if (tenant) qs.set("tenant", tenant)
    if (project) qs.set("project", project)

    const t = token().trim()
    if (t) qs.set("token", parseBearer(t) ?? t)

    const query = qs.toString()
    return `/admin/assets/${encodeURIComponent(assetIdToOpen)}${query ? `?${query}` : ""}`
  }

  function adminAuditHref(input: {
    tenant?: string
    project?: string
    sessionID?: string
    assetId?: string
    file?: string
    event?: string
    reason?: string
    since?: string
    until?: string
    order?: "asc" | "desc"
  }) {
    const qs = new URLSearchParams()
    qs.set("tab", "audit")

    const tenant = input.tenant?.trim()
    const project = input.project?.trim()
    const sessionID = input.sessionID?.trim()
    const assetId = input.assetId?.trim()
    const file = input.file?.trim()
    const event = input.event?.trim()
    const reason = input.reason?.trim()
    const since = input.since?.trim()
    const until = input.until?.trim()
    const order = input.order?.trim()

    if (tenant) qs.set("tenant", tenant)
    if (project) qs.set("project", project)
    if (sessionID) qs.set("sessionID", sessionID)
    if (assetId) qs.set("assetId", assetId)
    if (file) qs.set("file", file)
    if (event) qs.set("event", event)
    if (reason) qs.set("reason", reason)
    if (since) qs.set("since", since)
    if (until) qs.set("until", until)
    if (order === "asc" || order === "desc") qs.set("order", order)

    const t = token().trim()
    if (t) qs.set("token", parseBearer(t) ?? t)

    const query = qs.toString()
    return `/admin.html${query ? `?${query}` : ""}`
  }

  function absoluteHref(href: string) {
    try {
      return new URL(href, window.location.origin).toString()
    } catch {
      return href
    }
  }

  async function copyLink(href: string, label?: string) {
    const abs = absoluteHref(href)
    const ok = await copyToClipboard(abs)
    if (ok) {
      showCopyToast(`已复制${label ? `：${label}` : ""}`)
      return
    }
    setManualCopyLabel(label ?? "")
    setManualCopyText(abs)
    setManualCopyOpen(true)
  }

  function beginEditAsset(asset: MediaAsset) {
    setAssetEditId(asset.assetId)
    setAssetEditType((asset.type as any) ?? "video")
    setAssetEditStatus(asset.status ?? "draft")
    setAssetEditTitle(asset.title ?? "")
    setAssetEditTags(Array.isArray(asset.tags) ? asset.tags.join(",") : "")
    setAssetEditReason("")
    setAssetEditError("")
    setAssetEditResult(undefined)
  }

  async function updateAsset() {
    setAssetEditSaving(true)
    setAssetEditError("")
    setAssetEditResult(undefined)
    try {
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      const id = assetEditId().trim()
      if (!tenant || !project) {
        setAssetEditError("tenant/project 不能为空")
        return
      }
      if (!id) {
        setAssetEditError("assetId 不能为空")
        return
      }

      const tags = assetEditTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

      const reason = assetEditReason().trim()
      const body = {
        tenant,
        project,
        assetId: id,
        type: assetEditType(),
        status: assetEditStatus(),
        title: assetEditTitle().trim(),
        tags,
        reason: reason || undefined,
      }

      const res = await fetch("/admin/api/media/update", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setAssetEditError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setAssetEditResult(json)
      setAssetEditReason("")
      void listAssets({ reset: true })
    } catch (err) {
      setAssetEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssetEditSaving(false)
    }
  }

  async function setAssetStatus(assetIdToUpdate: string, status: MediaAssetStatus) {
    setAssetListError("")
    try {
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      if (!tenant || !project) {
        setAssetListError("tenant/project 不能为空")
        return
      }

      const reason = assetActionReason().trim()

      const body: Record<string, unknown> = { tenant, project, assetId: assetIdToUpdate, status }
      if (reason) body.reason = reason

      const res = await fetch("/admin/api/media/update", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setAssetListError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setAssetActionReason("")
      void listAssets({ reset: true })
    } catch (err) {
      setAssetListError(err instanceof Error ? err.message : String(err))
    }
  }

  async function uploadAsset() {
    setAssetUploading(true)
    setAssetUploadError("")
    setAssetUploadResult(undefined)
    try {
      const file = assetFile()
      if (!file) {
        setAssetUploadError("请选择文件")
        return
      }
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      if (!tenant || !project) {
        setAssetUploadError("tenant/project 不能为空")
        return
      }

      const fd = new FormData()
      fd.set("tenant", tenant)
      fd.set("project", project)
      fd.set("type", assetType())
      const title = assetTitle().trim()
      const tags = assetTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      if (title) fd.set("title", title)
      const id = assetId().trim()
      if (id) fd.set("assetId", id)
      for (const t of tags) fd.append("tags", t)
      fd.set("file", file)

      const res = await fetch("/admin/api/media/upload", {
        method: "POST",
        headers: { ...authHeaders(token()), "x-oa-tenant": tenant, "x-oa-project": project },
        body: fd,
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || json?.ok !== true) {
        setAssetUploadError(String((json as any)?.error ?? `HTTP ${res.status}`))
        return
      }
      setAssetUploadResult(json)
      void listAssets({ reset: true })
    } catch (err) {
      setAssetUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssetUploading(false)
    }
  }

  async function refreshMediaConfig() {
    setMediaConfigLoading(true)
    setMediaConfigError("")
    try {
      const res = await fetch("/admin/api/media/config", {
        method: "GET",
        headers: { ...authHeaders(token()) },
      })
      const json = (await res.json().catch(() => ({}))) as MediaConfigResponse
      if (!res.ok || json.ok !== true) {
        setMediaConfigError(String(json.error ?? json.detail ?? `HTTP ${res.status}`))
        return
      }
      setMediaRemoteEnabled(Boolean(json.remoteEnabled))
      setMediaAllowHosts(Array.isArray(json.allowHosts) ? json.allowHosts.map(String) : [])
    } catch (err) {
      setMediaConfigError(err instanceof Error ? err.message : String(err))
    } finally {
      setMediaConfigLoading(false)
    }
  }

  async function createRemoteAsset() {
    setRemoteCreating(true)
    setRemoteCreateError("")
    setRemoteCreateResult(undefined)
    try {
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      if (!tenant || !project) {
        setRemoteCreateError("tenant/project 不能为空")
        return
      }

      const url = remoteUrl().trim()
      if (!url) {
        setRemoteCreateError("url 不能为空")
        return
      }

      const tags = remoteTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

      const body: Record<string, unknown> = {
        tenant,
        project,
        url,
        type: remoteType(),
        status: remoteStatus(),
        title: remoteTitle().trim() || undefined,
        tags,
      }
      const assetId = remoteAssetId().trim()
      if (assetId) body.assetId = assetId

      const res = await fetch("/admin/api/media/remote", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as MediaRemoteCreateResponse
      if (!res.ok || json.ok !== true) {
        const allowed = Array.isArray(json.allowedHosts) ? json.allowedHosts.join(", ") : ""
        const hint = allowed ? `（allowedHosts: ${allowed}）` : ""
        setRemoteCreateError(String(json.error ?? json.detail ?? (json as any)?.error ?? `HTTP ${res.status}`) + hint)
        return
      }
      setRemoteCreateResult(json as any)
      void listAssets({ reset: true })
    } catch (err) {
      setRemoteCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoteCreating(false)
    }
  }

  async function updateRemoteAssetUrl() {
    setRemoteUpdating(true)
    setRemoteUpdateError("")
    setRemoteUpdateResult(undefined)
    try {
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      if (!tenant || !project) {
        setRemoteUpdateError("tenant/project 不能为空")
        return
      }

      const assetId = remoteAssetId().trim()
      if (!assetId) {
        setRemoteUpdateError("assetId 不能为空（用于更新现有 remote 素材）")
        return
      }

      const url = remoteUrl().trim()
      if (!url) {
        setRemoteUpdateError("url 不能为空")
        return
      }

      const reason = remoteReason().trim()

      const body: Record<string, unknown> = { tenant, project, assetId, url, type: remoteType() }
      if (reason) body.reason = reason

      const res = await fetch("/admin/api/media/remote/update", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as MediaRemoteCreateResponse
      if (!res.ok || json.ok !== true) {
        const allowed = Array.isArray(json.allowedHosts) ? json.allowedHosts.join(", ") : ""
        const hint = allowed ? `（allowedHosts: ${allowed}）` : ""
        setRemoteUpdateError(String(json.error ?? json.detail ?? (json as any)?.error ?? `HTTP ${res.status}`) + hint)
        return
      }
      setRemoteUpdateResult(json as any)
      setRemoteReason("")
      void listAssets({ reset: true })
    } catch (err) {
      setRemoteUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoteUpdating(false)
    }
  }

  async function listAssets(opts: { reset: boolean }) {
    setAssetListLoading(true)
    setAssetListError("")
    try {
      const tenant = assetTenant().trim()
      const project = assetProject().trim()
      if (!tenant || !project) {
        setAssetListError("tenant/project 不能为空")
        return
      }

      const cursor = opts.reset ? undefined : assetListNextCursor()
      const tags = assetListTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const body = {
        tenant,
        project,
        query: assetListQuery().trim() || undefined,
        tags: tags.length ? tags : undefined,
        type: assetListType() === "all" ? undefined : assetListType(),
        status: assetListStatus() === "all" ? undefined : assetListStatus(),
        limit: assetListLimit(),
        cursor,
      }

      const res = await fetch("/admin/api/media/list", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as MediaListResponse
      if (!res.ok || !json.ok) {
        setAssetListError(String(json.error ?? (json as any)?.detail ?? (json as any)?.error ?? `HTTP ${res.status}`))
        return
      }
      const items = Array.isArray(json.assets) ? json.assets : []
      setAssetListNextCursor(typeof json.nextCursor === "string" && json.nextCursor.trim() ? json.nextCursor : undefined)
      setAssetListItems(opts.reset ? items : [...assetListItems(), ...items])
    } catch (err) {
      setAssetListError(err instanceof Error ? err.message : String(err))
    } finally {
      setAssetListLoading(false)
    }
  }

  async function deleteAsset(assetIdToDelete: string) {
    const tenant = assetTenant().trim()
    const project = assetProject().trim()
    if (!tenant || !project) {
      setAssetListError("tenant/project 不能为空")
      return
    }
    if (!confirm(`确定删除素材 ${assetIdToDelete} ?`)) return

    setAssetListError("")
    try {
      const res = await fetch("/admin/api/media/delete", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify({ tenant, project, assetId: assetIdToDelete, deleteFile: true }),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setAssetListError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setAssetListItems(assetListItems().filter((a) => a.assetId !== assetIdToDelete))
    } catch (err) {
      setAssetListError(err instanceof Error ? err.message : String(err))
    }
  }

  function openAssetAudit(assetId: string) {
    setTab("audit")
    setAuditTenant(assetTenant().trim())
    setAuditProject(assetProject().trim())
    setAuditSessionID("")
    setAuditAssetId(assetId)
    setAuditFile("")
    setAuditEvent("admin.media.*")
    setAuditReason("")
    setAuditSince("")
    setAuditUntil("")
    setAuditCursor(undefined)
    setAuditEvents([])
    setAuditNextCursor(undefined)
    void auditSearch({ reset: true })
  }

  // ---- Documents upload (RAG) ----
  const [docTenant, setDocTenant] = createSignal<string>("default")
  const [docProject, setDocProject] = createSignal<string>("open-assistant")
  const [docMaxChars, setDocMaxChars] = createSignal<number>(900)
  const [docUploadTags, setDocUploadTags] = createSignal<string>("")
  const [docFile, setDocFile] = createSignal<File | undefined>(undefined)
  const [docUploading, setDocUploading] = createSignal(false)
  const [docUploadError, setDocUploadError] = createSignal("")
  const [docUploadResult, setDocUploadResult] = createSignal<Record<string, unknown> | undefined>(undefined)

  const [docListQuery, setDocListQuery] = createSignal<string>("")
  const [docListTags, setDocListTags] = createSignal<string>("")
  const [docListStatus, setDocListStatus] = createSignal<"all" | RagDocStatus>("all")
  const [docListLimit, setDocListLimit] = createSignal<number>(50)
  const [docListLoading, setDocListLoading] = createSignal(false)
  const [docListError, setDocListError] = createSignal("")
  const [docListItems, setDocListItems] = createSignal<RagDoc[]>([])
  const [docListNextCursor, setDocListNextCursor] = createSignal<string | undefined>(undefined)
  const [docActionReason, setDocActionReason] = createSignal<string>("")

  const [docEditFile, setDocEditFile] = createSignal<string>("")
  const [docEditStatus, setDocEditStatus] = createSignal<RagDocStatus>("draft")
  const [docEditTags, setDocEditTags] = createSignal<string>("")
  const [docEditReason, setDocEditReason] = createSignal<string>("")
  const [docEditSaving, setDocEditSaving] = createSignal(false)
  const [docEditError, setDocEditError] = createSignal("")
  const [docEditResult, setDocEditResult] = createSignal<Record<string, unknown> | undefined>(undefined)

  const [ragQuery, setRagQuery] = createSignal<string>("")
  const [ragTopK, setRagTopK] = createSignal<number>(8)
  const [ragSearchLoading, setRagSearchLoading] = createSignal(false)
  const [ragSearchError, setRagSearchError] = createSignal("")
  const [ragSearchItems, setRagSearchItems] = createSignal<RagPassage[]>([])

  async function uploadDoc() {
    setDocUploading(true)
    setDocUploadError("")
    setDocUploadResult(undefined)
    try {
      const file = docFile()
      if (!file) {
        setDocUploadError("请选择文件")
        return
      }
      const tenant = docTenant().trim()
      const project = docProject().trim()
      if (!tenant || !project) {
        setDocUploadError("tenant/project 不能为空")
        return
      }

      const fd = new FormData()
      fd.set("tenant", tenant)
      fd.set("project", project)
      fd.set("maxChars", String(docMaxChars()))
      const tags = docUploadTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      for (const t of tags) fd.append("tags", t)
      fd.set("file", file)

      const res = await fetch("/admin/api/rag/upload", {
        method: "POST",
        headers: { ...authHeaders(token()), "x-oa-tenant": tenant, "x-oa-project": project },
        body: fd,
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok || json?.ok !== true) {
        setDocUploadError(String((json as any)?.error ?? `HTTP ${res.status}`))
        return
      }
      setDocUploadResult(json)
      void listDocs({ reset: true })
    } catch (err) {
      setDocUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setDocUploading(false)
    }
  }

  async function listDocs(opts: { reset: boolean }) {
    setDocListLoading(true)
    setDocListError("")
    try {
      const tenant = docTenant().trim()
      const project = docProject().trim()
      if (!tenant || !project) {
        setDocListError("tenant/project 不能为空")
        return
      }

      const cursor = opts.reset ? undefined : docListNextCursor()
      const tags = docListTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const body = {
        tenant,
        project,
        query: docListQuery().trim() || undefined,
        tags: tags.length ? tags : undefined,
        status: docListStatus() === "all" ? undefined : docListStatus(),
        limit: docListLimit(),
        cursor,
      }

      const res = await fetch("/admin/api/rag/docs/list", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as RagDocListResponse
      if (!res.ok || !json.ok) {
        setDocListError(String(json.error ?? (json as any)?.detail ?? (json as any)?.error ?? `HTTP ${res.status}`))
        return
      }
      const items = Array.isArray(json.docs) ? json.docs : []
      setDocListNextCursor(typeof json.nextCursor === "string" && json.nextCursor.trim() ? json.nextCursor : undefined)
      setDocListItems(opts.reset ? items : [...docListItems(), ...items])
    } catch (err) {
      setDocListError(err instanceof Error ? err.message : String(err))
    } finally {
      setDocListLoading(false)
    }
  }

  createEffect(() => {
    if (tab() !== "documents") return
    const hasPendingIngest = docListItems().some((d) => d.ingestStatus === "queued" || d.ingestStatus === "running")
    if (!hasPendingIngest) return

    const id = setInterval(() => {
      if (tab() !== "documents") return
      if (docListLoading()) return
      void listDocs({ reset: true })
    }, 2000)

    onCleanup(() => clearInterval(id))
  })

  function beginEditDoc(doc: RagDoc) {
    setDocEditFile(doc.file)
    setDocEditStatus(doc.status ?? "approved")
    setDocEditTags(Array.isArray(doc.tags) ? doc.tags.join(",") : "")
    setDocEditReason("")
    setDocEditError("")
    setDocEditResult(undefined)
  }

  async function updateDoc() {
    setDocEditSaving(true)
    setDocEditError("")
    setDocEditResult(undefined)
    try {
      const tenant = docTenant().trim()
      const project = docProject().trim()
      const file = docEditFile().trim()
      if (!tenant || !project) {
        setDocEditError("tenant/project 不能为空")
        return
      }
      if (!file) {
        setDocEditError("file 不能为空")
        return
      }

      const tags = docEditTags()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)

      const reason = docEditReason().trim()
      const body = { tenant, project, file, status: docEditStatus(), tags, reason: reason || undefined }
      const res = await fetch("/admin/api/rag/docs/update", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setDocEditError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setDocEditResult(json)
      setDocEditReason("")
      void listDocs({ reset: true })
    } catch (err) {
      setDocEditError(err instanceof Error ? err.message : String(err))
    } finally {
      setDocEditSaving(false)
    }
  }

  async function setDocStatus(file: string, status: RagDocStatus) {
    setDocListError("")
    try {
      const tenant = docTenant().trim()
      const project = docProject().trim()
      if (!tenant || !project) {
        setDocListError("tenant/project 不能为空")
        return
      }

      const reason = docActionReason().trim()
      const res = await fetch("/admin/api/rag/docs/update", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify({ tenant, project, file, status, reason: reason || undefined }),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setDocListError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setDocActionReason("")
      void listDocs({ reset: true })
    } catch (err) {
      setDocListError(err instanceof Error ? err.message : String(err))
    }
  }

  async function deleteDoc(file: string) {
    const tenant = docTenant().trim()
    const project = docProject().trim()
    if (!tenant || !project) {
      setDocListError("tenant/project 不能为空")
      return
    }
    if (!confirm(`确定删除文档 ${file}（将移除所有入库段落）?`)) return

    setDocListError("")
    try {
      const reason = docActionReason().trim()
      const res = await fetch("/admin/api/rag/docs/delete", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify({ tenant, project, file, deleteFile: true, reason: reason || undefined }),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setDocListError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }
      setDocActionReason("")
      setDocListItems(docListItems().filter((d) => d.file !== file))
    } catch (err) {
      setDocListError(err instanceof Error ? err.message : String(err))
    }
  }

  async function retryDocIngest(file: string) {
    setDocListError("")
    try {
      const tenant = docTenant().trim()
      const project = docProject().trim()
      if (!tenant || !project) {
        setDocListError("tenant/project 不能为空")
        return
      }

      const reason = docActionReason().trim()
      const body: Record<string, unknown> = { tenant, project, file }
      if (reason) body.reason = reason

      const res = await fetch("/admin/api/rag/docs/ingest/retry", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as any
      if (!res.ok || json?.ok !== true) {
        setDocListError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }

      setDocActionReason("")
      void listDocs({ reset: true })
    } catch (err) {
      setDocListError(err instanceof Error ? err.message : String(err))
    }
  }

  function openDocAudit(file: string) {
    setTab("audit")
    setAuditTenant(docTenant().trim())
    setAuditProject(docProject().trim())
    setAuditSessionID("")
    setAuditAssetId("")
    setAuditFile(file)
    setAuditEvent("rag.ingest.*")
    setAuditReason("")
    setAuditSince("")
    setAuditUntil("")
    setAuditCursor(undefined)
    setAuditEvents([])
    setAuditNextCursor(undefined)
    void auditSearch({ reset: true })
  }

  async function searchRag() {
    setRagSearchLoading(true)
    setRagSearchError("")
    setRagSearchItems([])
    try {
      const tenant = docTenant().trim()
      const project = docProject().trim()
      const query = ragQuery().trim()
      if (!tenant || !project) {
        setRagSearchError("tenant/project 不能为空")
        return
      }
      if (!query) {
        setRagSearchError("query 不能为空")
        return
      }

      const body = { query, topK: ragTopK(), filters: { tenant, project } }
      const res = await fetch("/admin/api/rag/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as RagSearchResponse
      if (!res.ok) {
        setRagSearchError(String((json as any)?.error ?? `HTTP ${res.status}`))
        return
      }
      const passages = Array.isArray(json.passages) ? json.passages : []
      setRagSearchItems(passages)
    } catch (err) {
      setRagSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      setRagSearchLoading(false)
    }
  }

  // ---- Sessions view ----
  const [sessionsTenant, setSessionsTenant] = createSignal<string>("default")
  const [sessionsProject, setSessionsProject] = createSignal<string>("open-assistant")
  const [sessionsQuery, setSessionsQuery] = createSignal<string>("")
  const [sessionsSince, setSessionsSince] = createSignal<string>("")
  const [sessionsUntil, setSessionsUntil] = createSignal<string>("")
  const [sessionsLimit, setSessionsLimit] = createSignal<number>(50)
  const [sessionsOrder, setSessionsOrder] = createSignal<"desc" | "asc">("desc")
  const [sessionsCursor, setSessionsCursor] = createSignal<number | undefined>(undefined)

  const [sessionsLoading, setSessionsLoading] = createSignal(false)
  const [sessionsError, setSessionsError] = createSignal("")
  const [sessionsItems, setSessionsItems] = createSignal<AuditSessionSummary[]>([])
  const [sessionsNextCursor, setSessionsNextCursor] = createSignal<number | undefined>(undefined)

  function isoFromMs(ms: number | undefined) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return ""
    try {
      return new Date(ms).toISOString()
    } catch {
      return String(ms)
    }
  }

  async function sessionsSearch(opts: { reset: boolean }) {
    setSessionsLoading(true)
    setSessionsError("")
    try {
      const cursor = opts.reset ? undefined : sessionsNextCursor()
      const body = {
        tenant: sessionsTenant().trim() || undefined,
        project: sessionsProject().trim() || undefined,
        query: sessionsQuery().trim() || undefined,
        since: sessionsSince().trim() || undefined,
        until: sessionsUntil().trim() || undefined,
        limit: sessionsLimit(),
        order: sessionsOrder(),
        cursor,
      }

      const res = await fetch("/audit/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as AuditSessionsResponse
      if (!res.ok || !json.ok) {
        setSessionsError(json.error ? String(json.error) : `HTTP ${res.status}`)
        return
      }

      const sessions = Array.isArray(json.sessions) ? json.sessions : []
      setSessionsNextCursor(typeof json.nextCursor === "number" ? json.nextCursor : undefined)
      setSessionsCursor(cursor)
      setSessionsItems(opts.reset ? sessions : [...sessionsItems(), ...sessions])
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionsLoading(false)
    }
  }

  // ---- Audit view ----
  const [auditTenant, setAuditTenant] = createSignal<string>("")
  const [auditProject, setAuditProject] = createSignal<string>("")
  const [auditSessionID, setAuditSessionID] = createSignal<string>("")
  const [auditEvent, setAuditEvent] = createSignal<string>("")
  const [auditAssetId, setAuditAssetId] = createSignal<string>("")
  const [auditFile, setAuditFile] = createSignal<string>("")
  const [auditReason, setAuditReason] = createSignal<string>("")
  const [auditSince, setAuditSince] = createSignal<string>("")
  const [auditUntil, setAuditUntil] = createSignal<string>("")
  const [auditLimit, setAuditLimit] = createSignal<number>(200)
  const [auditOrder, setAuditOrder] = createSignal<"desc" | "asc">("desc")
  const [auditCursor, setAuditCursor] = createSignal<number | undefined>(undefined)

  const [auditHealth, setAuditHealth] = createSignal<AuditHealthResponse | undefined>(undefined)
  const [auditLoading, setAuditLoading] = createSignal(false)
  const [auditError, setAuditError] = createSignal("")
  const [auditEvents, setAuditEvents] = createSignal<Array<Record<string, unknown>>>([])
  const [auditNextCursor, setAuditNextCursor] = createSignal<number | undefined>(undefined)
  const [auditExportMaxRows, setAuditExportMaxRows] = createSignal<number>(5000)
  const [auditExporting, setAuditExporting] = createSignal(false)

  function openSessionAudit(s: AuditSessionSummary) {
    setTab("audit")
    setAuditTenant((s.tenant ?? sessionsTenant()).trim())
    setAuditProject((s.project ?? sessionsProject()).trim())
    setAuditSessionID(s.sessionID)
    setAuditEvent("")
    setAuditAssetId("")
    setAuditFile("")
    setAuditReason("")
    setAuditSince("")
    setAuditUntil("")
    setAuditOrder("asc")
    setAuditCursor(undefined)
    setAuditEvents([])
    setAuditNextCursor(undefined)
    void auditSearch({ reset: true })
  }

  async function refreshAuditHealth() {
    setAuditError("")
    try {
      const res = await fetch("/audit/healthz", { headers: { ...authHeaders(token()) } })
      const json = (await res.json().catch(() => ({}))) as AuditHealthResponse
      if (!res.ok) {
        setAuditHealth({ ok: false, error: `HTTP ${res.status}` })
        return
      }
      setAuditHealth(json)
    } catch (err) {
      setAuditHealth({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function auditSearch(opts: { reset: boolean }) {
    setAuditLoading(true)
    setAuditError("")
    try {
      const cursor = opts.reset ? undefined : auditNextCursor()
      const eventInput = auditEvent().trim()
      const eventPrefix = eventInput.endsWith("*") ? eventInput.slice(0, -1).trim() || undefined : undefined
      const event = eventPrefix ? undefined : eventInput || undefined
      const body = {
        tenant: auditTenant().trim() || undefined,
        project: auditProject().trim() || undefined,
        sessionID: auditSessionID().trim() || undefined,
        event,
        eventPrefix,
        assetId: auditAssetId().trim() || undefined,
        file: auditFile().trim() || undefined,
        reason: auditReason().trim() || undefined,
        since: auditSince().trim() || undefined,
        until: auditUntil().trim() || undefined,
        limit: auditLimit(),
        order: auditOrder(),
        cursor,
      }

      const res = await fetch("/audit/search", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as AuditSearchResponse
      if (!res.ok || !json.ok) {
        setAuditError(json.error ? String(json.error) : `HTTP ${res.status}`)
        return
      }

      const events = Array.isArray(json.events) ? json.events : []
      setAuditNextCursor(typeof json.nextCursor === "number" ? json.nextCursor : undefined)
      setAuditCursor(cursor)
      setAuditEvents(opts.reset ? events : [...auditEvents(), ...events])
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditLoading(false)
    }
  }

  function filenameFromDisposition(disposition: string | null | undefined) {
    const v = disposition?.trim()
    if (!v) return
    const m = v.match(/filename\s*=\s*\"?([^\";]+)\"?/i)
    return m?.[1]?.trim() || undefined
  }

  async function auditExport(format: "ndjson" | "csv") {
    setAuditExporting(true)
    setAuditError("")
    try {
      const eventInput = auditEvent().trim()
      const eventPrefix = eventInput.endsWith("*") ? eventInput.slice(0, -1).trim() || undefined : undefined
      const event = eventPrefix ? undefined : eventInput || undefined
      const body = {
        tenant: auditTenant().trim() || undefined,
        project: auditProject().trim() || undefined,
        sessionID: auditSessionID().trim() || undefined,
        event,
        eventPrefix,
        assetId: auditAssetId().trim() || undefined,
        file: auditFile().trim() || undefined,
        reason: auditReason().trim() || undefined,
        since: auditSince().trim() || undefined,
        until: auditUntil().trim() || undefined,
        order: auditOrder(),
        maxRows: auditExportMaxRows(),
        batchSize: 500,
        format,
      }

      const res = await fetch("/audit/export", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(token()) },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as any
        setAuditError(String(json?.error ?? `HTTP ${res.status}`))
        return
      }

      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const name = filenameFromDisposition(res.headers.get("content-disposition")) ?? `audit-export.${format === "csv" ? "csv" : "ndjson"}`
      const a = document.createElement("a")
      a.href = url
      a.download = name
      a.rel = "noreferrer"
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err))
    } finally {
      setAuditExporting(false)
    }
  }

  createEffect(() => {
    if (tab() !== "audit" && tab() !== "sessions") return
    void refreshAuditHealth()
  })

  let didAutoLoadSessions = false
  createEffect(() => {
    if (tab() !== "sessions") return
    if (didAutoLoadSessions) return
    didAutoLoadSessions = true
    void sessionsSearch({ reset: true })
  })

  let didInitFromUrl = false
  createEffect(() => {
    if (didInitFromUrl) return
    didInitFromUrl = true

    const qs = new URLSearchParams(window.location.search)

    const tokenFromUrl = qs.get("token")?.trim()
    if (tokenFromUrl) setToken(tokenFromUrl)

    const tenantFromUrl = qs.get("tenant")?.trim()
    const projectFromUrl = qs.get("project")?.trim()

    if (tenantFromUrl) {
      setAssetTenant(tenantFromUrl)
      setDocTenant(tenantFromUrl)
      setSessionsTenant(tenantFromUrl)
      setAuditTenant(tenantFromUrl)
    }
    if (projectFromUrl) {
      setAssetProject(projectFromUrl)
      setDocProject(projectFromUrl)
      setSessionsProject(projectFromUrl)
      setAuditProject(projectFromUrl)
    }

    const tabFromUrl = qs.get("tab")?.trim()
    const desiredTab: Tab | undefined =
      tabFromUrl === "assets" || tabFromUrl === "documents" || tabFromUrl === "sessions" || tabFromUrl === "audit" ? (tabFromUrl as Tab) : undefined

    const auditAssetIdFromUrl = qs.get("assetId")?.trim()
    const auditFileFromUrl = qs.get("file")?.trim()
    const auditEventFromUrl = qs.get("event")?.trim()
    const auditReasonFromUrl = qs.get("reason")?.trim()
    const auditSinceFromUrl = qs.get("since")?.trim()
    const auditUntilFromUrl = qs.get("until")?.trim()
    const auditOrderFromUrl = qs.get("order")?.trim()
    const auditSessionFromUrl = qs.get("sessionID")?.trim()

    const hasAuditPrefill = Boolean(
      auditAssetIdFromUrl ||
        auditFileFromUrl ||
        auditEventFromUrl ||
        auditReasonFromUrl ||
        auditSinceFromUrl ||
        auditUntilFromUrl ||
        auditOrderFromUrl ||
        auditSessionFromUrl ||
        desiredTab === "audit",
    )

    if (hasAuditPrefill) {
      setTab("audit")
      if (auditAssetIdFromUrl) setAuditAssetId(auditAssetIdFromUrl)
      if (auditFileFromUrl) setAuditFile(auditFileFromUrl)
      if (auditEventFromUrl) setAuditEvent(auditEventFromUrl)
      if (auditReasonFromUrl) setAuditReason(auditReasonFromUrl)
      if (auditSinceFromUrl) setAuditSince(auditSinceFromUrl)
      if (auditUntilFromUrl) setAuditUntil(auditUntilFromUrl)
      if (auditOrderFromUrl === "asc" || auditOrderFromUrl === "desc") setAuditOrder(auditOrderFromUrl)
      if (auditSessionFromUrl) setAuditSessionID(auditSessionFromUrl)

      setAuditCursor(undefined)
      setAuditEvents([])
      setAuditNextCursor(undefined)
      void auditSearch({ reset: true })
      return
    }

    if (desiredTab) setTab(desiredTab)
  })

  const auditSummary = createMemo(() => {
    const h = auditHealth()
    if (!h) return "未知"
    if (!h.ok) return `不可用${h.error ? `：${h.error}` : ""}`
    const enabled = h.enabled === true ? "enabled" : "disabled"
    const mode = h.mode ? `mode=${h.mode}` : ""
    return [enabled, mode].filter(Boolean).join(" ")
  })

  return (
    <div class="min-h-screen p-6">
      <div class="mx-auto max-w-6xl space-y-4">
        <header class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <h1 class="truncate text-xl font-semibold">Open Assistant Admin</h1>
            <div class="text-sm text-slate-300">
              <a class="underline decoration-slate-700 hover:decoration-slate-500" href="/" rel="noreferrer">
                返回对话页
              </a>
              <span class="mx-2 text-slate-600">•</span>
              <span class="font-mono text-xs">{window.location.origin}</span>
            </div>
          </div>
          <nav class="flex shrink-0 gap-2">
            <For each={tabs}>
              {(t) => (
                <button
                  class="rounded px-3 py-2 text-sm"
                  classList={{
                    "bg-slate-800 text-slate-100": tab() === t.id,
                    "bg-slate-950 text-slate-300 hover:bg-slate-900": tab() !== t.id,
                  }}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              )}
            </For>
          </nav>
        </header>

        <section class="rounded border border-slate-800 bg-slate-900 p-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div class="min-w-0">
              <div class="text-sm text-slate-200">管理令牌</div>
              <div class="text-xs text-slate-400">用于访问 /audit/* 与 /admin/api/*（优先 OA_ADMIN_TOKEN；未设置则兼容复用 OA_METRICS_TOKEN；均未设置可留空）</div>
            </div>
            <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
              <input
                class="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700 sm:w-[420px]"
                placeholder="Bearer <token> 或直接填 token"
                value={token()}
                onInput={(e) => setToken(e.currentTarget.value)}
              />
              <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={() => void refreshAuditHealth()}>
                刷新状态
              </button>
            </div>
          </div>
        </section>

        <Show when={copyToast()}>
          <div class="rounded border border-emerald-900 bg-emerald-950 px-3 py-2 text-sm text-emerald-100">{copyToast()}</div>
        </Show>

        <Show when={manualCopyOpen()}>
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => closeManualCopy()}>
            <div
              class="w-full max-w-2xl rounded border border-slate-800 bg-slate-950 p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-slate-200">手动复制链接</div>
                  <div class="mt-1 text-xs text-slate-400">
                    复制失败{manualCopyLabel() ? `：${manualCopyLabel()}` : ""}，请手动复制下方链接。
                  </div>
                </div>
                <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={() => closeManualCopy()}>
                  关闭
                </button>
              </div>

              <textarea
                ref={(el) => (manualCopyTextarea = el)}
                class="mt-3 h-28 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 outline-none focus:border-slate-700"
                value={manualCopyText()}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />

              <div class="mt-3 flex items-center justify-end gap-2">
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700"
                  onClick={() => {
                    void (async () => {
                      const ok = await copyToClipboard(manualCopyText())
                      if (ok) {
                        showCopyToast("已复制")
                        closeManualCopy()
                      } else {
                        showCopyToast("复制仍失败（请手动复制）")
                      }
                    })()
                  }}
                >
                  再试一次
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={tab() === "assets"}>
          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">素材上传</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/media/upload（转发到 Media /asset/upload）</div>
              </div>
              <button
                class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                disabled={assetUploading()}
                onClick={() => void uploadAsset()}
              >
                {assetUploading() ? "上传中…" : "上传"}
              </button>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">tenant</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetTenant()}
                  onInput={(e) => setAssetTenant(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">project</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetProject()}
                  onInput={(e) => setAssetProject(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">type</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetType()}
                  onChange={(e) => setAssetType(e.currentTarget.value as any)}
                >
                  <option value="auto">auto（按扩展名推断）</option>
                  <option value="video">video</option>
                  <option value="slides">slides</option>
                  <option value="model">model</option>
                </select>
              </label>
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">title（可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetTitle()}
                  onInput={(e) => setAssetTitle(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">assetId（可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-mono outline-none focus:border-slate-700"
                  placeholder="留空则自动生成"
                  value={assetId()}
                  onInput={(e) => setAssetId(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-3">
                <div class="text-xs text-slate-400">tags（逗号分隔，可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo,marketing,2026"
                  value={assetTags()}
                  onInput={(e) => setAssetTags(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-3">
                <div class="text-xs text-slate-400">file</div>
                <input
                  type="file"
                  class="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-100 hover:file:bg-slate-700"
                  onChange={(e) => setAssetFile(e.currentTarget.files?.[0] ?? undefined)}
                />
              </label>
            </div>

            <Show when={assetUploadError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{assetUploadError()}</div>
            </Show>
            <Show when={assetUploadResult()}>
              <div class="mt-3 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                <div class="text-xs text-slate-400">响应</div>
                <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(assetUploadResult())}</pre>
              </div>
            </Show>
          </section>

          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">Remote 素材</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/media/remote 与 /admin/api/media/remote/update</div>
              </div>
              <div class="flex gap-2">
                <button
                  class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                  disabled={mediaConfigLoading()}
                  onClick={() => void refreshMediaConfig()}
                >
                  {mediaConfigLoading() ? "刷新中…" : "刷新 allowlist"}
                </button>
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={remoteCreating()}
                  onClick={() => void createRemoteAsset()}
                >
                  {remoteCreating() ? "创建中…" : "创建"}
                </button>
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={remoteUpdating()}
                  onClick={() => void updateRemoteAssetUrl()}
                >
                  {remoteUpdating() ? "更新中…" : "更新 URL"}
                </button>
              </div>
            </div>

            <div class="mt-3 text-xs text-slate-400">
              allowlist:{" "}
              <span class="font-mono">
                {mediaRemoteEnabled() === undefined ? "(unknown)" : mediaRemoteEnabled() ? "enabled" : "disabled"}
              </span>
              <Show when={mediaAllowHosts().length}>
                <span class="mx-2 text-slate-700">•</span>
                hosts: <span class="font-mono">{mediaAllowHosts().join(", ")}</span>
              </Show>
              <Show when={mediaRemoteEnabled() === false}>
                <div class="mt-1 text-xs text-amber-300">Remote source 默认禁用：需要在 Media 配置 OA_MEDIA_ALLOW_HOSTS 才可创建/拉取。</div>
              </Show>
            </div>

            <Show when={mediaConfigError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{mediaConfigError()}</div>
            </Show>

            <div class="mt-4 grid gap-3 md:grid-cols-4">
              <label class="block text-sm md:col-span-4">
                <div class="text-xs text-slate-400">url（必须命中 allowlist host）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-mono outline-none focus:border-slate-700"
                  placeholder="https://intranet.example.com/path/to/demo.mp4"
                  value={remoteUrl()}
                  onInput={(e) => setRemoteUrl(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">type</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={remoteType()}
                  onChange={(e) => setRemoteType(e.currentTarget.value as any)}
                >
                  <option value="auto">auto（按 URL 扩展名推断）</option>
                  <option value="video">video</option>
                  <option value="slides">slides</option>
                  <option value="model">model</option>
                </select>
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">status</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={remoteStatus()}
                  onChange={(e) => setRemoteStatus(e.currentTarget.value as any)}
                >
                  <option value="draft">draft</option>
                  <option value="approved">approved</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">assetId（创建可选；更新 URL 必填）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm font-mono outline-none focus:border-slate-700"
                  placeholder="my-remote-asset"
                  value={remoteAssetId()}
                  onInput={(e) => setRemoteAssetId(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">title（可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="Remote Video"
                  value={remoteTitle()}
                  onInput={(e) => setRemoteTitle(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-4">
                <div class="text-xs text-slate-400">tags（逗号分隔，可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo,finance"
                  value={remoteTags()}
                  onInput={(e) => setRemoteTags(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-4">
                <div class="text-xs text-slate-400">变更原因（可选，写入审计；≤200）</div>
                <textarea
                  rows={2}
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：替换为最终版 / 修正片尾 logo"
                  value={remoteReason()}
                  onInput={(e) => setRemoteReason(e.currentTarget.value)}
                />
              </label>
            </div>

            <Show when={remoteCreateError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{remoteCreateError()}</div>
            </Show>
            <Show when={remoteCreateResult()}>
              <div class="mt-3 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                <div class="text-xs text-slate-400">响应</div>
                <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(remoteCreateResult())}</pre>
              </div>
            </Show>

            <Show when={remoteUpdateError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{remoteUpdateError()}</div>
            </Show>
            <Show when={remoteUpdateResult()}>
              <div class="mt-3 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                <div class="text-xs text-slate-400">响应（update）</div>
                <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(remoteUpdateResult())}</pre>
              </div>
            </Show>
          </section>

          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">素材列表</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/media/list</div>
              </div>
              <div class="flex gap-2">
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={assetListLoading()}
                  onClick={() => void listAssets({ reset: true })}
                >
                  刷新
                </button>
                <button
                  class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                  disabled={assetListLoading() || !assetListNextCursor()}
                  onClick={() => void listAssets({ reset: false })}
                >
                  加载更多
                </button>
              </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-4">
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">query（可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="按 assetId/title/tags 模糊匹配"
                  value={assetListQuery()}
                  onInput={(e) => setAssetListQuery(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">tags（精确，逗号分隔，可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo,finance"
                  value={assetListTags()}
                  onInput={(e) => setAssetListTags(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">type</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetListType()}
                  onChange={(e) => setAssetListType(e.currentTarget.value as any)}
                >
                  <option value="all">all</option>
                  <option value="video">video</option>
                  <option value="slides">slides</option>
                  <option value="model">model</option>
                </select>
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">status</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetListStatus()}
                  onChange={(e) => setAssetListStatus(e.currentTarget.value as any)}
                >
                  <option value="all">all</option>
                  <option value="draft">draft</option>
                  <option value="approved">approved</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">limit</div>
                <input
                  type="number"
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={assetListLimit()}
                  onInput={(e) => setAssetListLimit(Number(e.currentTarget.value))}
                />
              </label>
              <label class="block text-sm md:col-span-4">
                <div class="text-xs text-slate-400">动作原因（批准/下架/恢复，可选，写入审计；≤200）</div>
                <textarea
                  rows={2}
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：内容已核验 / 过期下架 / 修订后重新上架"
                  value={assetActionReason()}
                  onInput={(e) => setAssetActionReason(e.currentTarget.value)}
                />
              </label>
            </div>

            <div class="mt-2 text-xs text-slate-400">
              提示：启用 OA_AUTH_TAGS_MODE=enforce 后，未设置 tags 的素材默认不可检索/播放。
            </div>

            <Show when={assetEditId().trim()}>
              <div class="mt-4 rounded border border-slate-800 bg-slate-950 p-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div class="text-sm text-slate-200">素材编辑</div>
                    <div class="mt-1 text-xs text-slate-400">POST /admin/api/media/update（转发到 Media /asset/update）</div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                      disabled={assetEditSaving()}
                      onClick={() => void updateAsset()}
                    >
                      {assetEditSaving() ? "保存中…" : "保存"}
                    </button>
                    <button
                      class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                      disabled={assetEditSaving()}
                      onClick={() => {
                        setAssetEditId("")
                        setAssetEditError("")
                        setAssetEditResult(undefined)
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>

                <div class="mt-3 grid gap-3 md:grid-cols-4">
                  <label class="block text-sm md:col-span-2">
                    <div class="text-xs text-slate-400">assetId</div>
                    <input
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm font-mono outline-none focus:border-slate-700"
                      value={assetEditId()}
                      onInput={(e) => setAssetEditId(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm">
                    <div class="text-xs text-slate-400">type</div>
                    <select
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={assetEditType()}
                      onChange={(e) => setAssetEditType(e.currentTarget.value as any)}
                    >
                      <option value="video">video</option>
                      <option value="slides">slides</option>
                      <option value="model">model</option>
                    </select>
                  </label>
                  <label class="block text-sm">
                    <div class="text-xs text-slate-400">status</div>
                    <select
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={assetEditStatus()}
                      onChange={(e) => setAssetEditStatus(e.currentTarget.value as any)}
                    >
                      <option value="draft">draft</option>
                      <option value="approved">approved</option>
                      <option value="archived">archived</option>
                    </select>
                  </label>
                  <label class="block text-sm md:col-span-3">
                    <div class="text-xs text-slate-400">title（留空则清空）</div>
                    <input
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={assetEditTitle()}
                      onInput={(e) => setAssetEditTitle(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm md:col-span-3">
                    <div class="text-xs text-slate-400">tags（逗号分隔；留空则清空）</div>
                    <input
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={assetEditTags()}
                      onInput={(e) => setAssetEditTags(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm md:col-span-4">
                    <div class="text-xs text-slate-400">变更原因（可选，写入审计；≤200）</div>
                    <textarea
                      rows={2}
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      placeholder="例如：补齐 tags / 修正标题"
                      value={assetEditReason()}
                      onInput={(e) => setAssetEditReason(e.currentTarget.value)}
                    />
                  </label>
                </div>

                <Show when={assetEditError()}>
                  <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{assetEditError()}</div>
                </Show>
                <Show when={assetEditResult()}>
                  <div class="mt-3 rounded border border-slate-800 bg-slate-900 px-3 py-2">
                    <div class="text-xs text-slate-400">响应</div>
                    <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(assetEditResult())}</pre>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={assetListError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{assetListError()}</div>
            </Show>

            <div class="mt-4 space-y-2">
              <Show when={assetListItems().length === 0}>
                <div class="text-sm text-slate-400">暂无数据（点击“刷新”）。</div>
              </Show>
              <For each={assetListItems()}>
                {(a) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                    <div class="min-w-0">
                      <div class="truncate text-sm text-slate-200">
                        <span class="font-mono">{a.assetId}</span>
                        <span class="mx-2 text-slate-700">•</span>
                        <span class="font-mono text-xs text-slate-400">{a.type}</span>
                        <Show when={a.sourceType}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span class="font-mono text-xs text-slate-400">{a.sourceType}</span>
                        </Show>
                        <Show when={a.sourceHost}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span class="font-mono text-xs text-slate-400">{a.sourceHost}</span>
                        </Show>
                        <Show
                          when={
                            a.sourceType === "remote" &&
                            a.sourceHost &&
                            mediaAllowHosts().length > 0 &&
                            !mediaAllowHosts().includes(a.sourceHost)
                          }
                        >
                          <span class="mx-2 text-slate-700">•</span>
                          <span class="rounded bg-rose-950 px-2 py-0.5 text-xs font-mono text-rose-200">allowlist mismatch</span>
                        </Show>
                        <Show when={a.status}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span
                            class="rounded px-2 py-0.5 text-xs font-mono"
                            classList={{
                              "bg-amber-950 text-amber-200": a.status === "draft",
                              "bg-emerald-950 text-emerald-200": a.status === "approved",
                              "bg-slate-900 text-slate-200": a.status === "archived",
                            }}
                          >
                            {a.status}
                          </span>
                        </Show>
                        <Show when={a.title}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span class="text-xs text-slate-400">{a.title}</span>
                        </Show>
                      </div>
                      <Show when={a.tags && a.tags.length}>
                        <div class="mt-1 text-xs text-slate-500">tags: {(a.tags ?? []).join(", ")}</div>
                      </Show>
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <a
                        class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                        href={adminAssetHref(a.assetId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                      <button
                        class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                        onClick={() => void copyLink(adminAssetHref(a.assetId), "Open link")}
                      >
                        复制 link
                      </button>
                      <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={() => beginEditAsset(a)}>
                        编辑
                      </button>
                      <button
                        class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                        onClick={() => openAssetAudit(a.assetId)}
                      >
                        查看审计
                      </button>
                      <button
                        class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                        onClick={() =>
                          void copyLink(
                            adminAuditHref({ tenant: assetTenant(), project: assetProject(), assetId: a.assetId, event: "admin.media.*" }),
                            "审计 link",
                          )
                        }
                      >
                        复制 link
                      </button>
                      <Show when={a.status === "draft"}>
                        <button
                          class="rounded bg-emerald-900 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-800"
                          onClick={() => void setAssetStatus(a.assetId, "approved")}
                        >
                          批准
                        </button>
                      </Show>
                      <Show when={a.status === "approved"}>
                        <button
                          class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                          onClick={() => void setAssetStatus(a.assetId, "archived")}
                        >
                          下架
                        </button>
                      </Show>
                      <Show when={a.status === "archived"}>
                        <button
                          class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                          onClick={() => void setAssetStatus(a.assetId, "approved")}
                        >
                          恢复
                        </button>
                      </Show>
                      <button class="rounded bg-rose-900 px-3 py-2 text-sm text-rose-100 hover:bg-rose-800" onClick={() => void deleteAsset(a.assetId)}>
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={tab() === "documents"}>
          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">文档上传并入库</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/rag/upload（转发到 RAG /doc/upload）</div>
              </div>
              <button
                class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                disabled={docUploading()}
                onClick={() => void uploadDoc()}
              >
                {docUploading() ? "上传中…" : "上传"}
              </button>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">tenant</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={docTenant()}
                  onInput={(e) => setDocTenant(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">project</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={docProject()}
                  onInput={(e) => setDocProject(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">maxChars（分段长度）</div>
                <input
                  type="number"
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={docMaxChars()}
                  onInput={(e) => setDocMaxChars(Number(e.currentTarget.value))}
                />
              </label>
              <label class="block text-sm md:col-span-3">
                <div class="text-xs text-slate-400">file（.txt/.md/.markdown）</div>
                <input
                  type="file"
                  class="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:text-slate-100 hover:file:bg-slate-700"
                  onChange={(e) => setDocFile(e.currentTarget.files?.[0] ?? undefined)}
                />
              </label>
              <label class="block text-sm md:col-span-3">
                <div class="text-xs text-slate-400">tags（逗号分隔，可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo,finance"
                  value={docUploadTags()}
                  onInput={(e) => setDocUploadTags(e.currentTarget.value)}
                />
              </label>
            </div>

            <Show when={docUploadError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{docUploadError()}</div>
            </Show>
            <Show when={docUploadResult()}>
              <div class="mt-3 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                <div class="text-xs text-slate-400">响应</div>
                <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(docUploadResult())}</pre>
              </div>
            </Show>
          </section>

          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">文档列表</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/rag/docs/list</div>
              </div>
              <div class="flex gap-2">
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={docListLoading()}
                  onClick={() => void listDocs({ reset: true })}
                >
                  刷新
                </button>
                <button
                  class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                  disabled={docListLoading() || !docListNextCursor()}
                  onClick={() => void listDocs({ reset: false })}
                >
                  加载更多
                </button>
              </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-4">
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">query（可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="按文件名模糊匹配"
                  value={docListQuery()}
                  onInput={(e) => setDocListQuery(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">tags（精确，逗号分隔，可选）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo,finance"
                  value={docListTags()}
                  onInput={(e) => setDocListTags(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">status</div>
                <select
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={docListStatus()}
                  onChange={(e) => setDocListStatus(e.currentTarget.value as any)}
                >
                  <option value="all">all</option>
                  <option value="draft">draft</option>
                  <option value="approved">approved</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">limit</div>
                <input
                  type="number"
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={docListLimit()}
                  onInput={(e) => setDocListLimit(Number(e.currentTarget.value))}
                />
              </label>
              <label class="block text-sm md:col-span-4">
                <div class="text-xs text-slate-400">动作原因（批准/下架/恢复/删除，可选，写入审计；≤200）</div>
                <textarea
                  rows={2}
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：内容已核验 / 已过期 / 误传删除"
                  value={docActionReason()}
                  onInput={(e) => setDocActionReason(e.currentTarget.value)}
                />
              </label>
            </div>

            <div class="mt-2 text-xs text-slate-400">
              提示：启用 OA_AUTH_TAGS_MODE=enforce 后，未设置 tags 的内容默认不可检索（RAG）/播放（Media）。
            </div>

            <Show when={docEditFile().trim()}>
              <div class="mt-4 rounded border border-slate-800 bg-slate-950 p-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div class="text-sm text-slate-200">文档元信息编辑</div>
                    <div class="mt-1 text-xs text-slate-400">POST /admin/api/rag/docs/update（转发到 RAG /doc/update）</div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                      disabled={docEditSaving()}
                      onClick={() => void updateDoc()}
                    >
                      {docEditSaving() ? "保存中…" : "保存"}
                    </button>
                    <button
                      class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                      disabled={docEditSaving()}
                      onClick={() => {
                        setDocEditFile("")
                        setDocEditError("")
                        setDocEditResult(undefined)
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>

                <div class="mt-3 grid gap-3 md:grid-cols-4">
                  <label class="block text-sm md:col-span-2">
                    <div class="text-xs text-slate-400">file</div>
                    <input
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm font-mono outline-none focus:border-slate-700"
                      value={docEditFile()}
                      onInput={(e) => setDocEditFile(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm">
                    <div class="text-xs text-slate-400">status</div>
                    <select
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={docEditStatus()}
                      onChange={(e) => setDocEditStatus(e.currentTarget.value as any)}
                    >
                      <option value="draft">draft</option>
                      <option value="approved">approved</option>
                      <option value="archived">archived</option>
                    </select>
                  </label>
                  <label class="block text-sm md:col-span-3">
                    <div class="text-xs text-slate-400">tags（逗号分隔；留空则清空）</div>
                    <input
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      value={docEditTags()}
                      onInput={(e) => setDocEditTags(e.currentTarget.value)}
                    />
                  </label>
                  <label class="block text-sm md:col-span-4">
                    <div class="text-xs text-slate-400">变更原因（可选，写入审计；≤200）</div>
                    <textarea
                      rows={2}
                      class="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-slate-700"
                      placeholder="例如：补齐 tags / 下架原因"
                      value={docEditReason()}
                      onInput={(e) => setDocEditReason(e.currentTarget.value)}
                    />
                  </label>
                </div>

                <Show when={docEditError()}>
                  <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{docEditError()}</div>
                </Show>
                <Show when={docEditResult()}>
                  <div class="mt-3 rounded border border-slate-800 bg-slate-900 px-3 py-2">
                    <div class="text-xs text-slate-400">响应</div>
                    <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(docEditResult())}</pre>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={docListError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{docListError()}</div>
            </Show>

            <div class="mt-4 space-y-2">
              <Show when={docListItems().length === 0}>
                <div class="text-sm text-slate-400">暂无数据（点击“刷新”）。</div>
              </Show>
              <For each={docListItems()}>
                {(d) => (
                  <div class="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                    <div class="min-w-0">
                      <div class="truncate text-sm text-slate-200">
                        <span class="font-mono">{d.file}</span>
                        <Show when={d.status}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span
                            class="rounded px-2 py-0.5 text-xs font-mono"
                            classList={{
                              "bg-amber-950 text-amber-200": d.status === "draft",
                              "bg-emerald-950 text-emerald-200": d.status === "approved",
                              "bg-slate-900 text-slate-200": d.status === "archived",
                            }}
                          >
                            {d.status}
                          </span>
                        </Show>
                        <span class="mx-2 text-slate-700">•</span>
                        <span class="font-mono text-xs text-slate-400">chunks={d.chunks}</span>
                        <Show when={d.ingestStatus && d.ingestStatus !== "idle"}>
                          <span class="mx-2 text-slate-700">•</span>
                          <span
                            class="rounded px-2 py-0.5 text-xs font-mono"
                            classList={{
                              "bg-slate-900 text-slate-200": d.ingestStatus === "idle",
                              "bg-sky-950 text-sky-200": d.ingestStatus === "queued" || d.ingestStatus === "running",
                              "bg-emerald-950 text-emerald-200": d.ingestStatus === "succeeded",
                              "bg-rose-950 text-rose-200": d.ingestStatus === "failed",
                            }}
                          >
                            ingest={d.ingestStatus}
                          </span>
                        </Show>
                        <Show
                          when={
                            (d.ingestStatus === "running" || d.ingestStatus === "queued") &&
                            typeof d.ingestDoneChunks === "number" &&
                            typeof d.ingestTotalChunks === "number"
                          }
                        >
                          <span class="mx-2 text-slate-700">•</span>
                          <span class="font-mono text-xs text-slate-400">
                            {d.ingestDoneChunks}/{d.ingestTotalChunks}
                          </span>
                        </Show>
                      </div>
                      <Show when={d.tags && d.tags.length}>
                        <div class="mt-1 text-xs text-slate-500">tags: {(d.tags ?? []).join(", ")}</div>
                      </Show>
                      <Show when={d.ingestStatus === "failed" && d.ingestError}>
                        <div class="mt-1 text-xs text-rose-200">ingest error: {d.ingestError}</div>
                      </Show>
                    </div>
                    <div class="flex shrink-0 gap-2">
                      <button class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700" onClick={() => beginEditDoc(d)}>
                        编辑
                      </button>
                      <button
                        class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                        onClick={() => openDocAudit(d.file)}
                      >
                        查看审计
                      </button>
                      <button
                        class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900"
                        onClick={() =>
                          void copyLink(
                            adminAuditHref({ tenant: docTenant(), project: docProject(), file: d.file, event: "rag.ingest.*" }),
                            "审计 link",
                          )
                        }
                      >
                        复制 link
                      </button>
                      <Show when={d.ingestStatus === "failed"}>
                        <button
                          class="rounded bg-amber-900 px-3 py-2 text-sm text-amber-100 hover:bg-amber-800"
                          onClick={() => void retryDocIngest(d.file)}
                        >
                          重试入库
                        </button>
                      </Show>
                      <Show when={d.status === "draft"}>
                        <button
                          class="rounded bg-emerald-900 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-800"
                          onClick={() => void setDocStatus(d.file, "approved")}
                        >
                          批准
                        </button>
                      </Show>
                      <Show when={d.status === "approved"}>
                        <button
                          class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                          onClick={() => void setDocStatus(d.file, "archived")}
                        >
                          下架
                        </button>
                      </Show>
                      <Show when={d.status === "archived"}>
                        <button
                          class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                          onClick={() => void setDocStatus(d.file, "approved")}
                        >
                          恢复
                        </button>
                      </Show>
                      <button class="rounded bg-rose-900 px-3 py-2 text-sm text-rose-100 hover:bg-rose-800" onClick={() => void deleteDoc(d.file)}>
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </section>

          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">RAG 检索（passages）</div>
                <div class="mt-1 text-xs text-slate-400">POST /admin/api/rag/search</div>
              </div>
              <button
                class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                disabled={ragSearchLoading()}
                onClick={() => void searchRag()}
              >
                搜索
              </button>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm md:col-span-2">
                <div class="text-xs text-slate-400">query</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：安全约束"
                  value={ragQuery()}
                  onInput={(e) => setRagQuery(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">topK</div>
                <input
                  type="number"
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={ragTopK()}
                  onInput={(e) => setRagTopK(Number(e.currentTarget.value))}
                />
              </label>
            </div>

            <Show when={ragSearchError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{ragSearchError()}</div>
            </Show>

            <div class="mt-4 space-y-2">
              <Show when={ragSearchItems().length === 0}>
                <div class="text-sm text-slate-400">暂无结果。</div>
              </Show>
              <For each={ragSearchItems()}>
                {(p) => (
                  <details class="rounded border border-slate-800 bg-slate-950 px-3 py-2">
                    <summary class="cursor-pointer select-none text-sm text-slate-200">
                      <span class="font-mono text-xs text-slate-400">score={p.score.toFixed(3)}</span>
                      <span class="mx-2 text-slate-700">•</span>
                      <span class="font-mono">{p.sourceId}</span>
                    </summary>
                    <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{p.text}</pre>
                  </details>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={tab() === "sessions"}>
          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">会话审计</div>
                <div class="mt-1 text-xs text-slate-400">状态：{auditSummary()}</div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={sessionsLoading()}
                  onClick={() => void sessionsSearch({ reset: true })}
                >
                  查询
                </button>
                <button
                  class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                  disabled={sessionsLoading() || !sessionsNextCursor()}
                  onClick={() => void sessionsSearch({ reset: false })}
                >
                  加载更多
                </button>
              </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">tenant</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="默认：default"
                  value={sessionsTenant()}
                  onInput={(e) => setSessionsTenant(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">project</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="默认：open-assistant"
                  value={sessionsProject()}
                  onInput={(e) => setSessionsProject(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">query（sessionID contains）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="可留空"
                  value={sessionsQuery()}
                  onInput={(e) => setSessionsQuery(e.currentTarget.value)}
                />
              </label>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">since（ms 或 ISO 时间）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：2026-01-28T00:00:00Z 或 1738022400000"
                  value={sessionsSince()}
                  onInput={(e) => setSessionsSince(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">until（ms 或 ISO 时间）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="可留空"
                  value={sessionsUntil()}
                  onInput={(e) => setSessionsUntil(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">limit</div>
                <input
                  type="number"
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={sessionsLimit()}
                  onInput={(e) => setSessionsLimit(Number(e.currentTarget.value))}
                />
              </label>
            </div>

            <div class="mt-3 flex flex-wrap items-end gap-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">order</div>
                <select
                  class="mt-1 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={sessionsOrder()}
                  onChange={(e) => setSessionsOrder(e.currentTarget.value === "asc" ? "asc" : "desc")}
                >
                  <option value="desc">desc</option>
                  <option value="asc">asc</option>
                </select>
              </label>
              <div class="ml-auto text-xs text-slate-400">
                <div>cursor: {sessionsCursor() ?? "(none)"}</div>
                <div>next: {sessionsNextCursor() ?? "(none)"}</div>
              </div>
            </div>

            <Show when={sessionsError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{sessionsError()}</div>
            </Show>

            <div class="mt-4 space-y-2">
              <Show when={sessionsItems().length === 0}>
                <div class="text-sm text-slate-400">暂无会话（可点击“查询”）。</div>
              </Show>
              <For each={sessionsItems()}>
                {(s) => (
                  <details class="rounded border border-slate-800 bg-slate-950 px-3 py-2">
                    <summary class="cursor-pointer select-none">
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="font-mono text-xs text-slate-400">{isoFromMs(s.lastTsMs)}</div>
                          <div class="mt-1 truncate font-mono text-sm text-slate-200">{s.sessionID}</div>
                          <div class="mt-1 text-xs text-slate-400">
                            <span class="font-mono">
                              {(s.tenant ?? sessionsTenant()).trim()}/{(s.project ?? sessionsProject()).trim()}
                            </span>
                            <span class="mx-2 text-slate-700">•</span>
                            <span class="font-mono">events={s.events}</span>
                            <Show when={s.lastEvent}>
                              <span class="mx-2 text-slate-700">•</span>
                              <span class="font-mono">last={String(s.lastEvent ?? "")}</span>
                            </Show>
                          </div>
                        </div>
                        <div class="flex shrink-0 flex-wrap gap-2">
                          <button
                            class="rounded bg-slate-800 px-3 py-1.5 text-xs hover:bg-slate-700"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              openSessionAudit(s)
                            }}
                          >
                            回放
                          </button>
                          <button
                            class="rounded bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void copyLink(
                                adminAuditHref({
                                  tenant: (s.tenant ?? sessionsTenant()).trim() || undefined,
                                  project: (s.project ?? sessionsProject()).trim() || undefined,
                                  sessionID: s.sessionID,
                                  order: "asc",
                                }),
                                "会话审计",
                              )
                            }}
                          >
                            复制审计链接
                          </button>
                        </div>
                      </div>
                    </summary>

                    <div class="mt-3 grid gap-2 text-xs text-slate-300 md:grid-cols-2">
                      <div>
                        <span class="text-slate-500">first:</span> <span class="font-mono">{isoFromMs(s.firstTsMs)}</span>
                      </div>
                      <div>
                        <span class="text-slate-500">last:</span> <span class="font-mono">{isoFromMs(s.lastTsMs)}</span>
                      </div>
                      <div>
                        <span class="text-slate-500">lastId:</span> <span class="font-mono">{s.lastId}</span>
                      </div>
                      <div>
                        <span class="text-slate-500">events:</span> <span class="font-mono">{s.events}</span>
                      </div>
                    </div>
                  </details>
                )}
              </For>
            </div>
          </section>
        </Show>

        <Show when={tab() === "audit"}>
          <section class="rounded border border-slate-800 bg-slate-900 p-4">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm text-slate-200">审计查询</div>
                <div class="mt-1 text-xs text-slate-400">状态：{auditSummary()}</div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-60"
                  disabled={auditLoading()}
                  onClick={() => void auditSearch({ reset: true })}
                >
                  查询
                </button>
                <button
                  class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
                  disabled={auditExporting()}
                  onClick={() => void auditExport("ndjson")}
                >
                  {auditExporting() ? "导出中…" : "导出 NDJSON"}
                </button>
                <button
                  class="rounded bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-60"
                  disabled={auditExporting()}
                  onClick={() => void auditExport("csv")}
                >
                  {auditExporting() ? "导出中…" : "导出 CSV"}
                </button>
                <button
                  class="rounded bg-slate-950 px-3 py-2 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-60"
                  disabled={auditLoading() || !auditNextCursor()}
                  onClick={() => void auditSearch({ reset: false })}
                >
                  加载更多
                </button>
              </div>
            </div>

            <div class="mt-4 grid gap-3 md:grid-cols-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">tenant</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditTenant()}
                  onInput={(e) => setAuditTenant(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">project</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditProject()}
                  onInput={(e) => setAuditProject(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">sessionID</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditSessionID()}
                  onInput={(e) => setAuditSessionID(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">event（精确；或 prefix*）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：rag.ingest.* 或 admin.media.asset.update"
                  value={auditEvent()}
                  onInput={(e) => setAuditEvent(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">assetId（精确）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="demo-video"
                  value={auditAssetId()}
                  onInput={(e) => setAuditAssetId(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">file（精确）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="kb.md"
                  value={auditFile()}
                  onInput={(e) => setAuditFile(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">reason（包含）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：最终版 / 过期"
                  value={auditReason()}
                  onInput={(e) => setAuditReason(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">since（ms 或 ISO 时间）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="例如：2026-01-28T00:00:00Z 或 1738022400000"
                  value={auditSince()}
                  onInput={(e) => setAuditSince(e.currentTarget.value)}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">until（ms 或 ISO 时间）</div>
                <input
                  class="mt-1 w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  placeholder="可留空"
                  value={auditUntil()}
                  onInput={(e) => setAuditUntil(e.currentTarget.value)}
                />
              </label>
            </div>

            <div class="mt-3 flex flex-wrap items-end gap-3">
              <label class="block text-sm">
                <div class="text-xs text-slate-400">limit</div>
                <input
                  type="number"
                  class="mt-1 w-28 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditLimit()}
                  onInput={(e) => setAuditLimit(Number(e.currentTarget.value))}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">exportMaxRows</div>
                <input
                  type="number"
                  class="mt-1 w-32 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditExportMaxRows()}
                  onInput={(e) => setAuditExportMaxRows(Number(e.currentTarget.value))}
                />
              </label>
              <label class="block text-sm">
                <div class="text-xs text-slate-400">order</div>
                <select
                  class="mt-1 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-slate-700"
                  value={auditOrder()}
                  onChange={(e) => setAuditOrder(e.currentTarget.value === "asc" ? "asc" : "desc")}
                >
                  <option value="desc">desc</option>
                  <option value="asc">asc</option>
                </select>
              </label>
              <div class="ml-auto text-xs text-slate-400">
                <div>cursor: {auditCursor() ?? "(none)"}</div>
                <div>next: {auditNextCursor() ?? "(none)"}</div>
              </div>
            </div>

            <Show when={auditError()}>
              <div class="mt-3 rounded border border-rose-900 bg-rose-950 px-3 py-2 text-sm text-rose-200">{auditError()}</div>
            </Show>

            <div class="mt-4 space-y-2">
              <Show when={auditEvents().length === 0}>
                <div class="text-sm text-slate-400">暂无数据（可点击“查询”）。</div>
              </Show>
              <For each={auditEvents()}>
                {(e) => (
                  <details class="rounded border border-slate-800 bg-slate-950 px-3 py-2">
                    <summary class="cursor-pointer select-none text-sm text-slate-200">
                      <span class="font-mono text-xs text-slate-400">{String(e.ts ?? "")}</span>
                      <span class="mx-2 text-slate-700">•</span>
                      <span class="font-mono">{String(e.event ?? "")}</span>
                      <Show when={e.sessionID}>
                        <span class="mx-2 text-slate-700">•</span>
                        <span class="font-mono text-xs text-slate-300">session={String(e.sessionID ?? "")}</span>
                      </Show>
                      <Show when={e.tenant || e.project}>
                        <span class="mx-2 text-slate-700">•</span>
                        <span class="font-mono text-xs text-slate-300">
                          {String(e.tenant ?? "")}/{String(e.project ?? "")}
                        </span>
                      </Show>
                    </summary>
                    <pre class="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">{prettyJson(e)}</pre>
                  </details>
                )}
              </For>
            </div>
          </section>
        </Show>
      </div>
    </div>
  )
}
