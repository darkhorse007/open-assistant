#!/usr/bin/env bash
set -Eeuo pipefail

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

BACKUP_DIR="$ROOT/infra/keycloak/backups"
mkdir -p "$BACKUP_DIR"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/keycloak-db-$ts.sql.gz"

echo "[INFO] backing up Keycloak DB to: $out"

docker compose "${COMPOSE_ARGS[@]}" up -d keycloak-db >/dev/null
docker compose "${COMPOSE_ARGS[@]}" exec -T -e PGPASSWORD="$KEYCLOAK_DB_PASSWORD" keycloak-db \
  pg_dump -h 127.0.0.1 -U keycloak --clean --if-exists --no-owner --no-privileges keycloak \
  | gzip >"$out"

echo "[INFO] done"
echo "$out"

