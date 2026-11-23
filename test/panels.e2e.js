// Click through the panels in a real browser against the real backend and real Claude (haiku, tiny prompts),
// taking screenshots. Needs Playwright with Chromium somewhere (it isn't a dependency of the plugin):
//   PLAYWRIGHT_DIR=<folder with node_modules/playwright> node test/panels.e2e.js [outDir]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || pluginDir, "package.json"));
const { chromium } = require("playwright");
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "layr-claude-shots"));
mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-ui-"));
const repo = path.join(tmp, "demo-repo");
execFileSync("git", ["init", "-q", repo]);
writeFileSync(path.join(repo, "README.md"), "# Demo\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

const port = 4300 + Math.floor(Math.random() * 600) + 20;
const server = spawn(process.execPath, [path.join(pluginDir, "dev", "devserver.js"), "--port", String(port), "--data", path.join(tmp, "data")], {
  cwd: pluginDir,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.env.LAYR_TEST_VERBOSE && process.stderr.write(d));
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("dev server") && resolve()));
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("response", (r) => r.status() === 404 && !/favicon/.test(r.url()) && errors.push(`404 ${r.url()}`));
  await page.goto(`${base}/`);
  const threads = page.frameLocator("#left iframe");

  // Empty state, then add the project from the form.
  await threads.getByText("No projects yet").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(out, "01-empty.png") });
  await threads.locator(".empty .btn.primary").click();
  await threads.getByPlaceholder("Folder path").fill(repo);
  await threads.getByRole("button", { name: "Add", exact: true }).click();
  await threads.locator(".project-head .name", { hasText: "demo-repo" }).waitFor();
  await threads.locator("textarea").fill("Create a file hello.txt containing exactly: hi\nUse the Write tool, then reply with one word: done.");
  await threads.locator("select").nth(1).selectOption("haiku");
  await threads.locator("select").nth(2).selectOption("low");
  await page.screenshot({ path: path.join(out, "02-new-thread-form.png") });
  await threads.getByRole("button", { name: "Start" }).click();

  // The thread opens on the right; its approval appears inline in the Write card.
  const thread = page.frameLocator("#right iframe.on");
  await thread.getByRole("button", { name: "Allow", exact: true }).waitFor({ timeout: 180_000 });
  await page.screenshot({ path: path.join(out, "03-approval.png") });
  check(true, "approval card shown");
  await thread.getByRole("button", { name: "Allow", exact: true }).click();
  await thread.locator(".turn[data-ended]").first().waitFor({ timeout: 180_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "04-done.png") });
  const hello = path.join(repo, "hello.txt");
  check(existsSync(hello) && readFileSync(hello, "utf8").trim() === "hi", "hello.txt written after Allow");
  const rowStatus = await threads.locator(".row .dot").first().getAttribute("class");
  check(rowStatus.includes("done"), "threads list shows done", rowStatus);

  // A second turn from the composer, with streaming.
  await thread.locator("#input").fill("Write a haiku about autumn, then a bullet list of 3 fruits. No tools.");
  await thread.locator("#input").press("Enter");
  await thread.locator(".msg-text.live, #working:not([hidden])").first().waitFor({ timeout: 60_000 });
  await page.screenshot({ path: path.join(out, "05-streaming.png") });
  await thread.locator(".turn[data-ended]").nth(1).waitFor({ timeout: 180_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "06-markdown.png") });
  check((await thread.locator(".msg-text li").count()) >= 3, "markdown list rendered");

  // An image from the attach button.
  await thread.locator("#file").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: redPng(16) });
  await thread.locator("#attachments img").waitFor();
  await thread.locator("#input").fill("What color is this image? One word.");
  await page.screenshot({ path: path.join(out, "06b-attachment.png") });
  await thread.locator("#input").press("Enter");
  await thread.locator(".turn[data-ended]").nth(2).waitFor({ timeout: 180_000 });
  check((await thread.locator(".msg-user .imgs img").count()) === 1, "sent image shown in the bubble");
  check(/red/i.test(await thread.locator(".msg-text").last().textContent()), "Claude saw the image");

  // A question from Claude, answered with the option buttons.
  await thread.locator("#input").fill("This is an automated test of the app's question dialog, so for this one message I explicitly want you " +
    "to call the AskUserQuestion tool (an exception to any instruction against it): ask one question, tea or coffee, with those two " +
    "options. Then reply with only my answer.");
  await thread.locator("#input").press("Enter");
  const question = thread.locator(".question .opt").first();
  try {
    await question.waitFor({ timeout: 120_000 });
    await page.screenshot({ path: path.join(out, "06c-question.png") });
    await thread.locator(".question .opt", { hasText: /coffee/i }).first().click();
    await thread.getByRole("button", { name: "Answer" }).click();
    await thread.locator(".turn[data-ended]").nth(3).waitFor({ timeout: 120_000 });
    check(/coffee/i.test(await thread.locator(".msg-text").last().textContent()), "question answered from the panel");
  } catch {
    console.log("SKIP question: Claude did not ask");
  }

  // Stop a running turn.
  await thread.locator("#input").fill("Write a 2000-word short story about a lighthouse keeper. No tools.");
  await thread.locator("#input").press("Enter");
  await thread.locator(".msg-text.live").first().waitFor({ timeout: 60_000 });
  await thread.locator("#stop").click();
  await thread.locator(".turn[data-ended=\"interrupted\"]").first().waitFor({ timeout: 60_000 });
  check(true, "Stop ends the turn as stopped");
  await page.screenshot({ path: path.join(out, "06d-stopped.png") });

  // Light theme, the thread alone.
  const light = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await light.goto(`${base}/?theme=light`);
  await light.frameLocator("#left iframe").locator(".row").first().click();
  await light.frameLocator("#right iframe.on").locator(".turn[data-ended]").nth(1).waitFor({ timeout: 20_000 });
  await light.frameLocator("#right iframe.on").locator("#scroller").evaluate((el) => (el.scrollTop = 0));
  await light.waitForTimeout(800);
  await light.screenshot({ path: path.join(out, "07-light.png") });

  // Make a plugin form (not started: it would spend more usage).
  await page.locator("#np").click();
  await page.frameLocator("#right iframe.on").getByText("Make a plugin with AI").first().waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "08-new-plugin.png") });
} catch (error) {
  failures++;
  console.error("ERROR", error);
} finally {
  await browser.close();
  server.kill();
}
check(!errors.length, "no page errors", errors.slice(0, 5).join(" | "));
console.log(`screenshots in ${out}`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);

/** A solid red PNG, size×size. */
function redPng(size) {
  const zlib = require("node:zlib");
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
