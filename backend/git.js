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
 * Make a worktree on a new branch from the project's current HEAD.
 * Folder: `<worktreesRoot>/<project>-<slug>`, where worktreesRoot is `<project>/../.layr-worktrees` by default.
 */
export async function createWorktree({ projectPath, name, branch, worktreesRoot }) {
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
  const base = (await git(projectPath, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!base) throw new Error(`${projectPath} has no commits yet, so a worktree can't branch from it.`);
  await git(projectPath, ["worktree", "add", "-b", candidate, folder, base], { timeoutMs: 600_000 });
  return { path: folder, branch: candidate, base };
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
