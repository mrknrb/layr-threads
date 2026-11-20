// Unit test of threads on plugins and extensions (backend/targets.js), without Claude or a core: the plugin list from
// a stand-in hub, a store plugin gets your copy first, a new plugin and a new extension get their folder, template
// and first commit, and the system prompt says what it should. First as on an older core (every plugin made here in
// one folder, `~/layr-plugins`), then as on a core with one folder for each plugin (LAYR_PACKAGES:
// `<packages>/<id>/mine`). Run: node test/targets.test.js
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-targets-"));
process.env.LAYR_CLAUDE_PLUGINS_DIR = path.join(tmp, "layr-plugins");
// An older core: it doesn't say where its packages are (a thread of a newer layr running this test might).
delete process.env.LAYR_PACKAGES;
const { isPluginsRoot, listTargets, readManifest, resolveTarget, scaffoldExtension, targetSystemPrompt } = await import(
  "../backend/targets.js"
);
const { newPluginFolder, oldPluginsRoot, packagesRoot, pluginFolder } = await import("../backend/pluginMaker.js");

// Installed plugins as the core's layr__plugin_repos gives them.
const made = path.join(tmp, "made");
mkdirSync(path.join(made, "extension"), { recursive: true });
writeFileSync(path.join(made, "layr.json"), JSON.stringify({ id: "quiet", name: "Quiet", extension: "extension", description: "Hush" }));
const storeDir = path.join(tmp, "packages", "notes", "0.1.0");
mkdirSync(storeDir, { recursive: true });
writeFileSync(path.join(storeDir, "layr.json"), JSON.stringify({ id: "notes", name: "Notes" }));
const mine = path.join(tmp, "packages", "notes", "mine");
const inside = path.join(tmp, "repo", "plugins", "claude");
mkdirSync(inside, { recursive: true });
writeFileSync(path.join(inside, "layr.json"), JSON.stringify({ id: "claude", name: "Claude Code" }));

const calls = [];
/** What layr__plugin_repos lists. */
const repos = [
  { id: "quiet", name: "Quiet", kind: "made", path: made, linked: true },
  { id: "notes", name: "Notes", kind: "store", path: storeDir, linked: false },
  { id: "claude", name: "Claude Code", kind: "made", path: inside, linked: true, insideRepo: path.join(tmp, "repo") },
];
const hub = {
  available: true,
  url: null, // no core to fetch layr-ext.js from: the repository's copy is used
  async call(name, args) {
    calls.push({ name, args });
    if (name === "layr__plugin_repos") return { git: true, plugins: repos };
    if (name === "layr__plugin_edit") {
      mkdirSync(mine, { recursive: true });
      return { path: mine, branch: "mine" };
    }
    throw new Error(`unexpected ${name}`);
  },
};

const { targets } = await listTargets(hub);
const byId = Object.fromEntries(targets.map((t) => [t.id, t]));
check(byId.quiet?.place === "made" && byId.quiet.extension === true, "a made plugin with an extension", byId.quiet);
check(byId.notes?.place === "store" && byId.notes.extension === false, "a store plugin", byId.notes);
check(byId.claude?.place === "inside", "a plugin inside a bigger repository", byId.claude);

// A store plugin: your copy is made first, and the thread works there.
const store = await resolveTarget(hub, { kind: "plugin", plugin: "notes" });
check(store.folder === mine && store.place === "changed" && !store.isNew, "store plugin → your copy", store);
check(calls.some((c) => c.name === "layr__plugin_edit" && c.args.plugin === "notes"), "layr__plugin_edit asked");

// An existing extension plugin keeps its kind even when asked as a plugin.
const quiet = await resolveTarget(hub, { kind: "plugin", plugin: "quiet" });
check(quiet.kind === "extension" && quiet.folder === made && quiet.place === "made", "existing extension", quiet);

let unknown = null;
await resolveTarget(hub, { kind: "plugin", plugin: "nope" }).catch((e) => (unknown = e.message));
check(/No plugin nope/.test(unknown ?? ""), "unknown plugin refused", unknown);

// A new plugin: its own folder and repository with an empty first commit.
check(packagesRoot() === null && pluginFolder("x") === path.join(oldPluginsRoot(), "x"),
  "an older core: a plugin's folder is in the one folder for every plugin");
const fresh = await resolveTarget(hub, { kind: "plugin", name: "Lab notebook" });
check(fresh.isNew && fresh.id === "lab-notebook" && existsSync(path.join(fresh.folder, ".git")), "new plugin folder", fresh);
check(fresh.folder === path.join(tmp, "layr-plugins", "lab-notebook"), "in the old folder for every plugin",
  fresh.folder);
check(git(fresh.folder, "log", "--format=%s") === "New plugin lab-notebook", "its first commit");
const second = newPluginFolder({ name: "Lab notebook" });
check(second.id === "lab-notebook-2", "a taken id gets a number", second.id);

