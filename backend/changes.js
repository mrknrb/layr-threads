// What a thread changed where it works, for the Changes drawer of the thread panel: from where its branch left the
// base branch to the files on disk, committed or not, new files included. In the project's own checkout (not a
// worktree), or on the base branch itself, only what isn't committed yet. Also the branch's commits, how far the base
// has moved on, and whether the branch would merge into it cleanly.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** New files bigger than this count as changed files, not by their lines. */
const MAX_NEW_FILE_BYTES = 1024 * 1024;
const MAX_NEW_FILES = 500;
const MAX_COMMITS = 50;
const MAX_DIFF_CHARS = 200_000;
const BASE_NAMES = ["main", "master", "dev", "develop"];

/** Git's output; a failure rejects with {code, stdout} (some commands exit with 1 to say "there were differences"). */
function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout ?? "") }));
      else resolve(String(stdout));
    });
  });
}
const tryGit = (cwd, ...args) => run(cwd, args).catch(() => null);
const gitAnyExit = (cwd, ...args) =>
  run(cwd, args).catch((error) => {
    if (error.code === 1 && typeof error.stdout === "string") return error.stdout;
    throw error;
  });

/**
 * The branch the work leaves from: of what `origin/HEAD` points at, the thread's own start (`hint`, a worktree's
 * base) and the usual base names, the one with the fewest commits the work has and it hasn't (a project whose base
 * is `dev` is measured against `dev`, not `main`).
 */
