// The thread panel's parts without spending Claude usage: the demo threads of dev/fixtures.js under the dev server,
// clicked through in a real browser, with screenshots: folded turns and groups, reply boxes with picked answers and
// the composer's prefix, ▶ Run, layr:// links, the changes drawer, the / menu, drafts, the pipeline strip (a fake
// pipeline in dev/mock-layr.js), the right-click menus and the phone view. Needs Playwright with Chromium:
//   PLAYWRIGHT_DIR=<folder with node_modules/playwright> node test/ui.e2e.js [outDir]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || pluginDir, "package.json"));
const { chromium } = require("playwright");
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "layr-claude-ui-shots"));
mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const data = path.join(mkdtempSync(path.join(os.tmpdir(), "layr-claude-ui-")), "data");
execFileSync(process.execPath, [path.join(pluginDir, "dev", "fixtures.js"), data]);
const port = 4900 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, [path.join(pluginDir, "dev", "devserver.js"), "--port", String(port), "--data", data], {
  cwd: pluginDir,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.env.LAYR_TEST_VERBOSE && process.stderr.write(d));
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("dev server") && resolve()));
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/?open=t_demo1`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/?open=t_demo1`);
  const thread = page.frameLocator("#right iframe.on");

  // Folded turns: the first finished turn shows one row, with its tokens; the work is hidden.
  await thread.locator(".fold-row").first().waitFor({ timeout: 20_000 });
  const folds = await thread.locator(".fold-row").allTextContents();
  check(folds.length === 2, "both finished turns fold", folds.join(" | "));
  check(/Worked for 48s · 18k tokens in · 2.3k out/.test(folds[0]), "fold row says time and tokens", folds[0]);
  check(/Worked for 3m 12s · 777k tokens in · 2.9k out/.test(folds[1]), "second fold row", folds[1]);
  check((await thread.locator(".turn:has(.fold-row)").first().locator("details.tool").count()) === 0, "folded work is hidden");
  check((await thread.locator(".when").count()) >= 3, "messages have their times");
  await page.screenshot({ path: path.join(out, "10-folded.png") });
  await thread.locator(".fold-row").first().click();
  await thread.locator(".turn:has(.fold-row)").first().locator("details.group").first().waitFor();
  const groups = await thread.locator(".turn:has(.fold-row)").first().locator("details.group > summary .label").allTextContents();
  check(groups.some((g) => /read 1 file, 1 search, edited 1 file, ran 1 command/.test(g)), "work runs group", groups.join(" | "));
  await page.screenshot({ path: path.join(out, "11-unfolded.png") });
  await thread.locator(".fold-row").first().click();

  // Boxes: sections, questions, the status line; picking makes the prefix.
  check((await thread.locator(".box-summary").count()) === 1 && (await thread.locator(".box-questions").count()) === 1, "reply drawn as boxes");
  check((await thread.locator(".reply-chip.risky").count()) === 1, "status line chips");
  check((await thread.locator(".box-option.none").count()) === 1, "None of them under the ☑️ question");
  await thread.locator(".box-question").nth(0).locator(".box-option", { hasText: "Globally" }).click();
  await thread.locator(".box-question").nth(1).locator(".box-option", { hasText: "Z–A" }).click();
  const prefix = await thread.locator("#prefix .text").textContent();
  check(prefix === "My answers: 1B, 2B. Everything else as recommended.", "picks make the prefix", prefix);
  await page.screenshot({ path: path.join(out, "12-boxes-picked.png") });
  await thread.locator("#prefix button").click();
  check(await thread.locator("#prefix").isHidden(), "✕ clears the picks");
  await thread.locator(".box-agree").click();
  check((await thread.locator("#prefix .text").textContent()) === "I agree with everything recommended", "agree button");

  // ▶ Run and layr:// links.
  check((await thread.locator(".run-btn").count()) === 1, "▶ Run on the powershell block");
  const threadLinks = thread.locator('a.layr-link[href^="layr://claude/"]');
  check((await threadLinks.count()) === 1, "layr:// link in plain text is a link");
  // Without the concepts plugin: no prototypes under replies, no ◇ chip.
  check((await thread.locator(".protos:not([hidden])").count()) === 0, "no prototypes without concepts");
  check(await thread.locator("#concepts-chip").isHidden(), "no ◇ chip without concepts");
  check(/\d+(\.\d)?% context/.test(await thread.locator("#context").textContent()), "context fill as a percentage",
    `${await thread.locator("#context").textContent()} (${await thread.locator("#context").getAttribute("title")})`);
  await threadLinks.click();
  await page.waitForTimeout(500);
  check((await page.locator("#rtabs .tab").count()) === 2, "layr:// link opened the thread in layr");
  await page.locator("#rtabs .tab").first().click();

  // Drafts: text and picks come back after the panel is opened again.
  await thread.locator("#input").fill("draft text");
  await page.waitForTimeout(700);
  await page.reload();
  await page.frameLocator("#right iframe.on").locator(".fold-row").first().waitFor({ timeout: 20_000 });
  const again = page.frameLocator("#right iframe.on");
  check((await again.locator("#input").inputValue()) === "draft text", "draft text kept");
  check((await again.locator("#prefix .text").textContent().catch(() => "")) === "I agree with everything recommended", "draft picks kept");

  // The / menu.
  await again.locator("#input").fill("/");
  await again.locator("#slash .slash-row").first().waitFor();
  const names = await again.locator("#slash .name").allTextContents();
  check(names.includes("/compact"), "/ menu lists /compact", names.join(" "));
  await page.screenshot({ path: path.join(out, "13-slash.png") });
  await again.locator("#input").press("Escape");
  await again.locator("#input").fill("");

  // The changes drawer (the demo thread works in this repository's folder).
  const chip = again.locator("#changes-chip");
  try {
    await chip.waitFor({ state: "visible", timeout: 15_000 });
    check(/^\+\d+ −\d+ · \d+ files?/.test((await chip.textContent()).trim()), "changes chip", await chip.textContent());
    await chip.click();
    await again.locator("#changes .drawer-head").waitFor();
    await page.screenshot({ path: path.join(out, "14-changes.png") });
    const firstFile = again.locator("#changes .file-row").first();
    if (await firstFile.count()) {
      await firstFile.click();
      await again.locator("#changes .file-diff .diff").first().waitFor({ timeout: 10_000 });
      check(true, "a file opens to its diff");
    }
    await again.locator("#changes .tab", { hasText: "Commits" }).click();
    await page.screenshot({ path: path.join(out, "15-commits.png") });
    await chip.click();
  } catch (error) {
    console.log(`SKIP changes: ${error.message.split("\n")[0]} (no changes against a base here?)`);
  }

  // The header's menu (our own where the shell has none).
  await again.locator("#more").click();
  const items = await again.locator(".own-menu button").allTextContents();
  check(items.includes("Open folder in VS Code") && items.includes("Copy link") && !items.includes("+ Pipeline"), "header menu", items.join(", "));
  await page.keyboard.press("Escape");

  // With a fake concepts plugin: the prototypes a reply links to run under it, the ◇ chip lists the nodes touched.
  await page.evaluate(() => {
    localStorage.setItem("mock-layr.concepts", "1");
    localStorage.removeItem("mock-layr.links");
  });
  await page.reload();
  const tc = page.frameLocator("#right iframe.on");
  await tc.locator(".protos:not([hidden]) iframe.proto-frame").first().waitFor({ timeout: 20_000 });
  const frames = tc.locator("iframe.proto-frame");
  check((await frames.count()) === 2, "both prototypes of the reply run under it");
  check((await frames.first().getAttribute("sandbox")) === "allow-scripts", "in a sandbox with scripts only");
  check(/2 prototypes/.test(await tc.locator(".proto-title").textContent()), "one strip for both");
  // Frames out of view aren't laid out (nor say their height) until they are scrolled to.
  await tc.locator(".proto-columns").scrollIntoViewIfNeeded();
  const boxes = tc.locator(".proto-box");
  const heights = async () => [await boxes.nth(0).evaluate((e) => e.offsetHeight), await boxes.nth(1).evaluate((e) => e.offsetHeight)];
  let [h1, h2] = await heights();
  for (let i = 0; i < 25 && !(h2 > h1); i++) {
    await page.waitForTimeout(200);
    [h1, h2] = await heights();
  }
  check(h2 > h1 && h1 >= 120, "each as tall as its page", `${h1} / ${h2}`);
  await page.waitForTimeout(300);
  await tc.locator(".proto-columns").scrollIntoViewIfNeeded();
  const grip = await tc.locator(".proto-grip").first().boundingBox();
  await page.mouse.move(grip.x + 20, grip.y + 3);
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, grip.y + 103, { steps: 5 });
  await page.mouse.up();
  const dragged = await boxes.nth(0).evaluate((e) => e.offsetHeight);
  check(Math.abs(dragged - (h1 + 100)) <= 4, "its height can be dragged", `${h1} → ${dragged}`);
  const inner = tc.frameLocator("iframe.proto-frame >> nth=0");
  await inner.locator("#sort").click();
  check(/sorted/.test(await inner.locator("body").textContent()), "the page's own script runs");
  await page.screenshot({ path: path.join(out, "16a-prototypes.png") });
  await tc.locator(".proto-label", { hasText: "Sort menu" }).click();
  const chipC = tc.locator("#concepts-chip");
  await chipC.waitFor({ state: "visible", timeout: 10_000 });
  check((await chipC.textContent()) === "◇ 2", "◇ chip counts the nodes touched", await chipC.textContent());
  await chipC.click();
  const rows = tc.locator("#concepts .c-node");
  check((await rows.count()) === 2 && /Notes list.*changed.*Added a Sort button/.test(await rows.first().textContent()),
    "the nodes with what happened", await rows.first().textContent());
  await page.screenshot({ path: path.join(out, "16b-concept-nodes.png") });
  await rows.first().click();
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => JSON.parse(localStorage.getItem("mock-layr.links") || "[]"));
  check(opened.includes("layr://concepts/prototype/p-sort-2") && opened.includes("layr://concepts/node/n-notes"),
    "open in Concepts, and a node, through layr.links.open", opened.join(", "));
  await page.evaluate(() => localStorage.removeItem("mock-layr.concepts"));

  // The pipeline strip, with a fake pipeline.
  await page.evaluate(() => localStorage.setItem("mock-layr.pipeline", "1"));
  await page.reload();
  const t2 = page.frameLocator("#right iframe.on");
  await t2.locator("#task .task-id").waitFor({ timeout: 20_000 });
  check((await t2.locator("#task .task-id").textContent()) === "#42 · Stopped", "task strip head");
  await t2.locator("#task .task-brief summary").click();
  await page.screenshot({ path: path.join(out, "16-task-strip.png") });
  await t2.locator("#task .btn", { hasText: "Land" }).click();
  check((await t2.locator("#task .confirm-text").textContent()) === "Land #42 on main?", "button asks in the panel");
  await page.screenshot({ path: path.join(out, "17-task-confirm.png") });
  await t2.locator("#task .confirm .btn", { hasText: "Land" }).click();
  await t2.locator("#input").fill("go on");
  await t2.locator("#send").click();
  await page.waitForTimeout(500);
  const calls = await page.evaluate(() => JSON.parse(localStorage.getItem("mock-layr.pipelineCalls") || "[]"));
  check(calls.some((c) => c.tool === "thread_action" && c.args.action === "land"), "button ran pipeline__thread_action");
  check(calls.some((c) => c.tool === "send" && c.args.number === 42 && /go on/.test(c.args.text) && /I agree/.test(c.args.text)),
    "Send went through pipeline__send with the prefix", JSON.stringify(calls.filter((c) => c.tool === "send")));
  // The threads list: right-click a row that isn't a task.
  const list = page.frameLocator("#left iframe");
  await list.locator(".row", { hasText: "relay" }).click({ button: "right" });
  const rowItems = await list.locator(".own-menu button").allTextContents();
  check(rowItems.includes("+ Pipeline") && rowItems.includes("Rename"), "row menu offers + Pipeline", rowItems.join(", "));
  await page.screenshot({ path: path.join(out, "18-row-menu.png") });
  await page.keyboard.press("Escape");

  // On a phone: no ▶ Run, no VS Code.
  await page.evaluate(() => {
    localStorage.setItem("mock-layr.phone", "1");
    localStorage.removeItem("mock-layr.pipeline");
  });
  await page.reload();
  const t3 = page.frameLocator("#right iframe.on");
  await t3.locator(".fold-row").first().waitFor({ timeout: 20_000 });
  check((await t3.locator(".run-btn").count()) === 0, "no ▶ Run on a phone");
  await t3.locator("#more").click();
  const phoneItems = await t3.locator(".own-menu button").allTextContents();
  check(!phoneItems.some((i) => /VS Code|Explorer/.test(i)), "no PC windows in the phone's menu", phoneItems.join(", "));
  await page.keyboard.press("Escape");

  // The threads panel opened with a prompt (as the concepts panel opens it): the new-thread form is filled.
  const params = encodeURIComponent(JSON.stringify({ prompt: "Build the sort menu prototype", project: "recipes-app" }));
  await page.goto(`${base}/panels/threads.html?panel=threads&params=${params}`);
  await page.locator("#new-form textarea").waitFor({ timeout: 20_000 });
  check((await page.locator("#new-form textarea").inputValue()) === "Build the sort menu prototype", "params.prompt fills the form");
  const picked = await page.locator("#new-form select").first().evaluate((s) => s.options[s.selectedIndex]?.text);
  check(picked === "recipes-app", "params.project picks the project", picked);

  // Light theme.
  await page.evaluate(() => localStorage.removeItem("mock-layr.phone"));
  await page.goto(`${base}/?open=t_demo1&theme=light`);
  await page.frameLocator("#right iframe.on").locator(".box-summary").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(out, "19-light.png") });
} catch (error) {
  failures++;
  console.error("ERROR", error);
  for (const p of browser.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: path.join(out, "error.png") }).catch(() => {});
} finally {
  await browser.close();
  server.kill();
}
check(!errors.length, "no page errors", errors.slice(0, 5).join(" | "));
console.log(`screenshots in ${out}`);
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
