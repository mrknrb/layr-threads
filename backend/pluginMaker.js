// New plugins made with AI: a folder of its own for a thread on a new plugin (targets.js), and linking it into layr
// (layr__packages_link) when a turn ends and the folder has a layr.json, so the plugin appears right away and changes
// show on reload.
//
// Where that folder is (docs/ARCHITECTURE.md › Where things are on disk): a layr with one folder for each plugin
// starts this backend with LAYR_PACKAGES (its `<home>/packages`), and the new plugin's folder is
// `<LAYR_PACKAGES>/<id>/mine`: a git repository of its own, next to where its versions and history go. An older core
// doesn't set it: there every plugin made here is a folder of `~/layr-plugins` (LAYR_CLAUDE_PLUGINS_DIR in tests), as
// before. A newer core takes those in when it starts (moved.js).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, errorMessage, log, slugify } from "./util.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

/** layr's folder with one folder for each plugin (`<home>/packages`); null on an older core, which has none. */
export function packagesRoot(env = process.env) {
  return env.LAYR_PACKAGES ? path.resolve(env.LAYR_PACKAGES) : null;
}

/**
 * The one folder every plugin made here was in before (`~/layr-plugins`): where an older core still wants them, and
 * where a newer one leaves the folders it can't take in yet (no layr.json). Not made by asking.
 */
export function oldPluginsRoot(env = process.env) {
  if (env.LAYR_CLAUDE_PLUGINS_DIR) return path.resolve(env.LAYR_CLAUDE_PLUGINS_DIR);
  const home = os.homedir();
  if (home) return path.join(home, "layr-plugins");
  return path.resolve(env.LAYR_DATA_DIR || ".", "plugins");
}

/** The folder a plugin of your own with this id is made in: `<packages>/<id>/mine`; `~/layr-plugins/<id>` before. */
export function pluginFolder(id, env = process.env) {
  const packages = packagesRoot(env);
  return packages ? path.join(packages, id, "mine") : path.join(oldPluginsRoot(env), id);
}

/**
 * Is the id taken on this PC? Any folder `<packages>/<id>` takes it (a plugin installed, or uninstalled with its
 * history kept), and so does a folder left in the old place; on an older core only the folder in the old place.
 */
function idTaken(id, env) {
  const packages = packagesRoot(env);
  return (packages !== null && existsSync(path.join(packages, id))) || existsSync(path.join(oldPluginsRoot(env), id));
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

/** A free plugin id and its folder (made), from the name or description. */
export function newPluginFolder({ id, name, description }, env = process.env) {
  let base = slugify(id || name || description, 30) || "my-plugin";
  if (!/^[a-z]/.test(base)) base = `p-${base}`;
  base = base.slice(0, 36).replace(/-+$/, "");
  if (base.length < 2) base = "my-plugin";
  let candidate = base;
  for (let n = 2; idTaken(candidate, env); n++) candidate = `${base}-${n}`;
  return { id: candidate, folder: ensureDir(pluginFolder(candidate, env)) };
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
