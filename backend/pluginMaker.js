// New plugins made with AI: a folder in ~/layr-plugins for a thread on a new plugin (targets.js), and linking it into
// layr (layr__packages_link) when a turn ends and the folder has a layr.json, so the plugin appears right away and
// changes show on reload.
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