// A new extension: the template (layr.json with extension, MV3 manifest, a service worker, layr-ext.js), committed.
const ext = await resolveTarget(hub, { kind: "extension", name: "Quiet YouTube", description: "Hide recommendations\nand more" });
const lm = readManifest(ext.folder);
check(lm?.id === "quiet-youtube" && lm.extension === "extension", "layr.json names the extension", lm);
const cm = JSON.parse(readFileSync(path.join(ext.folder, "extension", "manifest.json"), "utf8"));
check(cm.manifest_version === 3 && cm.background?.type === "module" && cm.description === "Hide recommendations", "MV3 manifest", cm);
const sw = readFileSync(path.join(ext.folder, "extension", "background.js"), "utf8");
check(sw.includes('import layr from "./layr-ext.js"') && sw.includes("layr.tools.serve"), "service worker uses layr-ext.js");
const sdk = path.join(ext.folder, "extension", "layr-ext.js");
check(existsSync(sdk) && readFileSync(sdk, "utf8").includes("tools.serve"), "layr-ext.js copied in");
// layr-page.js (content scripts' layr.expect) comes along when the core or the repository has it; the template has no
// content script, so no manifest lists it.
const repoPage = path.resolve(import.meta.dirname, "..", "..", "..", "core", "layr_core", "assets", "layr-page.js");
const pageFile = path.join(ext.folder, "extension", "layr-page.js");
check(existsSync(pageFile) === existsSync(repoPage), "layr-page.js copied in when there is one", existsSync(repoPage));
check(!cm.content_scripts, "no content script in the template");
check(git(ext.folder, "status", "--porcelain") === "", "template committed");
check(git(ext.folder, "ls-files").split(/\r?\n/).includes("extension/manifest.json"), "first commit holds the template");

// The system prompts.
const pNew = targetSystemPrompt({ ...ext, hubUrl: "http://127.0.0.1:4300/mcp" });
check(pNew.includes("Chrome extension") && pNew.includes("mcp__layr__layr__extension_reload") && pNew.includes("packages_link"),
  "new extension prompt");
check(pNew.includes("http://127.0.0.1:4300/_layr/layr-ext.js"), "names where layr-ext.js comes from");
check(pNew.includes("http://127.0.0.1:4300/_layr/layr-page.js") && pNew.includes("content_scripts[].js"),
  "content scripts: layr-page.js before their own script");
check(pNew.includes("layr.expect(") && pNew.includes("layr.problem(") && pNew.includes("Never weaken or delete")
  && pNew.includes('"check": "check.mjs"'), "prompt asks for expect, problem and a check script");
check(pNew.includes("Prefer a plugin without a backend") && pNew.includes("developer mode"),
  "prefers sandboxed plugins, names developer mode");
const pStore = targetSystemPrompt({ ...store, name: "Notes" });
check(pStore.includes("own copy") && !pStore.includes("packages_link") && !pStore.includes("Chrome extension"),
  "store copy prompt");
check(pStore.includes("layr.expect(") && pStore.includes("layr__problem_report") && !pStore.includes("layr-page.js"),
  "a plain plugin's prompt: expect in panels, problem_report in a backend");
const pInside = targetSystemPrompt({ ...byId.claude, folder: inside, isNew: false, extension: false });
check(pInside.includes("bigger git repository"), "inside a repository prompt");

check(isPluginsRoot(process.env.LAYR_CLAUDE_PLUGINS_DIR) && !isPluginsRoot(tmp), "the plugins folder is known");

// Folders made in the old folder for every plugin (~/layr-plugins) but not linked yet are targets too.
const { targets: again } = await listTargets(hub);
check(again.some((t) => t.id === "quiet-youtube" && t.extension && !t.linked), "unlinked new extension listed",
  again.map((t) => t.id));

