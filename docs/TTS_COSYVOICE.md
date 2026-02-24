# TTS 真接入：CosyVoice Runtime（FastAPI）

目标：让 `services/tts` 作为 **Open Assistant 的 TTS 适配器**，对接 CosyVoice runtime 的 FastAPI 服务，并向 Gateway 暴露统一接口：

- `POST /synthesize { sessionID?, text } -> { chunks:[{seq,mime,sampleRate,data}] }`
  - **Streaming**：若请求头包含 `Accept: application/x-ndjson`，则返回 **NDJSON 流**（每行一个 `{seq,mime,sampleRate,data}`），用于降低 *time-to-first-audio*（Gateway 默认走此模式）。
- `POST /cancel { sessionID }`

> 当前适配模式：`sft`（通过 `spk_id` 选择内置音色），输出为 `pcm_s16le`，采样率默认 `22050`。

## 1) CosyVoice 是否支持 Docker 部署？

支持。CosyVoice 官方仓库提供了 `runtime/python` 的 Docker 构建与部署方式，并给出了 gRPC / FastAPI 两种 server 入口。

## 2) 部署 CosyVoice FastAPI Server（官方方式）

下面命令摘自 CosyVoice 官方 README 的 “Build for deployment”：

```bash
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice/runtime/python
docker build -t cosyvoice:v1.0 .

# Optional (recommended): fix HyperPyYAML/ruamel.yaml incompatibility.
# If your CosyVoice container crashes with:
#   AttributeError: 'Loader' object has no attribute 'max_depth'
# rebuild a patched image tag using Open Assistant's helper Dockerfile:
cd /path/to/open-assistant
docker build -t cosyvoice:v1.0 -f infra/cosyvoice/Dockerfile.fix infra/cosyvoice

# FastAPI server (GPU)
docker run -d --runtime=nvidia -p 50000:50000 cosyvoice:v1.0 /bin/bash -lc "\
  cd /opt/CosyVoice/CosyVoice/runtime/python/fastapi && \
  python3 server.py --port 50000 --model_dir iic/CosyVoice-300M-SFT && \
  sleep infinity"
```

> 说明：
> - 本项目走的是 FastAPI 的 `/inference_sft`（需要 `spk_id`），因此推荐使用 **SFT 模型**：`iic/CosyVoice-300M-SFT`（包含 `spk2info.pt`）。
> - `--model_dir ...` 会从 ModelScope 拉模型；若你的环境是“纯内网”且无外网，需要提前离线准备模型权重（或搭建内部镜像/代理）。

## 3) 启动 Open Assistant 的 TTS 适配器

`services/tts` 默认监听 `7003`，并连接 CosyVoice FastAPI 的 `http://127.0.0.1:50000`：

```bash
cd open-assistant
OA_TTS_BACKEND=cosyvoice OA_TTS_COSYVOICE_BASE_URL=http://127.0.0.1:50000 bun run dev:tts:real
```

Gateway 侧保持使用 `OA_TTS_BASE_URL=http://127.0.0.1:7003`（默认值）即可。

## 4) 可调参数（TTS 适配器侧）

这些环境变量作用于 `services/tts`（不是 Gateway）：

- `OA_TTS_BACKEND=cosyvoice|mock`：选择后端（`mock` 仅用于本地无依赖调试）
- `OA_TTS_COSYVOICE_BASE_URL`：CosyVoice FastAPI 地址
- `OA_TTS_COSYVOICE_SPK_ID`：音色（默认 `中文女`）
- `OA_TTS_COSYVOICE_SAMPLE_RATE`：输出采样率（默认 `22050`）
- `OA_TTS_CHUNK_BYTES`：返回给 Gateway 的 chunk 大小（默认 `16000` bytes，自动对齐到 2 字节）

## 5) 可选：docker compose 叠加启动（含 TTS 适配器）

本仓库提供了一个 compose 覆盖文件：`infra/docker-compose.cosyvoice.yml`，用于把基础 `infra/docker-compose.yml` 里的 `tts` 从 `tts-mock` 覆盖为真实适配器，并额外启动 `cosyvoice`（前提是你已按上面步骤构建了 `cosyvoice:v1.0` 镜像）。

```bash
cd open-assistant
docker compose -f infra/docker-compose.yml -f infra/docker-compose.cosyvoice.yml up
```

如果你还需要同时拉起 FunASR（真 ASR），可以直接使用一体化 compose：`infra/docker-compose.full.yml`（详见 `infra/README.md`）。
