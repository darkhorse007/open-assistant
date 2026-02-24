# Open Assistant（基于 OpenCode 的全自动语音智能体 + 2D 数字人）技术方案

## 1. 目标与边界

### 1.1 目标（MVP）
- **形态**：网页端 2D 数字人（Live2D/Canvas/WebGL），带语音播报与口型同步。
- **交互**：纯语音对话（本地 ASR），支持**实时打断**（用户插话即停止播报并中止本轮推理/播放）。
- **检索**：只检索内网私有知识库（RAG），不出网。
- **内容编排**：可根据对话语境自动选择并播放内网素材库中的 **视频 / 幻灯片 / 3D 模型（glTF/GLB）**。
- **并发**：最多 **10 路会话并发**（每路独立会话状态、音频流、播放状态）。

### 1.2 非目标（第一阶段不做或弱化）
- 复杂情绪驱动、精细表情（先做可扩展接口）。
- 端到端多模态（视觉理解、摄像头理解）。
- 外网检索、外部链接播放（避免合规与不可控）。
- 在 OpenCode 中开放高风险工具（如 `bash/edit`）给全自动模式。

## 2. 总体架构

### 2.1 分层原则
- **OpenCode = 智能体内核**：对话规划、工具调用、权限与审计、会话管理。
- **Open Assistant Gateway = 实时编排层**：语音流、打断、排队与限流、把“智能体输出”转换成“可播语音+可执行播放动作”。
- **Web Client = 数字人呈现层**：采音、播放音频、口型驱动、播放视频/幻灯片/3D。
- **ASR/TTS/RAG/素材库 = 专用服务**：高吞吐、可横向扩展、可替换。

### 2.2 架构图（逻辑）
```mermaid
flowchart LR
  subgraph Client[Web Client (Windows/macOS 浏览器)]
    Mic[Mic/WebAudio] -->|PCM frames| WS_ASR[(WS: ASR)]
    Player[Video/Slides/3D Player]
    Avatar[2D Avatar + LipSync]
    AudioOut[Audio Output]
  end

  subgraph Core[Ubuntu 主机 / 内网]
    Gateway[Open Assistant Gateway]
    OpenCode[OpenCode Server]
    ASR[Local ASR Service]
    TTS[CosyVoice TTS Service]
    RAG[RAG Service]
    Library[Media Library Service]
  end

  WS_ASR --> ASR -->|partial/final text| Gateway
  Gateway -->|session.prompt| OpenCode
  OpenCode -->|SSE: /global/event| Gateway
  Gateway -->|rag.search| RAG
  Gateway -->|asset.search| Library
  Gateway -->|tts text chunks| TTS -->|audio chunks| Gateway -->|audio stream| AudioOut
  Gateway -->|ui.present| Player
  AudioOut --> Avatar
```

> 说明：`rag.search / asset.search / ui.present` 推荐以 **MCP 工具**形式接入 OpenCode；也可以由 Gateway 直接调用内网服务，再把结果以“工具输出”回灌到会话（两种方式均可）。

## 3. 核心组件与职责

### 3.1 Web Client（2D 数字人 + 播放器）
职责：
- 麦克风采集（`getUserMedia`），编码为 16kHz/16-bit PCM（或 Opus→Gateway→解码）。
- 与 Gateway 建立 WebSocket：发送音频帧、接收 TTS 音频流、接收 UI 动作（播放/停止/切换布局）。
- 口型同步：
  - **MVP**：基于音频振幅/能量（RMS）驱动 Live2D 参数（可做到节奏同步）。
  - **增强**：若 TTS 侧可提供 phoneme/时间戳，则映射 viseme 实现更精确口型。
- 播放器区：
  - video：`<video>`（建议内网服务支持 Range 请求，便于快进/拖动）。
  - slides：HTML/Reveal.js（或你们现有播放器）。
  - 3D：`<model-viewer>` 或 three.js 加载 `glb/gltf`。

