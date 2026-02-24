import { test, expect, type Locator } from "@playwright/test"

async function readNumber(locator: Locator) {
  const raw = await locator.innerText()
  return Number.parseFloat(raw.trim())
}

async function readText(locator: Locator) {
  const raw = await locator.innerText()
  return raw.trim()
}

test("Open Assistant: speak -> interrupt -> speak again", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByTestId("ws-status")).toHaveText("connected")

  const devInput = page.getByTestId("dev-input")
  const sendBtn = page.getByTestId("btn-send")
  const interruptBtn = page.getByTestId("btn-interrupt")
  const userSubtitle = page.getByTestId("user-subtitle")
  const assistantSubtitle = page.getByTestId("assistant-subtitle")
  const mouthOpen = page.getByTestId("mouth-open")
  const mouthViseme = page.getByTestId("mouth-viseme")
  const lipsyncMode = page.getByTestId("lipsync-mode")

  const first = `e2e-first: ${"hello ".repeat(40).trim()}`
  await devInput.fill(first)
  await sendBtn.click()

  await expect(userSubtitle).toContainText(first)
  await expect(assistantSubtitle).toContainText(first)

  await expect
    .poll(() => readNumber(mouthOpen), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(0.1)

  await expect
    .poll(() => readText(lipsyncMode), { timeout: 15_000 })
    .toBe("align")

  await expect
    .poll(() => readText(mouthViseme), { timeout: 15_000 })
    .not.toBe("sil")

  await interruptBtn.click()

  await expect
    .poll(() => readNumber(mouthOpen), { timeout: 5_000 })
    .toBeLessThanOrEqual(0.01)

  await expect
    .poll(() => readText(lipsyncMode), { timeout: 5_000 })
    .toBe("none")

  await expect
    .poll(() => readText(mouthViseme), { timeout: 5_000 })
    .toBe("sil")

  const second = `e2e-second: ${"world ".repeat(30).trim()}`
  await devInput.fill(second)
  await sendBtn.click()

  await expect(userSubtitle).toContainText(second)
  await expect(assistantSubtitle).toContainText(second)

  await expect
    .poll(() => readNumber(mouthOpen), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(0.1)

  await expect
    .poll(() => readText(lipsyncMode), { timeout: 15_000 })
    .toBe("align")

  await expect
    .poll(() => readText(mouthViseme), { timeout: 15_000 })
    .not.toBe("sil")
})
