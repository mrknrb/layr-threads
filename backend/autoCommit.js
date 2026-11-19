// Commits by themselves (docs/ARCHITECTURE.md > The store > Commits by themselves): after a Claude turn that ended
// well in a plugin's own repository (its git top level has a layr.json: plugin maker folders, an installed plugin's
// `mine` or `merge` worktree, linked plugins that are their own repositories), everything the turn changed is
// committed as "layr (Claude)". The user gets History and Undo on the plugin's page without knowing git. Projects that
// only hold plugins inside a bigger repository are never committed by themselves. 0.3.14: the message ends with the
// trailers `Layr-Thread: <thread id>` and `Layr-Turn: <n>` (the turn's number in its thread, 1-based), so the plugin
// page's History links each commit to the thread and turn that made it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { git } from "./git.js";

export const CLAUDE_AUTHOR = { name: "layr (Claude)", email: "claude@layr.invalid" };
export const LAYR_AUTHOR = { name: "layr", email: "layr@layr.invalid" };

/** `-c` options that make `who` the author and committer of the next commit. */
export function identityArgs(who) {
  return ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`];
}

/** Subject (the prompt's first line, at most 72 characters) and body (Claude's reply, shortened). */
export function commitMessage(prompt, reply) {
  const first = String(prompt ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  let subject = (first ?? "").replace(/\s+/g, " ");
  if (!subject) subject = "Changes by Claude";
  if (subject.length > 72) {
    const cut = subject.slice(0, 71);
    const space = cut.lastIndexOf(" ");
    subject = `${space > 40 ? cut.slice(0, space) : cut}…`;
  }
  let body = String(reply ?? "").trim();
  if (body.length > 1500) body = `${body.slice(0, 1499)}…`;
  return { subject, body };
}

/** The trailer lines naming the thread and turn that made a commit ("" without a thread). */
export function trailerLines({ thread, turn } = {}) {
  if (!thread) return "";
  const lines = [`Layr-Thread: ${thread}`];
  if (Number.isInteger(turn) && turn > 0) lines.push(`Layr-Turn: ${turn}`);
  return lines.join("\n");
}

/** The text of the last user message in a transcript (the turn's prompt). */
export function lastPrompt(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "user" && !e.parent && !e.auto) return e.text ?? "";
  }
  return "";
}

/**
 * Commit everything in `dir`'s repository when it is a plugin's own repository with changes and no unresolved
 * conflicts. Gives `{commit, short, subject, files, top}`, `{skipped, files}` (conflicts left), or null (nothing to
 * do). `thread` and `turn` go into the message as trailers.
 */
export async function autoCommit(dir, { prompt, reply, author = CLAUDE_AUTHOR, thread, turn } = {}) {
  let top;
  try {
    top = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  if (!top || !existsSync(path.join(top, "layr.json"))) return null;
  // Unmerged files that still hold conflict markers are left alone (a resolved file needn't be staged first).
  const unmerged = (await git(top, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split(/\r?\n/).filter(Boolean);
  const unresolved = unmerged.filter((f) => {
    try {
      return /^(<<<<<<< |>>>>>>> |=======$)/m.test(readFileSync(path.join(top, f), "utf8"));
    } catch {
      return true;
    }
  });
  if (unresolved.length) return { skipped: "conflicts", files: unresolved };
  const status = (await git(top, ["status", "--porcelain"])).trim();
  const merging = await git(top, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
  if (!status && !merging) return null;
  await git(top, ["add", "-A"]);
  const { subject, body } = commitMessage(prompt, reply);
  const args = [...identityArgs(author), "commit", "-q", "--no-verify", "-m", subject];
  if (body) args.push("-m", body);
  const trailers = trailerLines({ thread, turn });
  if (trailers) args.push("-m", trailers);
  await git(top, args);
  const commit = (await git(top, ["rev-parse", "HEAD"])).trim();
  return { commit, short: commit.slice(0, 7), subject, files: status ? status.split(/\r?\n/).length : 0, top };
}

/**
 * A new plugin folder becomes a repository whose first commit holds what is there already (an extension's template,
 * else nothing), so Claude's first turn is history.
 */
export async function initPluginRepo(folder, id) {
  if (existsSync(path.join(folder, ".git"))) return false;
  await git(folder, ["init", "-q", "--initial-branch=main"]);
  await git(folder, ["add", "-A"]);
  await git(folder, [...identityArgs(LAYR_AUTHOR), "commit", "-q", "--allow-empty", "--no-verify", "-m", `New plugin ${id}`]);
  return true;
}
