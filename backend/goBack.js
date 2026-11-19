// Going back in a thread: the chat and Claude's memory of it are cut back to just before one of your messages; files
// stay as they are. Claude Code can resume a session up to any entry of its chain and fork it from there
// (`resumeSessionAt` + `forkSession`); this finds that entry, the one before your message, in Claude Code's own
// transcript of the session (~/.claude/projects/<folder>/<session>.jsonl), so it works for any message the session
// still has, also ones sent before layr knew how to go back.
import { existsSync, readFileSync } from "node:fs";

/** The lines of a Claude Code session transcript, parsed; a line cut by a crash is skipped. */
export function readSessionFile(file) {
  if (!existsSync(file)) return null;
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return out;
}

/** The session's main conversation, oldest first: from its newest entry back along the parents (across compactions). */
export function mainChain(lines) {
  const byId = new Map();
  let leaf = null;
  for (const e of lines) {
    if (!e?.uuid) continue;
    byId.set(e.uuid, e);
    if ((e.type === "user" || e.type === "assistant") && !e.isSidechain) leaf = e;
  }
  const chain = [];
  const seen = new Set();
  for (let e = leaf; e && !seen.has(e.uuid); ) {
    seen.add(e.uuid);
    chain.push(e);
    e = byId.get(e.parentUuid ?? e.logicalParentUuid);
  }
  return chain.reverse();
}

/** A prompt the user (or layr for them) sent: a user entry that is not a tool result nor Claude Code's own. */
function isPrompt(e) {
  if (e.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary) return false;
  const c = e.message?.content;
  return typeof c === "string" || (Array.isArray(c) && !c.some((b) => b?.type === "tool_result"));
}

/** A prompt's text as layr sent it: the last text block, without the note about lost background tasks in front. */
export function promptText(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.filter((b) => b?.type === "text").at(-1)?.text ?? "";
  return text.replace(/^\[layr: these background tasks of yours[\s\S]*?\]\n\n/, "");
}

function hasImage(content) {
  return Array.isArray(content) && content.some((b) => b?.type === "image");
}

/** Whether a session prompt is the layr transcript's user entry `entry`. */
export function matches(prompt, entry) {
  const content = prompt.message?.content;
  const sent = promptText(content).trim();
  const text = String(entry.text ?? "").trim();
  if (!text) return hasImage(content);
  if (sent.startsWith(text)) return true;
  // A slash command: Claude Code keeps it expanded, with its name in a tag.
  const command = /^\/(\S+)/.exec(text)?.[1];
  return Boolean(command) && sent.includes(`<command-name>/${command}</command-name>`);
}

/** Whether the session prompt of the layr entry `u` would match `target` too (so counting from the end skips it). */
function sameStart(u, target) {
  const text = String(target.text ?? "").trim();
  const other = String(u.text ?? "").trim();
  if (!text) return Boolean(u.images?.length);
  if (other.startsWith(text)) return true;
  const command = /^\/(\S+)/.exec(text)?.[1];
  return Boolean(command) && other.split(/\s/)[0] === `/${command}`;
}

/**
 * Where to go back to for the user entry `target`, given the layr transcript's user entries (`users`, oldest first) and
 * the session transcript's lines: `{ at }`, the chain entry right before that message, or `{ fresh: true }` when it
 * started the session; null when the session doesn't have it (it started over since, or it was never sent).
 * Identical messages are told apart by counting from the end: the third-last "go on" is the third-last in both.
 */
export function findForkPoint(lines, users, target) {
  let skip = users.filter((u) => u.seq > target.seq && sameStart(u, target)).length;
  const chain = mainChain(lines ?? []);
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    if (!isPrompt(e) || !matches(e, target)) continue;
    if (skip-- > 0) continue;
    return e.parentUuid ? { at: e.parentUuid } : { fresh: true };
  }
  return null;
}