### 3.2 Open Assistant Gateway（实时编排层）
职责：
- 每路会话的状态机：`idle/listening/thinking/speaking/presenting`。
- **打断（barge-in）**：
  - Web 端检测用户开始讲话（VAD 或阈值）→ 发送 `interrupt`。
  - Gateway 立即：停止当前 TTS 推送 + 通知播放器暂停/静音 + 调用 OpenCode `POST /session/:sessionID/abort` 中止本轮推理。
- 并发与排队：
  - 10 路会话并发时，ASR/TTS 需做**限并发**与队列（避免 GPU 抖动）。
  - 为每路会话维护 `AbortController`/取消令牌，贯穿 ASR 段、RAG 检索、TTS 合成与播放队列。
- 安全网关：
  - 仅允许播放内网素材库中 **assetId→url** 的白名单资源。
  - 对来自智能体的动作做 schema 校验与约束（禁止任意 URL）。
- 观测：
  - 记录每路会话的端到端延迟（ASR→RAG→LLM→TTS→首包）、排队长度、错误码。

### 3.3 OpenCode Server（智能体内核）
建议用法：
- 每个用户会话映射为一个 OpenCode `sessionID`。
- 通过 `POST /session/:sessionID/message` 发送用户文本（由 ASR 段落 finalize 得到）。
- 通过 `POST /session/:sessionID/abort` 支持打断与取消。
- 通过 `GET /global/event`（SSE）订阅消息与工具状态更新（事件 payload 中包含 `sessionID`）。

权限策略（关键）：
- 为“数字人智能体”创建独立 agent，默认 **deny** 高风险工具（`bash/edit` 等）。
- 仅允许：
  - `rag.search`（知识库检索）
  - `asset.search`（素材检索）
  - `ui.present/ui.stop`（播放控制）
  - `read/list/grep`（如确实需要读取本地资料；否则也可全部 deny）

### 3.4 本地 ASR 服务
目标：
- 流式（WebSocket），返回 `partial` 与 `final`（带时间戳/置信度）。
- 多路并发：10 路峰值，优先保证稳定延迟与可打断。

工程建议：
- 推荐落地：**FunASR Runtime（2pass WebSocket）**，由 `services/asr` 作为适配层对接（详见 `docs/ASR_FUNASR.md`）。
- 统一输入：16kHz mono PCM。
- 必须包含 VAD/端点检测（否则 10 路会把 GPU/CPU 吃满且延迟飘）。
- 支持 `cancel(sessionID)`：立刻停止当前解码。

### 3.5 CosyVoice TTS 服务
目标：
- 支持流式合成（分句/分段出音频 chunk）。
- 返回：
  - `audioChunks[]`（pcm/wav/opus）
  - 可选：口型辅助（用于更精确口型）：
    - `marks[]`：chunk 内 `tMs/open`（mouth-open，避免客户端 FFT/RMS）
    - `align segments[]`：`startMs/endMs/viseme/phoneme/word`（由 Gateway 通过独立 `tts.align` 下发，并用 `segmentId` 与 `tts.audio` 绑定）

并发策略：
- 建议采用 **worker 池**（多进程/多卡可扩展）。
- Gateway 设置 `maxConcurrentSynthesis`（例如 2~4）并排队；10 路同时播报时保证公平性（轮询/加权队列）。
- 推荐落地：**CosyVoice runtime（FastAPI/gRPC）**，由 `services/tts` 作为适配层对接（详见 `docs/TTS_COSYVOICE.md`）。

### 3.6 私有 RAG 服务
职责：
- 向量检索 + 可选重排，返回引用片段与来源。
- 支持过滤（按部门/项目/权限标签），避免越权检索。

建议接口：
- `POST /search`：`{ query, topK, filters, sessionContext } -> { passages:[{text, sourceId, score, meta}] }`
- `POST /answer`（可选）：返回“更适合拼到提示词里的结构化证据包”。

### 3.7 内网素材库服务（视频/幻灯片/3D）
职责：
- 索引：标题、标签、时长、类型、缩略图、播放 URL（内网）。
- 检索：`asset.search(query, type?, tags?)`。
- 访问控制：按租户/权限/项目过滤。
- 播放 URL：最好支持 Range；3D 使用 `glb/gltf`。

