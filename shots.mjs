// Temporary screenshot driver — deleted after use.
import { readFileSync } from "fs";

import { chromium } from "@playwright/test";

const SCRATCH =
  "/tmp/claude-0/-home-user-eb-xor-sales/055d3006-060e-59c0-9a0f-f1f6760fe33e/scratchpad";
const token = readFileSync(`${SCRATCH}/demo-token.txt`, "utf8").trim();
const user = JSON.stringify({ email: "meera@boltdevices.in", name: "Meera Shah" });
const emptyToken = readFileSync(`${SCRATCH}/empty-token.txt`, "utf8").trim();
const emptyUser = JSON.stringify({ email: "new@example.in", name: "New User" });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  headless: true,
  args: ["--no-sandbox", "--hide-scrollbars"],
});

async function shot({
  url,
  file,
  dark = false,
  signedIn = false,
  waitFor,
  actions,
  viewport = { width: 1440, height: 900 },
  auth = [token, user],
}) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(
    ([dark, signedIn, token, user]) => {
      try {
        if (dark) localStorage.setItem("xor_theme", "dark");
        if (signedIn) {
          localStorage.setItem("xor_demo_token", token);
          localStorage.setItem("xor_demo_user", user);
        }
      } catch {}
    },
    [dark, signedIn, ...auth],
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 });
  if (actions) await actions(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SCRATCH}/${file}` });
  await context.close();
  console.log("captured", file);
}

const base = "http://localhost:3000";

// logged-out /account (Claude-style login)
await shot({ url: `${base}/account`, file: "acct2-login.png", waitFor: ".lg-card" });
await shot({ url: `${base}/account`, file: "acct2-login-dark.png", dark: true, waitFor: ".lg-card" });

// signed-in /account (projects shell)
await shot({ url: `${base}/account`, file: "acct2-projects.png", signedIn: true, waitFor: ".pv-head" });
await shot({ url: `${base}/account`, file: "acct2-projects-dark.png", signedIn: true, dark: true, waitFor: ".pv-head" });

// "/" app shell, signed out (visitor default)
await shot({ url: `${base}/`, file: "shell-home.png", waitFor: ".msg.bot" });
await shot({ url: `${base}/`, file: "shell-home-dark.png", dark: true, waitFor: ".msg.bot" });

// review extras (not deliverables): signed-in home, signup mode, google demo notice
await shot({ url: `${base}/`, file: "x-home-signedin.png", signedIn: true, waitFor: ".app-row" });
await shot({
  url: `${base}/account`,
  file: "x-login-signup.png",
  waitFor: ".lg-card",
  actions: async (page) => {
    await page.getByRole("button", { name: "Create an account" }).click();
  },
});
await shot({
  url: `${base}/account`,
  file: "x-login-gnotice.png",
  waitFor: ".lg-card",
  actions: async (page) => {
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForSelector(".lg-note");
  },
});

// review extras: empty projects state + mobile viewports
const mobile = { width: 390, height: 844 };
await shot({
  url: `${base}/account`,
  file: "x-acct-empty.png",
  signedIn: true,
  auth: [emptyToken, emptyUser],
  waitFor: ".pv-empty",
});
await shot({ url: `${base}/account`, file: "x-m-login.png", viewport: mobile, waitFor: ".lg-card" });
await shot({
  url: `${base}/account`,
  file: "x-m-projects.png",
  viewport: mobile,
  signedIn: true,
  waitFor: ".pv-head",
});
await shot({ url: `${base}/`, file: "x-m-home.png", viewport: mobile, waitFor: ".msg.bot" });

await browser.close();