// The SDK files come from the running core: a new core serves layr-page.js too; an older one doesn't (404), and the
// template goes without it.
for (const [what, hasPage] of [["a new core", true], ["an older core", false]]) {
  const fakeCore = http.createServer((req, res) => {
    if (req.url === "/_layr/layr-ext.js") return res.end("// layr-ext.js from the core\nlayr.tools.serve");
    if (req.url === "/_layr/layr-page.js" && hasPage) return res.end("// layr-page.js from the core\nlayr.expect");
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => fakeCore.listen(0, "127.0.0.1", r));
  const folder = path.join(tmp, `from-core-${hasPage}`);
  mkdirSync(folder, { recursive: true });
  const hubAt = { url: `http://127.0.0.1:${fakeCore.address().port}/mcp` };
  const r = await scaffoldExtension(hubAt, { id: "t", name: "T", folder });
  fakeCore.close();
  const page = path.join(folder, "extension", "layr-page.js");
  const extSdk = readFileSync(path.join(folder, "extension", "layr-ext.js"), "utf8");
  check(extSdk.includes("from the core"), `${what}: layr-ext.js from the core`);
  // Without it in the core, the repository's copy (when this runs from layr's repository and it has one) is used.
  const expected = hasPage || existsSync(repoPage);
  check(r.pageSdk === expected && existsSync(page) === expected,
    `${what}: layr-page.js ${expected ? "written" : "skipped"}`, r);
  if (hasPage) check(readFileSync(page, "utf8").includes("from the core"), `${what}: layr-page.js from the core`);
}

// ------------------------------------------------------------------ one folder for each plugin (LAYR_PACKAGES)

const packages = path.join(tmp, "home", "packages");
mkdirSync(packages, { recursive: true });
process.env.LAYR_PACKAGES = packages;
check(packagesRoot() === packages && pluginFolder("x") === path.join(packages, "x", "mine"),
  "a plugin's folder is <packages>/<id>/mine");
check(isPluginsRoot(process.env.LAYR_CLAUDE_PLUGINS_DIR) && !isPluginsRoot(packages),
  "the old projects' folder for every plugin is still the old one");

// A new plugin: `<packages>/<id>/mine`, a repository of its own (`.git` is a folder).
const log = await resolveTarget(hub, { kind: "plugin", name: "Field log" });
check(log.isNew && log.id === "field-log" && log.folder === path.join(packages, "field-log", "mine"),
  "new plugin folder", log);
check(statSync(path.join(log.folder, ".git")).isDirectory(), "its own repository");
check(git(log.folder, "log", "--format=%s") === "New plugin field-log", "its first commit");
check(!existsSync(path.join(tmp, "layr-plugins", "field-log")), "nothing new in the old folder");
check(targetSystemPrompt({ ...log }).includes("folder in layr is named after it"), "the prompt: keep the id");

// An id is free only when layr has no folder for it: a plugin installed (its versions), or uninstalled (its history).
mkdirSync(path.join(packages, "taken", "store", "0.1.0"), { recursive: true });
mkdirSync(path.join(packages, "gone", "history.git"), { recursive: true });
check(newPluginFolder({ name: "Taken" }).id === "taken-2", "an installed plugin's id is taken");
check(newPluginFolder({ name: "Gone" }).id === "gone-2", "an uninstalled plugin's id is taken");
check(newPluginFolder({ name: "Field log" }).id === "field-log-2", "a plugin being made has its id");
// A folder left in the old place (no layr.json yet: the core didn't take it in) keeps its id too.
check(newPluginFolder({ name: "Lab notebook" }).id === "lab-notebook-3", "a folder left in the old place has its id");
const ext2 = await resolveTarget(hub, { kind: "extension", name: "Tab titles" });
check(ext2.folder === path.join(packages, "tab-titles", "mine") && readManifest(ext2.folder)?.extension === "extension"
  && git(ext2.folder, "status", "--porcelain") === "", "a new extension: its template in its own folder", ext2.folder);

// Targets: the plugins layr runs, plus folders of plugins made here that aren't in layr yet.
const mk = (id, { manifest, dotGit } = {}) => {
  const dir = path.join(packages, id, "mine");
  mkdirSync(dir, { recursive: true });
  if (manifest) writeFileSync(path.join(dir, "layr.json"), JSON.stringify(manifest));
  if (dotGit === "file") writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(packages, id, "history.git")}\n`);
  if (dotGit === "folder") mkdirSync(path.join(dir, ".git"));
  return dir;
};
const own = mk("own", { manifest: { id: "own", name: "Own" }, dotGit: "folder" }); // layr runs it from there
repos.push({ id: "own", name: "Own", kind: "made", path: own, linked: true });
mk("kept", { manifest: { id: "kept", name: "Kept" }, dotGit: "file" }); // a layr.json, layr doesn't run it
mk("bare-copy", { dotGit: "file" }); // a worktree without a layr.json: nothing to work on
mk("quiet", { manifest: { id: "quiet", name: "Quiet again" }, dotGit: "folder" }); // its id runs from elsewhere
const { targets: now } = await listTargets(hub);
const at = (id) => now.filter((t) => t.id === id);
check(at("own").length === 1 && at("own")[0].linked === true, "a plugin of yours layr runs is listed once", at("own"));
check(at("field-log").length === 1 && at("field-log")[0].linked === false && at("field-log")[0].place === "made"
  && at("field-log")[0].path === log.folder, "a new plugin without a layr.json yet is listed, not linked",
  at("field-log"));
check(at("tab-titles")[0]?.extension === true && at("tab-titles")[0].linked === false, "a new extension too");
check(at("kept").length === 1 && at("kept")[0].name === "Kept" && !at("kept")[0].linked,
  "a folder with a layr.json too");
check(at("bare-copy").length === 0 && at("taken").length === 0 && at("gone").length === 0,
  "folders without a plugin of yours in them aren't", now.map((t) => t.id));
check(at("quiet").length === 1 && at("quiet")[0].path === made, "an installed id isn't listed twice", at("quiet"));
check(at("lab-notebook")[0]?.path === path.join(tmp, "layr-plugins", "lab-notebook") && !at("lab-notebook")[0].linked,
  "a folder left in the old place is still listed", at("lab-notebook"));
// A thread on such a folder works there.
const again2 = await resolveTarget(hub, { kind: "plugin", plugin: "field-log" });
check(again2.folder === log.folder && again2.place === "made" && !again2.isNew, "a thread on a plugin being made",
  again2);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
