# Open Assistant 协议（v0）

本文件描述 `open-assistant` Web Client 与 Gateway 之间的 WebSocket 协议（v0）。

> 代码定义：`open-assistant/packages/protocol/src/ws.ts`

---

## 连接

WebSocket：

- URL：`ws://<gateway-host>:7001/ws?sessionID=<id>[&token=<token>]`
- `sessionID`：由客户端生成（PoC 阶段），用于服务端会话隔离
- `token`（可选）：当 `OA_AUTH_MODE != disabled` 时必须携带，可为 OIDC JWT 或服务端静态 token；服务端支持 `token=<raw>` 或 `token=Bearer ...` 两种形式（会自动剥离 Bearer 前缀）
- 同一个 `sessionID` 会被 Gateway 绑定到 `sub/tenant/project`，后续重连必须在同一身份下才会被接受（防止 sessionID 被抢占/劫持）

---

## HTTP（与 WS 配套）

- `GET /assets/:assetId[?token=...]`：播放资源拉取（支持 `Range`）。浏览器 `<video>` 无法自定义请求 header，因此推荐使用 query `token`
- `POST /mcp`：OpenCode Server 调用的 MCP 工具入口；开启鉴权时需要提供 `Authorization: Bearer <OA_OPENCODE_MCP_TOKEN>`（或 `?token=...`）

---

## Client → Gateway

### `audio.in`

上行音频帧（16kHz/16-bit/mono PCM，base64）。

```json
{
  "v": 0,
  "type": "audio.in",
  "sessionID": "xxx",
  "seq": 0,
  "format": { "codec": "pcm_s16le", "sampleRate": 16000, "channels": 1 },
  "data": "base64..."
}
```

### `interrupt`

用户打断（barge-in）。

```json
{
  "v": 0,
  "type": "interrupt",
  "sessionID": "xxx",
  "reason": "button"
}
```

### `text.in`（Dev only）

用于 PoC 阶段绕过真实 ASR，直接触发一次“对话轮次”。

```json
{
  "v": 0,
  "type": "text.in",
  "sessionID": "xxx",
  "text": "你好"
}
```

---

## Gateway → Client

### `state`

会话状态机同步：`idle/listening/thinking/speaking/presenting`

```json
{
  "v": 0,
  "type": "state",
  "sessionID": "xxx",
  "state": "listening"
}
```

### `asr.partial` / `asr.final`

ASR 字幕与最终段落。

```json
{
  "v": 0,
  "type": "asr.final",
  "sessionID": "xxx",
  "text": "（mock ASR：segment 1）"
}
```

### `tts.text`

将要播报的文本（用于字幕/调试；未来可用于精细口型对齐）。

```json
{
  "v": 0,
  "type": "tts.text",
  "sessionID": "xxx",
  "seq": 0,
  "text": "（mock）我收到了：你好",
  "final": true
}
```

### `tts.audio`

下行音频 chunk（base64）。可选字段：

- `segmentId`：绑定 `tts.align` 的稳定标识（同一段 TTS 文本分段内的所有 chunk 共享一个 `segmentId`）
- `segmentSeq`：该 chunk 在 segment 内的序号（0-based，仅用于调试）
- `marks[]`：chunk 内的口型辅助标记（`tMs/open`），用于直接驱动 mouth-open（无须客户端做 FFT/RMS）

```json
{
  "v": 0,
  "type": "tts.audio",
  "sessionID": "xxx",
  "seq": 1,
  "segmentId": "turn-xxx:0",
  "segmentSeq": 0,
  "mime": "audio/pcm;codec=s16le",
  "sampleRate": 22050,
  "data": "base64...",
  "marks": [{ "tMs": 0, "open": 0.12 }, { "tMs": 40, "open": 0.34 }]
}
```

### `tts.align`

可选：TTS 对齐数据（用于更精确的口型：`viseme/phoneme/word` 时间戳）。

- `segmentId`：必须与对应的 `tts.audio.segmentId` 相同，用于把对齐数据绑定到该段音频
- `segments[]`：每个 segment 的 `startMs/endMs` 是相对该段 TTS 的起点（不是相对 chunk）；客户端可按实际音频时长做缩放（scale）

```json
{
  "v": 0,
  "type": "tts.align",
  "sessionID": "xxx",
  "seq": 2,
  "turnId": "turn-xxx",
  "segmentId": "turn-xxx:0",
  "segments": [{ "startMs": 0, "endMs": 70, "viseme": "PP", "phoneme": "b", "word": "不" }]
}
```

### `ui.present` / `ui.stop`

播放控制（视频/幻灯片/3D）。v0 先实现 `video` 的最小闭环：`ui.present(assetId)` -> Web 通过 Gateway 的 `/assets/:assetId` 拉取可播放资源并播放；`ui.stop(target=video)` 停止播放。

```json
{
  "v": 0,
  "type": "ui.present",
  "sessionID": "xxx",
  "assetId": "demo-video",
  "autoplay": true,
  "layout": "side-by-side",
  "startAtSeconds": 0
}
```

```json
{
  "v": 0,
  "type": "ui.stop",
  "sessionID": "xxx",
  "target": "tts"
}
```

> 注意：`ui.present` 只接受 `assetId`（禁止直传 URL）。Web 端应使用 `http://<gateway-host>:7001/assets/<assetId>` 获取资源。
