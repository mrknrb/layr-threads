// Claude Code's global config (`~/.claude.json`) found unreadable. Every Claude Code process rewrites that one file,
// and once in a while it is left empty (0 bytes; seen for minutes on end, so not only a moment's race): every Claude
// Code starting then stops at once with "Configuration error in …\.claude.json: JSON Parse error: Unexpected EOF". The
// engine and `ask` wait and try again (CONFIG_RETRY_MS); the setting `repairConfig` (off by default) also puts Claude
// Code's newest backup back, only while the file is exactly empty, under Claude Code's own lock for the file.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeConfigPath } from "./account.js";

/** How long a thread waits before each try again: 15 s, 30 s, 1, 2 and 4 min (about 8 min in all). */
export const CONFIG_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
/** The file must have stayed empty this long before a repair: a writer in the middle of its write has finished. */
const EMPTY_FOR_MS = 30_000;
/** A backup older than this is not put back by itself: too much may have changed since. */
const BACKUP_MAX_AGE_MS = 24 * 3_600_000;
/** Claude Code's lock for writing the file (a `proper-lockfile` directory, stale after 10 s). */
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 9_000;

/** Whether Claude Code stopped because its global config couldn't be read. */
export function isConfigBroken(text) {
  return /Configuration error in .*\.(claude|config)\.json|configuration file at .* is corrupted/i.test(String(text ?? ""));
}

/** Where Claude Code keeps its backups of the config: `<CLAUDE_CONFIG_DIR or ~/.claude>/backups`. */
export function backupsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "backups");
}

/** The newest backup that is valid, non-empty JSON: {file, at} or null. `maxAgeMs`: none older than that. */
export async function newestBackup({ configPath = claudeConfigPath(), dir = backupsDir(), maxAgeMs = Infinity } = {}) {
  const prefix = `${path.basename(configPath)}.backup.`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const found = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .map((n) => ({ file: path.join(dir, n), at: Number(n.slice(prefix.length)) }))
    .sort((a, b) => b.at - a.at);
  for (const b of found) {
    if (Date.now() - b.at > maxAgeMs) return null;
    try {
      const text = await readFile(b.file, "utf8");
      const data = JSON.parse(text);
      if (data && typeof data === "object" && !Array.isArray(data)) return b;
    } catch {
      // empty or broken: an older one
    }
  }
  return null;
}

/** Whether the config file is there and exactly empty. */
export function configEmpty(configPath = claudeConfigPath()) {
  try {
    return existsSync(configPath) && readFileSync(configPath).length === 0;
  } catch {
    return false;
  }
}

/** What to tell the user: the file, the backup to put back, and the command doing it (or null without a backup). */
export async function restoreHint({ configPath = claudeConfigPath(), dir = backupsDir() } = {}) {
  const backup = await newestBackup({ configPath, dir });
  if (!backup) return { configPath, backup: null, command: null };
  const command = process.platform === "win32"
    ? `Copy-Item -LiteralPath "${backup.file}" -Destination "${configPath}" -Force`
    : `cp "${backup.file}" "${configPath}"`;
  return { configPath, backup: backup.file, command };
}

/**
 * Put Claude Code's newest backup back when the config has stayed exactly empty for EMPTY_FOR_MS. Gives
 * {repaired, why, backup?}. Holds Claude Code's lock for the file, checks again under it that the file is still empty
 * and unchanged, and writes through a temporary file and a rename: a Claude Code writing meanwhile is never undone.
 */
export async function repairEmptyConfig({
  configPath = claudeConfigPath(),
  dir = backupsDir(),
  emptyForMs = EMPTY_FOR_MS,
  maxAgeMs = BACKUP_MAX_AGE_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  const before = await stat(configPath).catch(() => null);
  if (!before) return { repaired: false, why: "there is no config file" };
  if (before.size !== 0) return { repaired: false, why: "the config file is not empty" };
  if (Date.now() - before.mtimeMs < emptyForMs) return { repaired: false, why: "the config file was written just now" };
  const backup = await newestBackup({ configPath, dir, maxAgeMs });
  if (!backup) return { repaired: false, why: "no usable backup from the last 24 hours" };
  const text = await readFile(backup.file, "utf8");
  const release = await lock(`${configPath}.lock`, lockTimeoutMs);
  if (!release) return { repaired: false, why: "Claude Code is writing the config file" };
  try {
    const now = await stat(configPath).catch(() => null);
    if (!now || now.size !== 0 || now.mtimeMs !== before.mtimeMs) return { repaired: false, why: "the config file changed" };
    await writeAtomic(configPath, text);
    return { repaired: true, why: "put back from Claude Code's backup", backup: backup.file };
  } finally {
    await release();
  }
}

/** Claude Code's lock directory, taken (a release function), or null when it stays taken. */
async function lock(dir, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(dir);
      return () => rmdir(dir).catch(() => {});
    } catch (error) {
      if (error?.code !== "EEXIST") return null;
    }
    const held = await stat(dir).catch(() => null);
    if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
      await rmdir(dir).catch(() => {});
      continue;
    }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 250));
  }
}

/** Through a temporary file and a rename; Windows refuses the rename while a reader has the file open, so a few tries. */
async function writeAtomic(file, text) {
  const temp = `${file}.layr-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
        await rm(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
