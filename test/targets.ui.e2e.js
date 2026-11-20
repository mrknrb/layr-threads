// The threads panel's Projects / Plugins / Extensions switch in a real browser, against the dev server (fake hub, real
// backend), with screenshots. Starting a thread makes its folder but Claude isn't waited for (any model is fine):
//   PLAYWRIGHT_DIR=<folder with node_modules/playwright> node test/targets.ui.e2e.js [outDir]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  { id: "notes", name: "Notes", kind: "store", linked: false, path: mk("notes", { id: "notes", name: "Notes" }) },
];
const reposFile = path.join(tmp, "repos.json");
writeFileSync(reposFile, JSON.stringify(repos));

const port = 4300 + Math.floor(Math.random() * 600) + 20;
const server = spawn(process.execPath, [path.join(pluginDir, "dev", "devserver.js"), "--port", String(port), "--data",
  path.join(tmp, "data"), "--repos", reposFile], {
  cwd: pluginDir,
  stdio: ["ignore", "pipe", "pipe"],
  // As on an older core (every plugin made here in one folder): never the packages folder of a layr this is run from.
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
  await threads.getByText("No projects yet").waitFor({ timeout: 20_000 });
  check(await threads.locator("#modes button").count() === 3, "the switch has three choices");

  // Plugins: your plugins as groups; the store one only in the form.
  await threads.locator("#modes button", { hasText: "Plugins" }).click();
  await threads.locator(".project-head .name", { hasText: "Lab notebook" }).waitFor();
  check(await threads.locator(".project-head .name", { hasText: "Quiet YouTube" }).count() === 0, "extensions aren't under Plugins");
  check(await threads.locator(".project-head .name", { hasText: "Notes" }).count() === 0, "untouched store plugins aren't listed");
  await page.screenshot({ path: path.join(out, "01-plugins.png") });

  await threads.locator("#new").click();
  const options = await threads.locator("#new-form select").first().locator("option").allTextContents();
  check(options[0] === "+ New plugin" && options.includes("Lab notebook") && options.includes("Notes"), "the plugin picker",
    options.join(", "));
  await page.screenshot({ path: path.join(out, "02-new-plugin-form.png") });
  await threads.locator("#new-form select").first().selectOption("notes");
  check((await threads.locator(".target-note").textContent()).includes("own copy"), "a store plugin says: your own copy");
  await threads.locator("#new-form select").first().selectOption("lab-notebook");
  await threads.locator("#new-form textarea").fill("Reply with one word: ok. Change nothing.");
  await threads.getByRole("button", { name: "Start" }).click();
  await threads.locator(".project-head .name", { hasText: "Lab notebook" }).waitFor();
  await threads.locator(".row .title").first().waitFor({ timeout: 20_000 });
  check(await threads.locator(".row").count() >= 1, "the thread shows under its plugin");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "03-plugin-thread.png") });
  const thread = page.frameLocator("#right iframe.on");
  const badge = await thread.locator("#workspace").textContent({ timeout: 20_000 });
  check(badge.includes("lab-notebook"), "the thread names its plugin", badge);

  // Extensions: a new one gets the template.
  await threads.locator("#modes button", { hasText: "Extensions" }).click();
  await threads.locator(".project-head .name", { hasText: "Quiet YouTube" }).waitFor();
  check(await threads.locator(".project-head .name", { hasText: "Lab notebook" }).count() === 0, "plugins aren't under Extensions");
  await threads.locator("#new").click();
  await threads.locator("#new-form input.input").first().fill("Tab titles");
  await threads.locator("#new-form .chip").first().click();
  await page.screenshot({ path: path.join(out, "04-new-extension-form.png") });
  await threads.getByRole("button", { name: "Start" }).click();
  const folder = path.join(tmp, "layr-plugins", "tab-titles");
  for (let i = 0; i < 100 && !existsSync(path.join(folder, "extension", "manifest.json")); i++) await page.waitForTimeout(200);
  check(existsSync(path.join(folder, "extension", "background.js")), "the new extension's template", folder);
  const lm = JSON.parse(readFileSync(path.join(folder, "layr.json"), "utf8"));
  check(lm.extension === "extension", "its layr.json names the extension");
  await threads.locator(".project-head .name", { hasText: "Tab titles" }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "05-extension-thread.png") });

  // Projects: none of that shows there.
  await threads.locator("#modes button", { hasText: "Projects" }).click();
  await threads.getByText("No projects yet").waitFor();
  check(true, "projects view stays free of plugin threads");
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