## 4. 核心交互流程

### 4.1 语音输入 → 文本（ASR）
1) Client 采集音频帧 → WS 发送给 ASR（可直接到 ASR 或经 Gateway 转发）。
2) ASR 返回 `partial`（用于 UI 实时字幕）与 `final`（用于触发一次“对话轮次”）。
3) Gateway 将 `final` 段落追加到当前会话上下文，并触发 OpenCode 推理。

### 4.2 文本 → 智能体推理（OpenCode）
1) Gateway 调 OpenCode：`POST /session/:sessionID/message`，body 中包含用户文本 parts。
2) OpenCode 运行指定 agent：
   - 先 `rag.search` 获取证据
   - 再总结主题/要点
   - 决定是否触发 `asset.search` + `ui.present`
   - 生成可播报的回答文本（用于 TTS）
3) Gateway 通过 `GET /global/event` 订阅到 message/tool 更新，抽取“可播报文本”和“播放动作”。

### 4.3 文本 → 语音（TTS）+ 口型同步
1) Gateway 对回答文本做分段（按标点、句长、语义块）。
2) 对每段调用 TTS，拿到音频 chunk 流。
3) Client 播放音频并驱动口型：
   - mouth-open：优先消费 `tts.audio.marks[].open`；缺失时回退到 analyser RMS
   - viseme/phoneme/word：优先消费独立消息 `tts.align.segments[]`（与 `tts.audio` 通过 `segmentId` 绑定）
   - 对齐缩放：每个 TTS segment 可按实际音频时长对 `tts.align` 时间轴做 scale（避免“估计时长”与真实时长漂移）

### 4.4 自动播放（视频/幻灯片/3D）
1) Agent 调 `asset.search` 拿到 `assetId`。
2) Agent 调 `ui.present({assetId, mode, layout, autoplay})`。
3) Client 接收到动作后加载资源并播放，并将 `playbackState` 回传 Gateway（可选）。

### 4.5 打断（Barge-in）
触发条件：
- Client 侧 VAD 检测到用户开始说话；或用户点击“打断”按钮。

动作：
- Client：立即暂停音频/视频输出（本地停止）。
- Gateway：
  - 停止向 Client 推送 TTS chunk（取消合成队列）。
  - 调 OpenCode：`POST /session/:sessionID/abort`（中止本轮推理/工具）。
  - 进入 `listening` 状态，接收新语音段。

## 5. 工具与协议设计（建议）

### 5.1 MCP 工具（推荐接入 OpenCode 的方式）
> 目标：把“全自动”限制在受控工具集合里，避免模型直接拼 URL 或执行危险操作。

#### `rag.search`
输入：
```json
{ "sessionID": "ws-session-xxx", "query": "string", "topK": 8 }
```
> 注：tenant/project 由 Gateway 根据 `sessionID` 注入并强校验；`filters` 可传但必须与会话一致。
输出（示例）：
```json
{ "passages": [{ "text": "…", "sourceId": "doc:123", "score": 0.82, "meta": { "title": "…" } }] }
```

#### `asset.search`
输入：
```json
{ "sessionID": "ws-session-xxx", "query": "string", "type": "video|slides|model", "topK": 5 }
```
> 注：tenant/project 由 Gateway 根据 `sessionID` 注入并强校验；模型不要自己拼接 URL，播放一律走 `ui.present(assetId)` + Gateway `/assets/:assetId`。
输出：
```json
{ "assets": [{ "assetId": "asset:456", "type": "video", "title": "…", "url": "https://intranet/…" }] }
```

#### `ui.present`
输入：
```json
{ "sessionID": "ws-session-xxx", "assetId": "asset:456", "autoplay": true, "layout": "side-by-side|full|pip", "startAtSeconds": 0 }
```
输出：
```json
{ "ok": true }
```

#### `ui.stop`（可选）
输入：
```json
{ "sessionID": "ws-session-xxx", "target": "tts|video|all" }
```

