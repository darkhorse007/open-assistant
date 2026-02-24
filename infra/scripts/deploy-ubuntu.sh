#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  echo "[INFO] $*"
}

warn() {
  echo "[WARN] $*" >&2
}

die() {
  echo "[ERROR] $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

usage() {
  cat <<'USAGE'
Ubuntu deploy helper for Open Assistant (docker compose).

Usage:
  ./infra/scripts/deploy-ubuntu.sh [up|down|restart|status|logs]

Environment overrides:
  OA_ROOT=/opt/open-assistant                 # repo root (default: inferred)
  OA_DEPLOY_MODE=mock|real                    # default: mock
  OA_DEPLOY_COMPOSE_MODE=prod|dev             # default: prod
  OA_DEPLOY_USE_GPU=1|0                       # default: 1
  OA_DEPLOY_BUILD=1|0                         # default: 1 (only for prod)
  OA_DEPLOY_LLM_MODE=mock|opencode            # default: mock
  OA_DEPLOY_READY_URL=http://127.0.0.1:7001/readyz
  OA_DEPLOY_READY_TIMEOUT_SEC=1200
  OA_DEPLOY_SKIP_DOCKER_GPU_TEST=1            # optional
  OA_DEPLOY_SKIP_COSYVOICE_IMAGE_CHECK=1      # optional
  OA_DEPLOY_CUDA_TEST_IMAGE=nvidia/cuda:12.3.2-runtime-ubuntu22.04

Examples:
  OA_DEPLOY_MODE=mock OA_DEPLOY_USE_GPU=0 ./infra/scripts/deploy-ubuntu.sh up
  OA_DEPLOY_MODE=real OA_DEPLOY_USE_GPU=1 OA_DEPLOY_BUILD=1 ./infra/scripts/deploy-ubuntu.sh up
  ./infra/scripts/deploy-ubuntu.sh logs
USAGE
}

ACTION="${1:-up}"
if [[ "$ACTION" == "-h" || "$ACTION" == "--help" ]]; then
  usage
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OA_ROOT="${OA_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
INFRA_DIR="$OA_ROOT/infra"

MODE="${OA_DEPLOY_MODE:-mock}"
COMPOSE_MODE="${OA_DEPLOY_COMPOSE_MODE:-prod}"
USE_GPU="${OA_DEPLOY_USE_GPU:-1}"
BUILD_IMAGES="${OA_DEPLOY_BUILD:-1}"
LLM_MODE="${OA_DEPLOY_LLM_MODE:-mock}"
READY_URL="${OA_DEPLOY_READY_URL:-http://127.0.0.1:7001/readyz}"
READY_TIMEOUT_SEC="${OA_DEPLOY_READY_TIMEOUT_SEC:-1200}"
SKIP_DOCKER_GPU_TEST="${OA_DEPLOY_SKIP_DOCKER_GPU_TEST:-0}"
SKIP_COSYVOICE_IMAGE_CHECK="${OA_DEPLOY_SKIP_COSYVOICE_IMAGE_CHECK:-0}"
CUDA_TEST_IMAGE="${OA_DEPLOY_CUDA_TEST_IMAGE:-nvidia/cuda:12.3.2-runtime-ubuntu22.04}"

[[ -d "$OA_ROOT" ]] || die "OA_ROOT not found: $OA_ROOT"
[[ -f "$INFRA_DIR/docker-compose.full.yml" ]] || die "not an open-assistant repo root: $OA_ROOT"
[[ "$MODE" == "mock" || "$MODE" == "real" ]] || die "OA_DEPLOY_MODE must be mock|real"
[[ "$COMPOSE_MODE" == "prod" || "$COMPOSE_MODE" == "dev" ]] || die "OA_DEPLOY_COMPOSE_MODE must be prod|dev"
[[ "$USE_GPU" == "0" || "$USE_GPU" == "1" ]] || die "OA_DEPLOY_USE_GPU must be 0|1"

need_cmd docker
need_cmd curl
docker info >/dev/null 2>&1 || die "docker daemon is not available"
docker compose version >/dev/null 2>&1 || die "docker compose plugin is not available"

if [[ "$USE_GPU" == "1" ]]; then
  need_cmd nvidia-smi
  nvidia-smi >/dev/null 2>&1 || die "host GPU not ready (nvidia-smi failed)"
  if [[ "$SKIP_DOCKER_GPU_TEST" != "1" ]]; then
    log "checking docker GPU runtime..."
    docker run --rm --gpus all "$CUDA_TEST_IMAGE" nvidia-smi >/dev/null 2>&1 || die "docker cannot access NVIDIA GPU"
  fi
fi

if [[ ! -f "$INFRA_DIR/.env" ]]; then
  [[ -f "$INFRA_DIR/.env.example" ]] || die "missing $INFRA_DIR/.env.example"
  cp "$INFRA_DIR/.env.example" "$INFRA_DIR/.env"
  log "created infra/.env from infra/.env.example"
fi

mkdir -p "$INFRA_DIR/funasr-runtime-resources/models"

set -a
# shellcheck disable=SC1090
source "$INFRA_DIR/.env"
set +a

if [[ "$MODE" == "real" && "$SKIP_COSYVOICE_IMAGE_CHECK" != "1" ]]; then
  COSYVOICE_IMAGE="${COSYVOICE_IMAGE:-cosyvoice:v1.0}"
  docker image inspect "$COSYVOICE_IMAGE" >/dev/null 2>&1 || die "missing CosyVoice image: $COSYVOICE_IMAGE"
fi

compose_files=("$INFRA_DIR/docker-compose.full.yml")
[[ "$COMPOSE_MODE" == "prod" ]] && compose_files+=("$INFRA_DIR/docker-compose.prod.yml")
[[ "$USE_GPU" == "1" ]] && compose_files+=("$INFRA_DIR/docker-compose.gpu.yml")
[[ "$MODE" == "mock" ]] && compose_files+=("$INFRA_DIR/docker-compose.full.mock-backends.yml")

compose_args=()
for f in "${compose_files[@]}"; do
  [[ -f "$f" ]] || die "missing compose file: $f"
  compose_args+=("-f" "$f")
done

run_compose() {
  (cd "$OA_ROOT" && docker compose "${compose_args[@]}" "$@")
}

wait_ready() {
  local deadline now body
  deadline=$((SECONDS + READY_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    body="$(curl -fsS --max-time 5 "$READY_URL" || true)"
    if [[ -n "$body" ]]; then
      if [[ "$body" == *'"ok":true'* ]]; then
        return 0
      fi
      if command -v jq >/dev/null 2>&1; then
        local checks
        checks="$(jq -r '
          (.checks // {}) | to_entries |
          map("\(.key)=\(.value.ok // false)\(
            if (.value.detail // "") == "" then "" else ":" + (.value.detail|tostring) end
          )") | join(" | ")
        ' <<<"$body" 2>/dev/null || true)"
        [[ -n "$checks" ]] && log "readyz pending: $checks"
      fi
    else
      log "waiting for readyz..."
    fi
    sleep 2
  done
  return 1
}

export OA_LLM_MODE="$LLM_MODE"
if [[ "$LLM_MODE" == "mock" ]]; then
  export OA_OPENCODE_EVENTS_MODE=disabled
fi

case "$ACTION" in
  down)
    log "docker compose down"
    run_compose down
    ;;
  status)
    run_compose ps
    ;;
  logs)
    run_compose logs -f gateway asr tts
    ;;
  restart)
    log "docker compose restart"
    run_compose restart
    ;;
  up)
    log "compose files: ${compose_files[*]}"
    run_compose config >/dev/null
    if [[ "$BUILD_IMAGES" == "1" && "$COMPOSE_MODE" == "prod" ]]; then
      log "building production images..."
      run_compose build
    else
      log "skip build (OA_DEPLOY_BUILD=$BUILD_IMAGES, OA_DEPLOY_COMPOSE_MODE=$COMPOSE_MODE)"
    fi
    log "starting services..."
    run_compose up -d
    log "waiting readyz: $READY_URL (timeout=${READY_TIMEOUT_SEC}s)"
    if wait_ready; then
      log "readyz OK"
      echo "Web:      https://<host>:7443"
      echo "Gateway:  http://<host>:7001/readyz"
      echo "Grafana:  http://<host>:3000"
    else
      warn "readyz timeout"
      warn "check logs: docker compose ${compose_args[*]} logs -f gateway asr tts funasr cosyvoice"
      exit 2
    fi
    ;;
  *)
    usage
    die "unsupported action: $ACTION"
    ;;
esac

