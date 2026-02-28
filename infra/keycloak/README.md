# Keycloak（OIDC）Runbook（Open Assistant）

本目录用于把“Keycloak + 多租户 claims（tenant/project/tags）”跑通，并为后续生产化（备份/恢复/升级）留出明确路径。

## 1) 启动（docker compose overlay）

本仓库提供 overlay：`infra/docker-compose.full.keycloak.yml`（Keycloak + Postgres）。

```bash
cd open-assistant
docker compose -f infra/docker-compose.full.yml -f infra/docker-compose.full.keycloak.yml up -d keycloak
```

> 若你们环境无法直接拉取 `quay.io/keycloak/keycloak`，可在 `infra/.env` 里设置 `KEYCLOAK_IMAGE` 指向内网镜像/镜像仓库。

默认会导入 realm：`openassistant`（见 `infra/keycloak/realm-openassistant.json`），并创建 demo 用户：

- 用户名/密码：`demo` / `demo`
- 属性（用于下发 claims）：`tenant=default`、`project=open-assistant`、`tags=[demo, dept-a]`

## 2) 推荐 issuer（本机浏览器 + 容器内 Gateway 同时可用）

在 Docker Desktop（Windows/macOS）里，推荐统一使用：

- `http://host.docker.internal:8080/realms/openassistant`

原因：

- 浏览器（宿主机）可以访问 `host.docker.internal`
- Gateway（容器）也可以通过 `host.docker.internal` 访问宿主机映射端口
- 这样 Web 和 Gateway 使用同一个 `issuer`，避免 `iss` 不一致导致的 JWT 校验失败

对应配置示例：

- Gateway（`infra/.env`）：
  - `OA_AUTH_MODE=oidc`
  - `OA_OIDC_ISSUER=http://host.docker.internal:8080/realms/openassistant`
- Web（`apps/web/.env`）：
  - `VITE_OA_OIDC_ISSUER=http://host.docker.internal:8080/realms/openassistant`
  - `VITE_OA_OIDC_CLIENT_ID=open-assistant-web`

## 3) claims：tenant/project/tags 如何配置

本仓库的 realm import 已在 client `open-assistant-web` 上配置 protocol mappers：

- `tenant` ← user attribute `tenant`
- `project` ← user attribute `project`
- `tags` ← user attribute `tags`（multivalued，输出 `string[]`）

你可以在 Keycloak Admin UI 里给用户（或 group）设置这些 attributes，从而让 access token 携带对应 claims。

> Gateway 侧默认 claim 名为 `tenant/project/tags`，如需改名可通过 `OA_AUTH_*_CLAIM` 环境变量映射。

## 4) 备份与恢复（建议）

生产环境建议至少保留两类备份：

1) **数据库备份**（Postgres）：
   - 优先：对 `keycloak_db_data` 做快照/备份（或对底层存储做 snapshot）
   - 或使用 `pg_dump` 定期导出
   - 本仓库提供脚本（用于 overlay 场景）：
     - 备份：`infra/keycloak/backup-db.sh`（输出到 `infra/keycloak/backups/`）
     - 恢复：`infra/keycloak/restore-db.sh <backup.sql.gz>`
2) **Realm 配置导出**（可选但推荐）：
   - 作为“可重建配置”的补充证据（realm/client/mappers 等）

> 不同 Keycloak 版本的导出方式略有差异；建议以你们的 Keycloak 版本官方文档为准，并在内网形成固定 SOP。
