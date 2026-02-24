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
Ubuntu dependency installer/checker for Open Assistant deploy.

Usage:
  ./infra/scripts/deploy-ubuntu.install.sh [check|install|all]

Actions:
  check   Only validate docker/nvidia prerequisites (default)
  install Install docker (+ nvidia-container-toolkit if GPU enabled)
  all     install + check

Environment overrides:
  OA_INSTALL_WITH_GPU=1|0                    # default: 1
  OA_INSTALL_SKIP_APT_UPDATE=1|0             # default: 0
  OA_INSTALL_SKIP_DOCKER_GPU_TEST=1|0        # default: 0
  OA_DEPLOY_CUDA_TEST_IMAGE=nvidia/cuda:12.3.2-runtime-ubuntu22.04

Examples:
  ./infra/scripts/deploy-ubuntu.install.sh check
  OA_INSTALL_WITH_GPU=1 ./infra/scripts/deploy-ubuntu.install.sh all
USAGE
}

ACTION="${1:-check}"
[[ "$ACTION" == "-h" || "$ACTION" == "--help" ]] && usage && exit 0
[[ "$ACTION" == "check" || "$ACTION" == "install" || "$ACTION" == "all" ]] || die "unsupported action: $ACTION"

WITH_GPU="${OA_INSTALL_WITH_GPU:-1}"
SKIP_APT_UPDATE="${OA_INSTALL_SKIP_APT_UPDATE:-0}"
SKIP_DOCKER_GPU_TEST="${OA_INSTALL_SKIP_DOCKER_GPU_TEST:-0}"
CUDA_TEST_IMAGE="${OA_DEPLOY_CUDA_TEST_IMAGE:-nvidia/cuda:12.3.2-runtime-ubuntu22.04}"

[[ "$WITH_GPU" == "0" || "$WITH_GPU" == "1" ]] || die "OA_INSTALL_WITH_GPU must be 0|1"
[[ "$SKIP_APT_UPDATE" == "0" || "$SKIP_APT_UPDATE" == "1" ]] || die "OA_INSTALL_SKIP_APT_UPDATE must be 0|1"
[[ "$SKIP_DOCKER_GPU_TEST" == "0" || "$SKIP_DOCKER_GPU_TEST" == "1" ]] || die "OA_INSTALL_SKIP_DOCKER_GPU_TEST must be 0|1"

ensure_ubuntu() {
  [[ -f /etc/os-release ]] || die "missing /etc/os-release"
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || die "this installer is for Ubuntu only (detected: ${ID:-unknown})"
}

SUDO=""
ensure_sudo() {
  if [[ "$EUID" -ne 0 ]]; then
    need_cmd sudo
    SUDO="sudo"
  fi
}

APT_UPDATED=0
apt_update_once() {
  [[ "$SKIP_APT_UPDATE" == "1" ]] && return 0
  [[ "$APT_UPDATED" == "1" ]] && return 0
  $SUDO apt-get update
  APT_UPDATED=1
}

install_common_packages() {
  apt_update_once
  $SUDO apt-get install -y ca-certificates curl gnupg lsb-release
}

install_docker() {
  log "installing docker engine + compose plugin..."
  install_common_packages
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO tee /etc/apt/keyrings/docker.asc >/dev/null
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  fi

  local arch codename
  arch="$(dpkg --print-architecture)"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  echo \
    "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null

  APT_UPDATED=0
  apt_update_once
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  $SUDO systemctl enable --now docker

  if [[ -n "${SUDO_USER:-}" ]]; then
    if id -nG "$SUDO_USER" | grep -qw docker; then
      log "user '$SUDO_USER' already in docker group"
    else
      $SUDO usermod -aG docker "$SUDO_USER"
      warn "added '$SUDO_USER' to docker group; relogin or run: newgrp docker"
    fi
  fi
}

install_nvidia_toolkit() {
  [[ "$WITH_GPU" == "1" ]] || return 0
  log "installing nvidia-container-toolkit..."
  install_common_packages
  $SUDO install -m 0755 -d /usr/share/keyrings

  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null

  APT_UPDATED=0
  apt_update_once
  $SUDO apt-get install -y nvidia-container-toolkit
  $SUDO nvidia-ctk runtime configure --runtime=docker
  $SUDO systemctl restart docker
}

check_docker() {
  need_cmd docker
  docker info >/dev/null 2>&1 || die "docker daemon not available"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin unavailable"
  log "docker + compose OK"
}

check_gpu() {
  [[ "$WITH_GPU" == "1" ]] || return 0
  need_cmd nvidia-smi
  nvidia-smi >/dev/null 2>&1 || die "host GPU is not ready (nvidia-smi failed)"
  if [[ "$SKIP_DOCKER_GPU_TEST" != "1" ]]; then
    log "checking docker GPU runtime..."
    docker run --rm --gpus all "$CUDA_TEST_IMAGE" nvidia-smi >/dev/null 2>&1 || die "docker cannot access NVIDIA GPU"
  fi
  log "nvidia runtime OK"
}

do_install() {
  ensure_ubuntu
  ensure_sudo
  install_docker
  install_nvidia_toolkit
}

do_check() {
  check_docker
  check_gpu
  log "all prerequisite checks passed"
}

case "$ACTION" in
  check)
    do_check
    ;;
  install)
    do_install
    ;;
  all)
    do_install
    do_check
    ;;
esac

if [[ "$WITH_GPU" == "1" ]]; then
  echo "Next: OA_DEPLOY_MODE=real OA_DEPLOY_USE_GPU=1 ./infra/scripts/deploy-ubuntu.sh up"
else
  echo "Next: OA_DEPLOY_MODE=mock OA_DEPLOY_USE_GPU=0 ./infra/scripts/deploy-ubuntu.sh up"
fi
