import { expect, test } from "@playwright/test"
import { seed } from "../utils/app"
import { setupTimeline } from "../utils/timeline"

test("the Motion panel stays open until closed on purpose, across a reload", async ({ page }) => {
  await seed(page, {
    storage: { "opencode.global.dat:extension.debug.bar": { visible: true, motion: true, type: false } },
  })

  await setupTimeline(page, { seedHistory: true })
  const panel = page.locator(".knobs-panel")
  const scroll = page.locator('[data-slot="session-timeline-scroll"]')
  await expect(panel).toBeVisible()

  await scroll.click({ position: { x: 40, y: 40 } })
  await page.mouse.wheel(0, -300)
  await page.keyboard.press("Meta+P")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(panel).toBeVisible()

  await page.reload()
  await expect(panel).toBeVisible()

  await panel.getByRole("button", { name: "Close opencode-motion" }).click()
  await expect(panel).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("button", { name: /MOTION/ })).toBeVisible()
  await expect(panel).toHaveCount(0)

  await page.getByRole("button", { name: /MOTION/ }).click()
  await expect(panel).toBeVisible()
  await panel.getByRole("button", { name: "Random", exact: true }).focus()
  await page.keyboard.press("Escape")
  await expect(panel).toHaveCount(0)
})
