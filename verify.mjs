// Temporary functional check — deleted after use.
import { readFileSync } from "fs";

import { chromium } from "@playwright/test";

const SCRATCH =
  "/tmp/claude-0/-home-user-eb-xor-sales/055d3006-060e-59c0-9a0f-f1f6760fe33e/scratchpad";
const token = readFileSync(`${SCRATCH}/demo-token.txt`, "utf8").trim();
const user = JSON.stringify({ email: "meera@boltdevices.in", name: "Meera Shah" });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(
  ([t, u]) => {
    localStorage.setItem("xor_demo_token", t);
    localStorage.setItem("xor_demo_user", u);
  },
  [token, user],
);
const page = await context.newPage();

// 1. home sidebar row → /account?deal=… → detail selected
await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
await page.waitForSelector(".app-row");
await page.click(".app-row");
await page.waitForURL(/\/account\?deal=/);
await page.waitForSelector(".pv-head h1");
const h1 = await page.textContent(".pv-head h1");
const sel = await page.textContent(".app-row.sel .app-row-id");
console.log("deal param URL:", page.url());
console.log("detail h1:", h1, "| sidebar selected:", sel);
if (h1 !== "EB-D-26-0001-01" || sel !== "EB-D-26-0001-01") throw new Error("?deal= selection failed");

// 2. "+ New enquiry" from /account → lands on "/", session cleared
await page.click(".app-new");
await page.waitForURL("http://localhost:3000/");
await page.waitForSelector(".msg.bot");
const sess1 = await page.evaluate(() => sessionStorage.getItem("xor_session_id"));
console.log("fresh session after + New enquiry:", Boolean(sess1));

// 3. ?new=1 resets the stored session and strips the param
await page.goto("http://localhost:3000/?new=1", { waitUntil: "networkidle" });
await page.waitForSelector(".msg.bot");
const sess2 = await page.evaluate(() => sessionStorage.getItem("xor_session_id"));
console.log("url after ?new=1:", page.url(), "| new session:", sess2 !== sess1 && Boolean(sess2));

// 4. sign out from the /account sidebar drops to the login screen
await page.goto("http://localhost:3000/account", { waitUntil: "networkidle" });
await page.waitForSelector(".app-foot .app-ghost");
await page.click(".app-foot .app-ghost");
await page.waitForSelector(".lg-card");
console.log("sign out → login card visible: true");

await browser.close();
console.log("VERIFY_OK");
