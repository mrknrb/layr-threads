// Plugins and Chrome extensions as what a thread works on (docs/ARCHITECTURE.md › The claude plugin › Threads on a
// plugin or an extension). A thread's `target` is a plugin: one you made (its own folder and repository), one from the
// store (layr__plugin_edit makes your copy, branch `mine`, first), one linked from a bigger repository, or a new one
// made in ~/layr-plugins. An extension is a plugin that brings a Chrome extension (layr.json `extension`), so it gets
// the same git history, undo, versions and publishing as any plugin.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initPluginRepo } from "./autoCommit.js";
import { findDocs, newPluginFolder, pluginsRoot } from "./pluginMaker.js";
import { errorMessage, log } from "./util.js";

export const TARGET_KINDS = ["plugin", "extension"];

const here = path.dirname(fileURLToPath(import.meta.url));

/** A folder's layr.json, or null. */
export function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "layr.json"), "utf8"));
  } catch {
    return null;
  }
}

function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, "").toLowerCase();
  return Boolean(a && b) && norm(a) === norm(b);
}

/** Is this project the old plugin maker's folder for every plugin (`~/layr-plugins`)? */
export function isPluginsRoot(dir) {
  return samePath(dir, pluginsRoot());
}

/**
 * Every installed plugin (the core's `layr__plugin_repos`) as a target: `{id, name, version, description, place, path,
 * extension, linked, repository}`; `place`: made (yours, its own repository), changed (a store plugin with your
 * changes), store (as it came), inside (linked from a bigger repository: no versions of its own). Plus plugins made
 * in ~/layr-plugins that aren't in layr yet (place made, `linked: false`).
 */
export async function listTargets(hub) {
  let plugins = [];
  let git = true;
  let error = null;
  if (hub.available) {
    try {
      const r = await hub.call("layr__plugin_repos", {});
      plugins = r?.plugins ?? [];
      git = r?.git !== false;
    } catch (e) {
      error = errorMessage(e);
    }
  }
  const out = plugins.map((p) => {
    const manifest = p.path ? readManifest(p.path) : null;
    return {
      id: p.id,
      name: p.name ?? p.id,
      version: p.version ?? null,
      description: manifest?.description ?? "",
      place: p.insideRepo ? "inside" : p.kind === "made" || p.kind === "changed" ? p.kind : "store",
      path: p.path ?? null,
      extension: Boolean(manifest?.extension),
      linked: Boolean(p.linked),
      repository: p.repository ?? null,
    };
  });
  // Folders the plugin maker made whose layr.json isn't in layr yet (Claude hasn't finished, or it isn't valid).
  try {
    const root = pluginsRoot();
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      if (out.some((t) => samePath(t.path, dir))) continue;
      const manifest = readManifest(dir);
      const id = manifest?.id ?? d.name;
      if (out.some((t) => t.id === id)) continue;
      out.push({
        id,
        name: manifest?.name ?? d.name,
        version: manifest?.version ?? null,
        description: manifest?.description ?? "",
        place: "made",
        path: dir,
        extension: Boolean(manifest?.extension) || existsSync(path.join(dir, "extension", "manifest.json")),
        linked: false,
        repository: manifest?.repository ?? null,
      });
    }
  } catch {
    // no plugins folder yet
  }
  return { targets: out, git, error };
}

/**
 * The folder a thread on `target` works in: `{kind, id, name, folder, place, isNew, extension}`. A store plugin gets
 * your copy first (layr__plugin_edit); without `plugin` a new one is made (an extension: from a small template).
 */
export async function resolveTarget(hub, target) {
  const kind = TARGET_KINDS.includes(target?.kind) ? target.kind : "plugin";
  if (target?.plugin) {
    const { targets } = await listTargets(hub);
    const t = targets.find((x) => x.id === target.plugin);
    if (!t) throw new Error(`No plugin ${target.plugin} (targets_list shows them)`);
    let folder = t.path;
    let place = t.place;
    if (place === "store") {
      const r = await hub.call("layr__plugin_edit", { plugin: t.id });
      folder = r.path;
      place = "changed";
    }
    if (!folder || !existsSync(folder)) throw new Error(`The folder of ${t.name} is gone: ${folder}`);
    return { kind: t.extension ? "extension" : kind, id: t.id, name: t.name, folder, place, isNew: false, extension: t.extension };
  }
  const { id, folder } = newPluginFolder({ id: target?.id, name: target?.name, description: target?.description });
  const name = String(target?.name ?? "").trim() || titleCase(id);
  if (kind === "extension") await scaffoldExtension(hub, { id, name, folder, description: target?.description });
  // Its history starts now (the template, or an empty first commit); Claude's turns are saved into it.
  await initPluginRepo(folder, id).catch((error) => log(`git init in ${folder} failed:`, errorMessage(error)));
  return { kind, id, name, folder, place: "made", isNew: true, extension: kind === "extension" };
}