export async function baseRef(cwd, { hint } = {}) {
  const head = (await tryGit(cwd, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"))?.trim();
  const names = [head?.replace(/^refs\/remotes\//, ""), ...BASE_NAMES.flatMap((n) => [`origin/${n}`, n])];
  let best = null;
  for (const ref of new Set(names)) {
    if (!ref || !(await tryGit(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`))) continue;
    const ahead = Number((await tryGit(cwd, "rev-list", "--count", `${ref}..HEAD`))?.trim());
    if (Number.isFinite(ahead) && (!best || ahead < best.ahead)) best = { ref, ahead };
  }
  // A worktree started from a commit no base name reaches (a branch since deleted): measure from that commit.
  if (!best && hint && (await tryGit(cwd, "rev-parse", "--verify", "--quiet", `${hint}^{commit}`))) return hint;
  return best?.ref ?? null;
}

/**
 * Where the branch left the base: {head, base, fork}; fork null on the base itself or in the project's own checkout
 * (not a worktree): only uncommitted work counts then. Null when it isn't a git checkout with commits.
 */
async function forkOf(cwd, hint) {
  const head = (await tryGit(cwd, "rev-parse", "HEAD"))?.trim();
  if (!head) return null;
  const dirs = (await tryGit(cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"))?.split("\n");
  if (dirs && dirs[0]?.trim() === dirs[1]?.trim()) return { head, base: null, fork: null };
  const base = await baseRef(cwd, { hint });
  const fork = base ? (await tryGit(cwd, "merge-base", "HEAD", base))?.trim() : null;
  return { head, base, fork: fork && fork !== head ? fork : null };
}

/**
 * `git diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename `added\tremoved\t\0from\0to\0`. Binary files say
 * `-` for both: they count as changed files with no lines.
 */
export function parseNumstat(out) {
  const parts = String(out ?? "").split("\0");
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const match = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!match) continue;
    let file = match[3];
    if (!file) {
      file = parts[i + 2] ?? "";
      i += 2;
    }
    rows.push({ path: file, added: Number(match[1]) || 0, removed: Number(match[2]) || 0 });
  }
  return rows;
}

/** Diff rows plus new files git doesn't track yet: {files, added, removed}. */
export function sumChanges(rows, untracked = { files: 0, lines: 0 }) {
  return {
    files: rows.length + untracked.files,
    added: rows.reduce((t, r) => t + r.added, 0) + untracked.lines,
    removed: rows.reduce((t, r) => t + r.removed, 0),
  };
}

/**
 * {branch, base, commits, files, added, removed, uncommitted: {files, added, removed}, list: [{path, added, removed,
 * state: committed|uncommitted|new}], commitList?, behind?, conflicts?}; null when the folder isn't a git checkout.
 */
export async function threadChanges(cwd, { hint } = {}) {
  if ((await tryGit(cwd, "rev-parse", "--is-inside-work-tree"))?.trim() !== "true") return null;
  const at = await forkOf(cwd, hint);
  if (!at) return null;
  const { base, fork } = at;
  const branch = (await tryGit(cwd, "rev-parse", "--abbrev-ref", "HEAD"))?.trim();
  const open = parseNumstat(await run(cwd, ["diff", "--numstat", "-z", "HEAD"]));
  const all = fork ? parseNumstat(await run(cwd, ["diff", "--numstat", "-z", fork])) : open;
  const untracked = (await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const fresh = await Promise.all(untracked.slice(0, MAX_NEW_FILES).map((file) => countLines(path.join(cwd, file))));
  const added = { files: untracked.length, lines: fresh.reduce((t, n) => t + n, 0) };
  const uncommitted = new Set(open.map((r) => r.path));
  const list = [
    ...all.map((r) => ({ ...r, state: uncommitted.has(r.path) ? "uncommitted" : "committed" })),
    ...untracked.map((file, i) => ({ path: file, added: fresh[i] ?? 0, removed: 0, state: "new" })),
  ];
  return {
    branch: !branch || branch === "HEAD" ? null : branch,
    base: fork ? base : null,
    commits: fork ? Number((await run(cwd, ["rev-list", "--count", `${fork}..HEAD`])).trim()) || 0 : 0,
    ...sumChanges(all, added),
    uncommitted: sumChanges(open, added),
    list,
    ...(fork && base ? await branchState(cwd, base, fork) : {}),
  };
}

/** The branch's commits, how many commits the base has that it hasn't, and whether it would merge cleanly. */
async function branchState(cwd, base, fork) {
  const out = await run(cwd, ["log", `-${MAX_COMMITS}`, "--format=%H%x00%s%x00%cI%x00", `${fork}..HEAD`]);
  const commitList = out
    .split("\0\n")
    .map((entry) => entry.replace(/^\n/, "").split("\0"))
    .filter(([sha]) => sha)
    .map(([sha, subject, at]) => ({ sha, subject: subject ?? "", at: at ?? "" }));
  const behind = Number((await run(cwd, ["rev-list", "--count", `HEAD..${base}`])).trim()) || 0;
  // `merge-tree --write-tree` (git 2.38+) merges in memory: exit 1, with the conflicted files after the tree id.
  // Null when git can't tell (an older git).
  const conflicts =
    behind === 0
      ? []
      : await gitAnyExit(cwd, "merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", base).then(
          (text) => text.split("\n").slice(1).map((l) => l.trim()).filter(Boolean),
          () => null,
        );
  return { commitList, behind, conflicts };
}

/** One file's changes as a unified diff, from where the branch left the base (or HEAD) to the file on disk. */
export async function fileDiff(cwd, file, { hint } = {}) {
  if (!file || path.isAbsolute(file) || String(file).split(/[\\/]/).includes("..")) throw new Error("Not a file of the thread");
  const at = await forkOf(cwd, hint);
  const from = at?.fork ?? (at ? "HEAD" : null);
  const tracked = from ? (await run(cwd, ["ls-files", "--", file])).trim() : "";
  const known = from ? (await tryGit(cwd, "cat-file", "-t", `${from}:${file}`))?.trim() : "";
  const diff =
    tracked || known
      ? await run(cwd, ["diff", "--no-color", "--no-ext-diff", from, "--", file])
      : await gitAnyExit(cwd, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file);
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… cut here` : diff;
}

async function countLines(file) {
  try {
    if ((await stat(file)).size > MAX_NEW_FILE_BYTES) return 0;
    const text = await readFile(file);
    if (!text.length || text.includes(0)) return 0; // empty, or binary
    let lines = 0;
    for (const byte of text) if (byte === 10) lines++;
    return text[text.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return 0;
  }
}
