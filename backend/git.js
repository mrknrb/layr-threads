// Git worktrees for threads: a new branch in its own folder, so a thread's changes stay apart from the project's
// checkout until the user merges them.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureDir, slugify } from "./util.js";

export function git(cwd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(`git ${args[0]} failed: ${detail}`));
        } else resolve(String(stdout));
      },
    );
  });
}

export async function isGitRepo(dir) {
  try {
    const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(dir) {
  try {
    const out = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = out.trim();
    return name === "HEAD" ? null : name;
  } catch {
    return null;
  }
}

/** `git worktree list --porcelain` as [{path, branch, head, main}]. */
export async function listWorktrees(dir) {
  const out = await git(dir, ["worktree", "list", "--porcelain"]);
  const trees = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: path.resolve(line.slice(9)), branch: null, head: null, main: trees.length === 0 };
      trees.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.branch = null;
  }
  return trees;
}

async function branchExists(dir, branch) {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a worktree on a new branch from the project's current HEAD (or from `baseRef`).
 * Folder: `<worktreesRoot>/<project>-<slug>`, where worktreesRoot is `<project>/../.layr-worktrees` by default.
 */
export async function createWorktree({ projectPath, name, branch, worktreesRoot, baseRef }) {
  if (!(await isGitRepo(projectPath))) {
    throw new Error(`${projectPath} is not a git repository, so it can't get a worktree. Use the project folder instead.`);
  }
  const repoName = path.basename(projectPath);
  const slug = slugify(name, 32) || "thread";
  const root = ensureDir(worktreesRoot || path.join(path.dirname(projectPath), ".layr-worktrees"));
  const wanted = branch ? branch.trim() : `layr/${slug}`;
  if (!/^[\w./-]+$/.test(wanted) || wanted.includes("..")) throw new Error(`Not a valid branch name: ${wanted}`);
  if (branch && (await branchExists(projectPath, wanted))) {
    throw new Error(`The branch ${wanted} already exists. Pick another name, or use its worktree.`);
  }
  const folderFor = (b) => path.join(root, `${repoName}-${slugify(b.replace(/^layr\//, ""), 48) || slug}`);
  // A free branch name and folder: add -2, -3... when taken.
  let candidate = wanted;
  for (let n = 2; (await branchExists(projectPath, candidate)) || existsSync(folderFor(candidate)); n++) {
    candidate = `${wanted}-${n}`;
  }
  const folder = folderFor(candidate);
  // `baseRef`: start from that branch or commit (e.g. the base branch a pipeline lands on) instead of HEAD.
  const from = baseRef ? `${baseRef}^{commit}` : "HEAD";
  const base = (await git(projectPath, ["rev-parse", "--verify", from]).catch(() => "")).trim();
  if (!base && baseRef) throw new Error(`${baseRef} is not a branch or commit of ${projectPath}`);
  if (!base) throw new Error(`${projectPath} has no commits yet, so a worktree can't branch from it.`);
  await git(projectPath, ["worktree", "add", "-b", candidate, folder, base], { timeoutMs: 600_000 });
  return { path: folder, branch: candidate, base };
}

/**
 * Make a removed worktree again in the same `folder` (a Claude session is kept by its folder, so the thread resumes).
 * Its `branch`, when still there and already in the base, moves up to the newest base first (it loses nothing); a
 * branch with work the base lacks keeps it; a branch that's gone is made again from the newest base (`baseRef`, else
 * the project's HEAD). Gives { path, branch, base (the commit it starts on), from (what was taken as the base) }.
 */
export async function restoreWorktree({ projectPath, folder, branch, baseRef }) {
  if (!(await isGitRepo(projectPath))) throw new Error(`${projectPath} is not a git repository: the worktree can't be made again`);
  await git(projectPath, ["worktree", "prune"]).catch(() => {});
  const named = baseRef ? (await git(projectPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]).catch(() => "")).trim() : "";
  const base = named || (await git(projectPath, ["rev-parse", "--verify", "HEAD"])).trim();
  const name = branch || `layr/${slugify(path.basename(folder), 48) || "thread"}`;
  ensureDir(path.dirname(folder));
  if (await branchExists(projectPath, name)) {
    const merged = await git(projectPath, ["merge-base", "--is-ancestor", `refs/heads/${name}`, base]).then(() => true, () => false);
    if (merged) await git(projectPath, ["branch", "-f", name, base]);
    await git(projectPath, ["worktree", "add", folder, name], { timeoutMs: 600_000 });
  } else {
    await git(projectPath, ["worktree", "add", "-b", name, folder, base], { timeoutMs: 600_000 });
  }
  const head = (await git(folder, ["rev-parse", "HEAD"])).trim();
  return { path: folder, branch: name, base: head, from: named ? baseRef : "HEAD" };
}

/** A short summary of a worktree's state: changed files and commits ahead of where it started. */
export async function worktreeStatus(dir, base) {
  const status = await git(dir, ["status", "--porcelain"]).catch(() => "");
  const changed = status.split(/\r?\n/).filter((l) => l.trim()).length;
  let ahead = null;
  if (base) {
    const out = await git(dir, ["rev-list", "--count", `${base}..HEAD`]).catch(() => "");
    ahead = out.trim() ? Number(out.trim()) : null;
  }
  return { changedFiles: changed, commitsAhead: ahead, branch: await currentBranch(dir) };
}
