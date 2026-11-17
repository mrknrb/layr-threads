// Unit test of threads on plugins and extensions (backend/targets.js), without Claude or a core: the plugin list from
// a stand-in hub, a store plugin gets your copy first, a new plugin and a new extension get their folder, template
// and first commit, and the system prompt says what it should. Run: node test/targets.test.js
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const { isPluginsRoot, listTargets, readManifest, resolveTarget, targetSystemPrompt } = await import("../backend/targets.js");

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
const hub = {
  available: true,
  url: null, // no core to fetch layr-ext.js from: the repository's copy is used
  async call(name, args) {
    calls.push({ name, args });
    if (name === "layr__plugin_repos") {
      return {
        git: true,
        plugins: [
          { id: "quiet", name: "Quiet", kind: "made", path: made, linked: true },
          { id: "notes", name: "Notes", kind: "store", path: storeDir, linked: false },
          { id: "claude", name: "Claude Code", kind: "made", path: inside, linked: true, insideRepo: path.join(tmp, "repo") },
        ],
      };
    }
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
const fresh = await resolveTarget(hub, { kind: "plugin", name: "Lab notebook" });
check(fresh.isNew && fresh.id === "lab-notebook" && existsSync(path.join(fresh.folder, ".git")), "new plugin folder", fresh);
check(git(fresh.folder, "log", "--format=%s") === "New plugin lab-notebook", "its first commit");

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
check(git(ext.folder, "status", "--porcelain") === "", "template committed");
check(git(ext.folder, "ls-files").split(/\r?\n/).includes("extension/manifest.json"), "first commit holds the template");

// The system prompts.
const pNew = targetSystemPrompt({ ...ext, hubUrl: "http://127.0.0.1:4300/mcp" });
check(pNew.includes("Chrome extension") && pNew.includes("mcp__layr__layr__extension_reload") && pNew.includes("packages_link"),
  "new extension prompt");
check(pNew.includes("http://127.0.0.1:4300/_layr/layr-ext.js"), "names where layr-ext.js comes from");
const pStore = targetSystemPrompt({ ...store, name: "Notes" });
check(pStore.includes("own copy") && !pStore.includes("packages_link") && !pStore.includes("Chrome extension"),
  "store copy prompt");
const pInside = targetSystemPrompt({ ...byId.claude, folder: inside, isNew: false, extension: false });
check(pInside.includes("bigger git repository"), "inside a repository prompt");

check(isPluginsRoot(process.env.LAYR_CLAUDE_PLUGINS_DIR) && !isPluginsRoot(tmp), "the plugins folder is known");

// Folders made in ~/layr-plugins but not linked yet are targets too.
const { targets: again } = await listTargets(hub);
check(again.some((t) => t.id === "quiet-youtube" && t.extension && !t.linked), "unlinked new extension listed",
  again.map((t) => t.id));

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