function titleCase(id) {
  return String(id).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** layr-ext.js: from the running core (the hub's address), else from layr's repository when this runs from it. */
export async function extensionSdk(hub) {
  if (hub?.url) {
    try {
      const res = await fetch(new URL("/_layr/layr-ext.js", hub.url), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const text = await res.text();
        if (text.includes("layr-ext")) return text;
      }
    } catch {
      // an older core, or none: try the repository
    }
  }
  const file = path.resolve(here, "..", "..", "..", "core", "layr_core", "assets", "layr-ext.js");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** A new extension plugin: layr.json with `extension`, a Manifest V3 extension whose service worker connects to layr. */
export async function scaffoldExtension(hub, { id, name, folder, description }) {
  const ext = path.join(folder, "extension");
  mkdirSync(ext, { recursive: true });
  const summary = String(description ?? "").trim().split(/\r?\n/)[0].slice(0, 120) || `${name}, a Chrome extension`;
  const manifest = {
    id,
    name,
    version: "0.1.0",
    description: summary,
    author: "me",
    layr: "^0.1",
    icon: "extension",
    permissions: ["data"],
    extension: "extension",
  };
  writeFileSync(path.join(folder, "layr.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const chrome = {
    manifest_version: 3,
    name,
    version: "0.1.0",
    description: summary,
    background: { service_worker: "background.js", type: "module" },
    permissions: [],
    host_permissions: [],
  };
  writeFileSync(path.join(ext, "manifest.json"), `${JSON.stringify(chrome, null, 2)}\n`);
  writeFileSync(
    path.join(ext, "background.js"),
    `// ${name}: the extension's service worker. layr-ext.js connects it to layr as the plugin "${id}"
// (docs/ARCHITECTURE.md › The extension connection): it can call layr's tools and serve tools of its own.
import layr from "./layr-ext.js";

// Tools agents and plugins can call as ${id}__<name> while the extension runs.
layr.tools.serve({
  ping: {
    description: "Answers that the ${name} extension is running",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ running: true, at: new Date().toISOString() }),
  },
});
`,
  );
  const sdk = await extensionSdk(hub);
  if (sdk) writeFileSync(path.join(ext, "layr-ext.js"), sdk);
  else log("layr-ext.js wasn't found (no core, no repository): the extension's thread is told to fetch it");
  return { folder, extension: ext, sdk: Boolean(sdk) };
}

/** The system prompt of a thread on a plugin or an extension. */
export function targetSystemPrompt({ id, name, folder, place, isNew, extension, hubUrl }) {
  const docs = findDocs();
  const read = docs
    ? [
        `- ${docs.architecture} (the contract: manifest, panel SDK, backends, the MCP hub${extension ? ", and Web panels › Extensions inside plugins / The extension connection" : ""})`,
        docs.plugins ? `- ${docs.plugins} (how to write a plugin, step by step)` : null,
        ...docs.examples.slice(0, 6).map((e) => `- ${e} (an example plugin)`),
      ]
        .filter(Boolean)
        .join("\n")
    : "- (layr's docs were not found on this PC: follow the summary below)";
  const what = extension ? "a Chrome extension inside a layr plugin" : "a layr plugin";
  const intro = isNew
    ? `You are making ${what}. The person you are helping may not program at all: talk in plain words, never assume
they know code, make decisions yourself, and only ask about what they want, not how to build it.
The plugin's id is "${id}" (keep it in layr.json unless the user asks for another).`
    : `You are changing ${what}: "${name}" (id "${id}"). Read its layr.json and files first. Keep what works; talk in
plain words; ask only about what the person wants, not how to build it.`;
  const placeNote = {
    made: "The folder is the plugin's own git repository: layr saves your changes as a version by itself after each turn (the person sees them in My plugins > History and can undo any of them), so don't commit yourself.",
    changed: "This is the person's own copy of a plugin from the store (git branch `mine`): layr runs it from this folder and saves your changes as a version after each turn (My plugins > History, with undo), so don't commit yourself. Store updates are merged into it later: keep changes focused, and keep the id.",
    inside: "This plugin lives inside a bigger git repository: layr doesn't save versions here by itself. Commit only if the person asks, as that repository's own instructions (CLAUDE.md) say.",
  }[place] ?? "";
  const extensionPart = extension
    ? `
## The Chrome extension
layr.json's "extension" names the extension's folder (a normal Manifest V3 extension with its own manifest.json).
layr loads it into every web panel (WebView2, on Windows) and reloads it after each of your turns; to try a change in
the middle of a turn, call \`mcp__layr__layr__extension_reload\` with { "plugin": "${id}" }.
- It talks to layr through \`layr-ext.js\` in its folder (copy it from ${hubUrl ? `${new URL("/_layr/layr-ext.js", hubUrl)}` : "the core's /_layr/layr-ext.js"} when it is missing; don't edit it).
  In the service worker (module): \`import layr from "./layr-ext.js"\`, then \`layr.tools.run(tool, args, {plugin})\`
  uses layr's tools as this plugin (add "plugins:<id>" to layr.json's permissions to call another plugin's tools),
  \`layr.data.get/set\`, \`layr.events.on/emit\`, \`layr.ui.notify(text)\`.
- \`layr.tools.serve({ name: { description, inputSchema, run: async (args) => value } })\` gives agents and plugins
  tools that run in the browser, as \`${id}__<name>\` (for you: \`mcp__layr__${id}__<name>\`, once the extension is
  loaded and connected; a new tool may show from your next turn). Use them to test what you built.
- Content scripts can't reach layr themselves: they message the service worker (chrome.runtime.sendMessage).
- What the extension logs (console.*, uncaught errors, also \`chrome.runtime.sendMessage({__layrLog: [{level, text}]})\`
  from content scripts) and layr's own errors loading it reach layr: read them with
  \`mcp__layr__layr__extension_logs\` { "plugin": "${id}", "level"?: "error", "after"?: <last seq you saw> }, which
  also says whether it is connected and which tools it serves. Check it after a reload instead of guessing.
- Keep versions in step: layr.json "version" and the extension manifest's "version".`
    : "";
  const done = isNew
    ? `## When you are done
1. Check that layr.json${extension ? " and extension/manifest.json are" : " is"} valid JSON and every file named exists.
2. Link the plugin into layr so it appears at once: call \`mcp__layr__layr__packages_link\` with
   { "path": "${folder.replace(/\\/g, "\\\\")}" }. (If you can't, say so: layr links it by itself when your turn ends.)
3. Tell the person in two or three plain sentences what it does and where to find it, and invite them to say what to
   change.`
    : `## When you are done
Say in two or three plain sentences what changed and how to see it (panels show changes when opened again).`;
  return `# ${isNew ? "Making" : "Changing"} ${what}
layr is an app that is an empty frame of panels where every feature is a plugin.
${intro}

Work only inside this folder: ${folder}
${placeNote}

Read these first:
${read}

## The format in short
- \`layr.json\` at the folder's root: { "id", "name", "version", "description", "author", "layr": "^0.1", "icon" (a
  Material icon name), "permissions": ["data", ...], "panels": [{ "id", "title", "page", "icon" }], "commands": [{
  "id", "title", "panel" }], "menus": [{ "menu": "Tools", "command" }]${extension ? `, "extension": "extension"` : ""} }.
- A panel is a plain HTML page shown in a web view. It loads \`<script src="/_layr/layr.js"></script>\` and
  \`<link rel="stylesheet" href="/_layr/layr.css">\`, waits for \`await layr.ready\`, and keeps data with
  \`layr.data.get/set/list\` or \`layr.db.*\`. Use the CSS variables (--bg, --fg, --accent, --border...).
- No internet libraries at runtime: copy any library into the folder. Network access needs "network:<origin>".
- Heavy work (Python, files on the PC) goes in a backend (\`"backend": { "kind": "process", ... }\`, an MCP server on
  stdio); only when the plugin really needs one.
${extensionPart}

${done}`;
}
