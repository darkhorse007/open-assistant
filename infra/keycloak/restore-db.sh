#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.sql.gz>" >&2
  exit 2
fi

BACKUP_FILE="$1"
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[ERROR] backup file not found: $BACKUP_FILE" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE="$ROOT/infra/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

KEYCLOAK_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD:-keycloak}"

COMPOSE_ARGS=(
  -f "$ROOT/infra/docker-compose.full.yml"
  -f "$ROOT/infra/docker-compose.full.keycloak.yml"
)

echo "[WARN] restoring Keycloak DB from: $BACKUP_FILE"
echo "[WARN] this will overwrite existing objects in the keycloak database"

docker compose "${COMPOSE_ARGS[@]}" up -d keycloak-db >/dev/null
docker compose "${COMPOSE_ARGS[@]}" stop keycloak >/dev/null 2>&1 || true

gzip -dc "$BACKUP_FILE" | docker compose "${COMPOSE_ARGS[@]}" exec -T -e PGPASSWORD="$KEYCLOAK_DB_PASSWORD" keycloak-db \
  psql -h 127.0.0.1 -U keycloak -d keycloak -v ON_ERROR_STOP=1

docker compose "${COMPOSE_ARGS[@]}" start keycloak >/dev/null 2>&1 || true

echo "[INFO] done"

