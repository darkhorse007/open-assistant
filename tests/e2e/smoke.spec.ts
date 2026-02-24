import { test, expect } from "@playwright/test"

test("Open Assistant smoke: present video/slides/model", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByText("Open Assistant")).toBeVisible()
  await expect(page.getByText(/Status:\s+connected/)).toBeVisible()

  await page.getByRole("button", { name: "Play demo-video" }).click()
  await expect(page.getByText(/Now playing:\s+demo-video/)).toBeVisible()
  await expect(page.locator("video")).toBeVisible()

  await page.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(page.getByText(/Status:\s+disconnected/)).toBeVisible()
  await expect(page.getByText(/Now playing:\s+\(none\)/)).toBeVisible()

  await page.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByText(/Status:\s+connected/)).toBeVisible()

  await page.getByRole("button", { name: "Present demo-slides" }).click()
  await expect(page.getByText(/Now playing:\s+demo-slides/)).toBeVisible()
  await expect(page.getByTestId("slides-frame")).toBeVisible()

  await page.getByRole("button", { name: "Present demo-model" }).click()
  await expect(page.getByText(/Now playing:\s+demo-model/)).toBeVisible()
  await expect(page.getByTestId("model-frame")).toBeVisible()

  const modelFrame = page.frameLocator('[data-testid="model-frame"]')
  await expect(modelFrame.getByTestId("lipsync-overlay")).toBeVisible()
  await expect(modelFrame.getByTestId("lipsync-overlay")).toContainText("meshes=1")
  await expect(modelFrame.getByTestId("lipsync-overlay")).toContainText("jawOpen=yes")

  await page.evaluate(() => {
    const iframe = document.querySelector('iframe[data-testid="model-frame"]') as HTMLIFrameElement | null
    iframe?.contentWindow?.postMessage({ type: "oa.lipsync", open: 0.8, viseme: "aa", phoneme: "a", word: "啊" }, "*")
  })
  await expect(modelFrame.getByTestId("lipsync-overlay")).toContainText("viseme=aa")

  await page.getByRole("button", { name: "Stop video" }).click()
  await expect(page.getByText(/Now playing:\s+\(none\)/)).toBeVisible()
})
