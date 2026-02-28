import { test, expect } from "@playwright/test"

test("Auth: WS rejects missing token (static mode)", async ({ page }) => {
  const mode = (process.env.OA_E2E_AUTH_MODE ?? "disabled").trim()
  const token = (process.env.OA_E2E_AUTH_TOKEN ?? "").trim()

  if (token) {
    await page.addInitScript((t) => sessionStorage.setItem("oa_token", t), token)
  }

  await page.goto("/")

  await expect(page.getByTestId("ws-status")).toHaveText("connected")

  if (mode !== "static") return

  await page.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(page.getByTestId("ws-status")).toHaveText("disconnected")

  const tokenInput = page.getByTestId("auth-token")
  await tokenInput.fill("")
  await page.getByRole("button", { name: "Connect", exact: true }).click()

  await expect(page.getByTestId("ws-error")).toBeVisible()
  await page.getByRole("button", { name: "Disconnect", exact: true }).click()

  if (!token) throw new Error("OA_E2E_AUTH_TOKEN is required when OA_E2E_AUTH_MODE=static")
  await tokenInput.fill(token)
  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByTestId("ws-status")).toHaveText("connected")
})

test("Auth: /mcp requires OA_OPENCODE_MCP_TOKEN", async ({ request }) => {
  const gw = (process.env.OA_E2E_GATEWAY_BASE_URL ?? "http://127.0.0.1:7001").replace(/\/+$/, "")
  const token = (process.env.OA_E2E_MCP_TOKEN ?? "").trim()
  if (!token) test.skip(true, "OA_E2E_MCP_TOKEN not set")

  const noToken = await request.get(`${gw}/mcp`)
  expect(noToken.status()).toBe(401)

  const okToken = await request.get(`${gw}/mcp?token=${encodeURIComponent(token)}`)
  expect(okToken.status()).toBe(400)
})

