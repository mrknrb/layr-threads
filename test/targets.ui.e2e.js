// The threads panel in a real browser, against the dev server (fake hub, real backend), with screenshots.
// 0.12.0: one list of every thread (projects and plugins together, the last changed first, no tabs, no groups), and
// one new-thread form whose "Works on" asks for a folder only for a project. Starting a thread doesn't wait for Claude
// (any model is fine):
//   PLAYWRIGHT_DIR=<folder with node_modules/playwright> node test/targets.ui.e2e.js [outDir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || pluginDir, "package.json"));
const { chromium } = require("playwright");
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), "layr-claude-targets-shots"));
mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-targets-ui-"));
const mk = (name, manifest) => {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "layr.json"), JSON.stringify(manifest));
  return dir;
};
const repos = [
  { id: "lab-notebook", name: "Lab notebook", kind: "made", linked: true,
    path: mk("lab-notebook", { id: "lab-notebook", name: "Lab notebook", description: "Samples in a table" }) },
  { id: "quiet-youtube", name: "Quiet YouTube", kind: "made", linked: true,
    path: mk("quiet-youtube", { id: "quiet-youtube", name: "Quiet YouTube", extension: "extension" }) },
];
const reposFile = path.join(tmp, "repos.json");
writeFileSync(reposFile, JSON.stringify(repos));
const projectDir = path.join(tmp, "my-app");
mkdirSync(projectDir, { recursive: true });

const port = 4300 + Math.floor(Math.random() * 600) + 20;
const server = spawn(process.execPath, [path.join(pluginDir, "dev", "devserver.js"), "--port", String(port), "--data",
  path.join(tmp, "data"), "--repos", reposFile], {
  cwd: pluginDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LAYR_CLAUDE_PLUGINS_DIR: path.join(tmp, "layr-plugins"), LAYR_PACKAGES: "" },
});
server.stderr.on("data", (d) => process.env.LAYR_TEST_VERBOSE && process.stderr.write(d));
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("dev server") && resolve()));
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 820 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/`);
  const threads = page.frameLocator("#left iframe");
  await threads.getByText("No threads yet").waitFor({ timeout: 20_000 });
  check(await threads.locator("#modes").count() === 0, "no Projects / Plugins / Extensions tabs");

  // No projects yet: the form opens on plugins, with no plugin picker and no folder question.
  await threads.locator("#new").click();
  const on = threads.locator("#new-form .ws-choice").first().locator("button");
  check(await on.count() === 2, "Works on: a project or plugins");
  check((await threads.locator("#new-form .ws-choice button.on").first().textContent()).includes("Plugins"), "it starts on Plugins");
  check(!(await threads.locator("#new-form select").first().isVisible()), "no project picker for plugins");
  check((await threads.locator(".target-note").textContent()).includes("empty folder"), "the note: an empty folder");
  const optionTexts = (await threads.locator("#new-form option").allTextContents()).join(" | ");
  check(!/Lab notebook|New plugin|No plugin yet/.test(optionTexts), "no plugin picker", optionTexts);
  await page.screenshot({ path: path.join(out, "01-new-on-plugins.png") });
  await threads.locator("#new-form textarea").fill("Reply with one word: ok. Change nothing.");
  await threads.getByRole("button", { name: "Start" }).click();
  await threads.locator(".row .title").first().waitFor({ timeout: 20_000 });
  check((await threads.locator(".row .badge.where").first().textContent()).includes("No plugins yet"), "the row says: no plugins yet");

  // A project: the folder question shows, and its thread goes on top of the same list.
  await threads.locator("#new-form").waitFor({ state: "hidden" });
  await threads.locator("#new").click();
  await threads.locator("#new-form textarea").waitFor();
  await on.filter({ hasText: "A project" }).click();
  check(await threads.locator("#new-form select").first().isVisible(), "a project asks for its folder");
  await threads.locator("#new-form input.input").first().fill(projectDir);
  await threads.locator("#new-form .inline-row .btn", { hasText: "Add" }).click();
  await page.waitForTimeout(500);
  await threads.locator("#new-form textarea").fill("Reply with one word: ok. Change nothing.");
  await page.screenshot({ path: path.join(out, "02-new-on-project.png") });
  await threads.getByRole("button", { name: "Start" }).click();
  await threads.locator(".row").nth(1).waitFor({ timeout: 20_000 });
  check(await threads.locator(".project-head").count() === 0, "no groups by project or plugin");
  check((await threads.locator(".row .badge.where").first().textContent()).includes("my-app"), "the newest (the project's) is on top");
  check((await threads.locator(".row .badge.where").nth(1).textContent()).includes("No plugins yet"), "the plugin thread under it, in the same list");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "03-one-list.png") });
} catch (error) {
  check(false, "run", error.message);
} finally {
  check(!errors.length, "no page errors", errors.join(" | "));
  await browser.close();
  server.kill();
}
console.log(`screenshots: ${out}`);
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
