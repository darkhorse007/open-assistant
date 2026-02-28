# `/mcp` 与 OIDC 安全运维手册（RC3）

目标：把 `/mcp` 从“功能可用”提升到“可轮换、可隔离、可审计”的生产运维状态。

## 1) 基线要求

- `OA_AUTH_MODE != disabled` 时，必须配置 `OA_OPENCODE_MCP_TOKEN`。
- Gateway 只接受服务间 token 调用 `/mcp`，不依赖用户 OIDC token。
- 推荐启用 `OA_AUTH_TAGS_MODE=enforce` 与 `OA_OIDC_REQUIRE_TAGS=true`，避免跨租户标签越权。

## 2) 网络隔离（最小暴露面）

建议同时做两层：

1. L4/L3（安全组/防火墙）  
   仅允许 OpenCode 所在网段访问 Gateway 的 `/mcp` 入口端口。

2. 反向代理/L7  
   对 `/mcp` 加来源 IP allowlist（或仅内网入口暴露）。

示例策略（概念）：

- 外网用户只能访问 Web 与 `/ws`（带用户 token）
- `/mcp` 仅允许内网 OpenCode 来源访问

## 3) token 生成与存储

建议 token 长度 >= 32 字节、随机且不可复用：

```bash
bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'))"
```

存储建议：

- 只放在密钥系统（Vault/KMS/CI Secret），不要入库到 git。
- OpenCode 与 Gateway 分别最小权限读取。
- 记录 token 版本号与生效时间（不记录明文）。

## 4) 零停机轮换流程（双 token 窗口）

Gateway 支持：

- `OA_OPENCODE_MCP_TOKEN`：当前 token（必填）
- `OA_OPENCODE_MCP_TOKEN_PREVIOUS`：旧 token（可选，轮换窗口使用）

步骤：

1. 生成新 token（`new`），保留当前 token（`old`）。
2. 先部署 Gateway：
   - `OA_OPENCODE_MCP_TOKEN=new`
   - `OA_OPENCODE_MCP_TOKEN_PREVIOUS=old`
3. 再发布 OpenCode：改为使用 `new`。
4. 观察一段窗口期（建议 15-60 分钟）确认无旧 token 请求。
5. 再次部署 Gateway：清空 `OA_OPENCODE_MCP_TOKEN_PREVIOUS`。

## 5) 验证命令（发布前/后）

以下命令基于 Gateway `http://127.0.0.1:7001`：

```bash
# 未带 token：应为 401
curl -i http://127.0.0.1:7001/mcp

# 带 token 但未 initialize：应为 400（表示鉴权已通过）
curl -i "http://127.0.0.1:7001/mcp?token=<token>"
```

轮换窗口期应验证：

- `old` 与 `new` 都可通过鉴权（返回 400）
- 窗口结束后 `old` 必须回到 401

## 6) 事件响应建议

若怀疑 `/mcp` token 泄露：

1. 立刻生成 `new`，按“零停机轮换流程”执行。
2. 缩短窗口期，尽快移除 `previous`。
3. 检查审计与访问日志中的异常来源 IP/调用频率。
4. 回溯密钥分发链路并补齐泄露点修复。
