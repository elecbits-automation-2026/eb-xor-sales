/**
 * The one Playwright smoke test the build spec requires: load the page,
 * click a chip, submit the contact form — proving the page, the chat client,
 * and /api/chat work together in a real browser (mock mode).
 */
import { expect, test } from "@playwright/test";

test("visitor picks a track and submits contact details", async ({ page }) => {
  await page.goto("/");

  // Greeting + the four track chips render.
  await expect(page.getByText("Namaste, I'm XOR Assist", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Design a new product" }).click();

  // Track locked → contact form appears.
  await expect(page.getByText("New product design it is", { exact: false })).toBeVisible();
  await page.getByLabel("Your name").fill("Asha Iyer");
  await page.getByLabel("Company").fill("Volt Labs");
  await page.getByLabel("Work email").fill("asha@voltlabs.in");
  await page.getByLabel("Phone / WhatsApp").fill("+91 9876501234");
  await page.getByRole("button", { name: "Save & continue" }).click();

  // The bot acknowledges and asks the first ODM question.
  await expect(page.getByText("Thanks Asha", { exact: false })).toBeVisible();
  await expect(
    page.getByText("What are you looking to build?", { exact: false }),
  ).toBeVisible();
});
