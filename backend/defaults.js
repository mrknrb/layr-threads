// What "Default model" and "Default effort" stand for in a thread: the `model` and `effortLevel` Claude Code's own
// settings give a folder (the user's `~/.claude/settings.json`, then the folder's `.claude/settings.json`, then its
// `.claude/settings.local.json`, each over the one before; `ANTHROPIC_MODEL` over them all for the model). The panels
// show them next to "Default". Read again at most every few seconds per folder.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FRESH_MS = 5_000;
const cache = new Map(); // folder → {at, value}

function readSettings(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null; // missing or unreadable: nothing from it
  }
}

/** The settings files that count for `cwd`, lowest priority first. */
export function settingsFiles(cwd, env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const files = [path.join(home, "settings.json")];
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  return files;
}

/** `{model, effort}` Claude Code uses in `cwd` when a thread sets neither (null: Claude Code decides). */
export function claudeDefaults(cwd, { env = process.env, now = Date.now(), read = readSettings } = {}) {
  const key = cwd ?? "";
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.value;
  let model = null;
  let effort = null;
  for (const file of settingsFiles(cwd, env)) {
    const s = read(file);
    if (typeof s?.model === "string" && s.model.trim()) model = s.model.trim();
    if (typeof s?.effortLevel === "string" && s.effortLevel.trim()) effort = s.effortLevel.trim();
  }
  if (env.ANTHROPIC_MODEL?.trim()) model = env.ANTHROPIC_MODEL.trim();
  const value = { model, effort };
  cache.set(key, { at: now, value });
  return value;
}

/** For tests: forget what was read. */
export function forgetDefaults() {
  cache.clear();
}
