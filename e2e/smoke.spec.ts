/**
 * The one Playwright smoke test the build spec requires, as one coherent
 * journey through the login-first app: land on "/", see the Claude-style
 * login (Google button present), create a demo account, then drive the chat
 * — click a chip, submit the contact form — proving the gate, the chat
 * client, and /api/chat work together in a real browser (mock mode).
 */
import { expect, test } from "@playwright/test";

test("visitor signs up, picks a track and submits contact details", async ({ page }) => {
  await page.goto("/");

  // The app is login-first: the login view is the front door.
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await page.getByRole("button", { name: "Create an account" }).click();

  // Unique per run — the dev server's in-memory auth outlives test runs.
  const stamp = Date.now();
  await page.getByLabel("Your name").fill("Asha Iyer");
  await page.getByLabel("Work email").fill(`asha+${stamp}@voltlabs.in`);
  await page.getByLabel("Password").fill("hunter2hunter2");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // Greeting + the four track chips render.
  await expect(page.getByText("I'm XoR from Elecbits", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Design a new product" }).click();

  // Track locked → contact form appears.
  await expect(page.getByText("New product design it is", { exact: false })).toBeVisible();
  await page.getByLabel("Your name").fill("Asha Iyer");
  await page.getByLabel("Company").fill("Volt Labs");
  await page.getByLabel("Work email").fill(`asha+${stamp}@voltlabs.in`);
  await page.getByLabel("Phone / WhatsApp").fill("+91 9876501234");
  await page.getByRole("button", { name: "Save & continue" }).click();

  // New client → the two company questions (sector + org size).
  await expect(page.getByText("Which sector fits", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "IoT & Connected Devices", exact: true }).click();
  await expect(page.getByText("organisation size", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Proto-Level Startup/ }).click();

  // The bot acknowledges and asks the first ODM question.
  await expect(page.getByText("Thanks Asha", { exact: false })).toBeVisible();
  await expect(
    page.getByText("What are you looking to build?", { exact: false }),
  ).toBeVisible();
});