### 5.2 Gateway ↔ Client 协议（WebSocket）
建议消息类型：
- `audio.in`：客户端上行音频帧（含 sessionID、seq、format）。
- `asr.partial / asr.final`：字幕与最终段落。
- `tts.audio`：下行音频 chunk（含 seq、mime、sampleRate）。
- `avatar.lipsync`：口型事件（可选，若用振幅在客户端算可省）。
- `ui.present / ui.stop`：播放动作。
- `state`：服务端状态机同步（thinking/speaking/presenting）。
- `interrupt`：客户端打断请求。

## 6. 并发与容量（10 路）策略

### 6.1 关键经验
- **同时“说话”的路数**通常远小于在线会话数；因此要用 **VAD** 与 **按需解码**。
- GPU 上 ASR/TTS 需要**限并发**与队列，不要让 10 路同时做重推理。
- 所有阶段都必须支持 cancel，避免“已经打断但后台还在跑”导致延迟雪崩。

### 6.2 推荐调度
- ASR：
  - `maxConcurrentDecode`（例如 4~8，视模型与实时性压测调参）
  - 其余会话只做轻量 VAD 或排队
- TTS：
  - `maxConcurrentSynthesis`（例如 2~4）
  - 先保证首包（first audio）低延迟；长段落拆分成短句排队
- RAG：
  - 检索可多路并发（CPU/IO 为主），重排模型可限并发
- OpenCode：
  - 云端/内网 LLM API 另行限流（本方案默认不跑在此 GPU 上）

## 7. 安全、权限与合规

### 7.1 OpenCode 权限
- 为数字人 agent 配置最小权限集合（只允许 RAG/素材/播放相关工具）。
- 默认 deny `bash/edit`，避免“全自动”对主机产生不可控副作用。

### 7.2 素材与播放安全
- 播放资源必须来自 `assetId`（服务端映射到 URL），禁止模型直接提供 URL。
- 浏览器端启用 CSP（只允许内网域名媒体源）。
- 3D 模型与幻灯片在沙箱 iframe/隔离域加载（降低 XSS 风险）。

### 7.3 多租户与数据隔离
- RAG 与素材库检索必须带 `tenant/project` 过滤并在服务端强制校验。
- 会话级审计：记录 query、检索命中、播放动作、最终回答摘要（可脱敏）。

## 8. 部署建议（Ubuntu）

### 8.1 服务划分
- `opencode-server`：OpenCode 服务端（对内网开放）。
- `open-assistant-gateway`：WebSocket + 状态机 + 调度。
- `asr-service`：本地流式 ASR。
- `tts-service`：CosyVoice 流式合成。
- `rag-service`：向量库 + 检索 + 重排。
- `media-library`：索引与静态资源服务。

### 8.2 网络与端口（示例）
- Gateway：`443/HTTPS`（对用户浏览器）
- OpenCode：`4096`（内网）
- ASR/TTS/RAG/Library：内网端口（仅 Gateway/OpenCode 可访问）

### 8.3 运行形态
- 推荐容器化（docker-compose/K8s），ASR/TTS 绑定 GPU（CUDA）。
- 监控：Prometheus + Grafana；日志：Loki/ELK；链路追踪：OpenTelemetry（可选）。

## 9. 里程碑（建议）

### Phase 0：闭环 PoC（1~2 周）
- Web Client：采音、字幕、TTS 播放、振幅口型、video 播放。
- Gateway：单会话状态机、打断、OpenCode 对接。
- OpenCode：数字人 agent（只允许 rag + asset + ui）。
- RAG/素材库：最小搜索接口。

### Phase 1：10 路并发稳定（2~4 周）
- ASR/TTS worker 池、队列与公平调度、P95 延迟监控。
- 更严格的 schema 校验、CSP、allowlist、审计。

### Phase 2：观感增强（可选）
- viseme/phoneme 口型对齐、表情/动作控制协议。
- 播放编排更复杂（时间轴、多媒体联动、旁白与画面同步）。

---

## 10. 可执行 Backlog

请见：`open-assistant/docs/EXECUTABLE_BACKLOG.md`

