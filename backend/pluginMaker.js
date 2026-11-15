// "Make a plugin with AI": a thread in a new folder that writes a layr plugin from a plain-words description, for
// people who don't program. When a turn ends and the folder has a layr.json, the backend links the folder into layr
// (layr__packages_link), so the plugin appears right away and changes show on reload.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, errorMessage, log, slugify } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

export function pluginsRoot() {
  if (process.env.LAYR_CLAUDE_PLUGINS_DIR) return ensureDir(process.env.LAYR_CLAUDE_PLUGINS_DIR);
  const home = os.homedir();
  if (home) return ensureDir(path.join(home, "layr-plugins"));
  return ensureDir(path.join(process.env.LAYR_DATA_DIR || ".", "plugins"));
}

/** Where layr's docs and first-party plugins are, when this plugin runs from the layr repository. */
export function findDocs() {
  const candidates = [process.env.LAYR_DOCS_DIR, path.resolve(pluginDir, "..", "..", "docs")].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "ARCHITECTURE.md"))) {
      const repo = path.dirname(dir);
      const plugins = path.join(repo, "plugins");
      const examples = existsSync(plugins)
        ? readdirSync(plugins, { withFileTypes: true })
            .filter((d) => d.isDirectory() && existsSync(path.join(plugins, d.name, "layr.json")))
            .map((d) => path.join(plugins, d.name))
        : [];
      return {
        architecture: path.join(dir, "ARCHITECTURE.md"),
        plugins: existsSync(path.join(dir, "PLUGINS.md")) ? path.join(dir, "PLUGINS.md") : null,
        design: existsSync(path.join(dir, "DESIGN.md")) ? path.join(dir, "DESIGN.md") : null,
        examples,
      };
    }
  }
  return null;
}

/** A free plugin id and its folder, from the name or description. */
export function newPluginFolder({ id, name, description }) {
  const root = pluginsRoot();
  let base = slugify(id || name || description, 30) || "my-plugin";
  if (!/^[a-z]/.test(base)) base = `p-${base}`;
  base = base.slice(0, 36).replace(/-+$/, "");
  if (base.length < 2) base = "my-plugin";
  let candidate = base;
  for (let n = 2; existsSync(path.join(root, candidate)); n++) candidate = `${base}-${n}`;
  const folder = ensureDir(path.join(root, candidate));
  return { id: candidate, folder, root };
}

export function pluginSystemPrompt({ id, folder }) {
  const docs = findDocs();
  const read = docs
    ? [
        `- ${docs.architecture} (the contract: manifest, panel SDK, backends, the MCP hub)`,
        docs.plugins ? `- ${docs.plugins} (how to write a plugin, step by step)` : null,
        ...docs.examples.slice(0, 8).map((e) => `- ${e} (an example plugin)`),
      ]
        .filter(Boolean)
        .join("\n")
    : "- (layr's docs were not found on this PC: follow the summary below)";
  return `# Making a layr plugin
You are making a plugin for layr, an app that is an empty frame of panels where every feature is a plugin. The
person you are helping may not program at all (for example a biologist): talk in plain words, never assume they
know code, make decisions yourself, and only ask about what they want, not how to build it.

Work only inside this folder: ${folder}
The plugin's id is "${id}" (use it in layr.json, unless the user asks for another name).

Read these first:
${read}

## The format in short
- \`layr.json\` at the folder's root: { "id", "name", "version": "0.1.0", "description", "author", "layr": "^0.1",
  "icon" (a Material icon name), "permissions": ["data", ...], "panels": [{ "id", "title", "page", "icon" }],
  "commands": [{ "id", "title", "panel" }], "menus": [{ "menu": "Tools", "command" }] }.
- A panel is a plain HTML page (\`panels/main.html\`) shown in a web view. It loads the SDK with
  \`<script src="/_layr/layr.js"></script>\` and \`<link rel="stylesheet" href="/_layr/layr.css">\`, waits for
  \`await layr.ready\`, and keeps its data with \`layr.data.get/set/list\` or \`layr.db.insert/list/update/delete\`.
  Use the CSS variables (--bg, --fg, --accent, --border...) so it fits light and dark themes.
- No internet libraries at runtime: copy any library into the folder (no CDN links). Network access needs a
  "network:<origin>" permission.
- Heavy work (Python analyses, files on the PC) goes in a backend: \`"backend": { "kind": "process", "runtime":
  "python", "entry": "backend/server.py" }\` with a pyproject.toml, an MCP server on stdio (the official \`mcp\`
  package). Its tools are called from panels with \`layr.tools.call(name, args)\`. Add "pc" to permissions and needs.
  Only add a backend when the plugin really needs one.

The folder is a git repository: layr saves your changes as a version by itself after each turn (the person sees
them in My plugins > History and can undo any of them), so don't commit yourself.

## When you are done
1. Check that layr.json is valid JSON and every file it names exists.
2. Link the plugin into layr so it appears at once: call the tool \`mcp__layr__layr__packages_link\` with
   { "path": "${folder.replace(/\\/g, "\\\\")}" }. (If you can't, say so: layr links it by itself when your turn
   ends.)
3. Tell the person in two or three plain sentences what the plugin does and where to find it (its menu or command),
   and invite them to say what to change.`;
}

/** Link the folder into layr when it holds a valid layr.json. Returns the plugin info, or null. */
export async function linkIfReady(hub, folder) {
  const manifest = path.join(folder, "layr.json");
  if (!existsSync(manifest)) return null;
  try {
    JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    log(`layr.json in ${folder} is not valid JSON yet:`, errorMessage(error));
    return null;
  }
  if (!hub.available) return null;
  return hub.linkPackage(folder);
}
