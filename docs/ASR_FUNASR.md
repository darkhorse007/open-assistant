# ASR 真接入：FunASR Runtime（WebSocket）

目标：让 `services/asr` 作为 **Open Assistant 的 ASR 适配器**，将 Gateway 的 `audio.in (pcm_s16le)` 流式转发给 FunASR Runtime，并把识别结果映射为 `asr.partial / asr.final`。

## 1) 部署 FunASR Runtime（推荐 Docker）

官方 runtime 镜像与启动方式随版本变化较快，建议以 FunASR runtime 文档为准；本项目按 FunASR 的 WebSocket 协议适配（`mode=2pass`，服务端回包 `2pass-online/2pass-offline`）。

下面示例来自 FunASR runtime 文档（以 `online-cpu` 镜像为例）：

```bash
docker pull registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13
mkdir -p ./funasr-runtime-resources/models
docker run -p 10096:10095 -it --privileged=true \
  -v $PWD/funasr-runtime-resources/models:/workspace/models \
  registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13
```

容器内启动 `2pass` 服务（关闭 SSL 建议加 `--certfile 0`，这样 `ws://` 直连更简单）：

```bash
cd FunASR/runtime
nohup bash run_server_2pass.sh \
  --download-model-dir /workspace/models \
  --vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx \
  --model-dir damo/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-onnx  \
  --online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx  \
  --punc-dir damo/punc_ct-transformer_zh-cn-common-vad_realtime-vocab272727-onnx \
  --lm-dir damo/speech_ngram_lm_zh-cn-ai-wesp-fst \
  --itn-dir thuduj12/fst_itn_zh \
  --hotword /workspace/models/hotwords.txt \
  --certfile 0 > log.txt 2>&1 &
```

> 说明：上面命令会从 ModelScope 下载模型；若你的环境是“纯内网”且无外网，需要提前把模型放到 `/workspace/models`（或搭建 ModelScope 镜像/代理）。

### 可选：用 docker compose 跑整套（含 Open Assistant ASR 适配器）

本仓库提供了一个 compose 覆盖文件：`infra/docker-compose.funasr.yml`，用于把基础 `infra/docker-compose.yml` 里的 `asr` 从 `asr-mock` 覆盖为真实适配器，并额外启动 `funasr`。

```bash
cd open-assistant
mkdir -p infra/funasr-runtime-resources/models
docker compose -f infra/docker-compose.yml -f infra/docker-compose.funasr.yml up
```

> 仍然需要模型资源（首次启动会尝试在线下载），以及 `infra/funasr-runtime-resources/models/hotwords.txt`（可为空文件）。

如果你还需要同时拉起 CosyVoice（真 TTS），可以直接使用一体化 compose：`infra/docker-compose.full.yml`（详见 `infra/README.md`）。

> 备注：FunASR runtime 的“实时语音听写”官方镜像目前以 CPU 为主；GPU 镜像主要面向“离线文件转写”。即便 ASR 服务器带 NVIDIA GPU，本方案仍可在 CPU 上稳定跑通闭环。

## 2) 启动 Open Assistant 的 ASR 适配器

`services/asr` 默认监听 `7002`，并连接 FunASR 的 `ws://127.0.0.1:10095`。如果你按上面 docker 映射到宿主 `10096`，这里就填 `10096`：

```bash
cd open-assistant
OA_ASR_BACKEND=funasr OA_ASR_FUNASR_URL=ws://127.0.0.1:10096 bun run dev:asr:real
```

Gateway 侧保持使用 `OA_ASR_WS_URL=ws://127.0.0.1:7002/asr`（默认值）即可。

## 3) 可调参数（ASR 适配器侧）

这些环境变量作用于 `services/asr`（不是 Gateway）：

- `OA_ASR_BACKEND=funasr|mock`：选择后端（`mock` 仅用于本地无依赖调试）
- `OA_ASR_FUNASR_URL`：FunASR websocket 地址
- `OA_ASR_FUNASR_MODE=2pass|online|offline`：默认 `2pass`
- `OA_ASR_FUNASR_CHUNK_SIZE`：例如 `5,10,5`
- `OA_ASR_FUNASR_CHUNK_INTERVAL`：例如 `10`
- `OA_ASR_FUNASR_ITN=true|false`：默认 `true`
- `OA_ASR_FUNASR_FINAL_TIMEOUT_MS`：等待离线二遍修正的超时（默认 `12000`）
- `OA_ASR_VAD_THRESHOLD` / `OA_ASR_ENDPOINT_HANGOVER_MS`：适配器侧简单 RMS-VAD 的起止阈值与尾音 hangover

## 4) 协议备注

适配器会：

- 建连后先发送 init JSON：`mode / wav_name / is_speaking / wav_format=pcm / audio_fs / chunk_size / chunk_interval / itn`
- 之后持续发送二进制 PCM16LE 数据
- 段落结束发送：`{ "is_speaking": false }`
- 将 `2pass-online` 映射为 `asr.partial`，`2pass-offline + is_final=true` 映射为 `asr.final`
