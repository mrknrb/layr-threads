// What of a turn the thread panel shows, the way T3 Code folds it: a finished turn keeps your message and its final
// reply, and the work in between (tool calls, thinking, replies on the way) folds into one row, "Worked for 3m 12s ·
// 777k tokens in · 2.9k out". Tool calls in a row become one "Read 4 files, ran 2 commands" row. Both open on a
// click; errors, plans, questions and notices always stay in sight. The running turn stays unfolded.
// No DOM here (the unit tests run it in Node): thread.js keeps per turn a list of items {kind}, where kind is
//   tool | thinking (work), text (a reply), end (the turn_end line, with its `entry`), kept (errors, approvals,
//   notices, a steered-in message: never folded).

const WORK = new Set(["tool", "thinking"]);
export const isWork = (item) => WORK.has(item?.kind);

/**
 * What a finished turn folds away: indexes into `items`. Everything before its last reply (replies on the way too),
 * the tool calls after it, and its end line when it ended well (the fold row says the same). Null when there is no
 * work to fold, or the turn hasn't ended.
 */
export function foldTurn(items) {
  const endIndex = items.findIndex((i) => i.kind === "end");
  if (endIndex < 0) return null;
  const end = items[endIndex];
  let replyIndex = -1;
  items.forEach((item, i) => item.kind === "text" && (replyIndex = i));
  const hidden = new Set();
  items.forEach((item, i) => {
    if (i === replyIndex) return;
    if (item.kind === "text" || isWork(item)) hidden.add(i);
  });
  if (!hidden.size) return null;
  if (end.entry?.status === "done") hidden.add(endIndex);
  return { hidden, label: foldLabel(end.entry) };
}

/** "Worked for 3m 12s · 777k tokens in · 2.9k out", "You stopped it after 40s", "Failed after 1m 5s". */
export function foldLabel(end) {
  const took = typeof end?.durationMs === "number" ? elapsed(end.durationMs) : null;
  const head =
    end?.status === "interrupted"
      ? took ? `You stopped it after ${took}` : "You stopped it"
      : end?.status === "failed"
        ? took ? `Failed after ${took}` : "Failed"
        : took ? `Worked for ${took}` : "Worked";
  const used = tokensLabel(end?.usage);
  return used ? `${head} · ${used}` : head;
}

/** "45s", "3m 12s", "1h 5m"; null for a time that can't be read. */
export function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** 777000 → "777k", 2900 → "2.9k", 1.2M → "1.2M". */
export function tokenCount(n) {
  if (!Number.isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${Number((n / 1e6).toFixed(1))}M`;
}

/** A turn's usage (turn_end `usage`) as "777k tokens in · 2.9k out"; "" when it used nothing (a /compact). */
export function tokensLabel(usage) {
  if (!usage) return "";
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (!input && !usage.outputTokens) return "";
  return `${tokenCount(input)} tokens in · ${tokenCount(usage.outputTokens ?? 0)} out`;
}

/** The tooltip of the fold row: how much of what it read came from the cache. */
export function tokensTitle(usage) {
  if (!usage) return "";
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return `This turn read ${input.toLocaleString()} tokens (${(usage.cacheReadTokens ?? 0).toLocaleString()} from the ` +
    `cache) and wrote ${(usage.outputTokens ?? 0).toLocaleString()}`;
}

/**
 * Runs of work (tool calls, thoughts) in `items` become groups: [{type: "item", index}] or [{type: "group", indexes,
 * label}]. A run of one stays an item. `live`: the turn is still going, so the latest work stays out of its group.
 */
export function groupRuns(items, { live = false } = {}) {
  const out = [];
  for (let i = 0; i < items.length; ) {
    let end = i;
    while (end < items.length && isWork(items[end])) end++;
    if (end === i) {
      out.push({ type: "item", index: i });
      i++;
      continue;
    }
    const run = [];
    for (let k = i; k < end; k++) run.push(k);
    const latest = live && end === items.length ? run.pop() : undefined;
    if (run.length > 1) out.push({ type: "group", indexes: run, label: summarize(run.map((k) => items[k])) });
    else for (const k of run) out.push({ type: "item", index: k });
    if (latest !== undefined) out.push({ type: "item", index: latest });
    i = end;
  }
  return out;
}

const ACTION = {
  Read: "read", NotebookRead: "read", Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search", LS: "search", Bash: "command", PowerShell: "command", BashOutput: "command",
  KillShell: "command", WebFetch: "web", WebSearch: "web", Task: "agent", Agent: "agent", TodoWrite: "todo",
};

/** What a work item did: read, edit, search, command, web, agent, todo, think or other. */
export function actionOf(item) {
  if (item.kind === "thinking") return "think";
  return ACTION[item.name] ?? "other";
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const PHRASE = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  command: (n) => `ran ${plural(n, "command", "commands")}`,
  search: (n) => plural(n, "search", "searches"),
  web: (n) => plural(n, "web lookup", "web lookups"),
  agent: (n) => plural(n, "subagent", "subagents"),
  todo: (n) => `updated the todos${n > 1 ? ` ×${n}` : ""}`,
  other: (n) => plural(n, "tool call", "tool calls"),
};

/** Like "Read 4 files, ran 2 commands", in the order they first happened; thoughts alone: "Thought ×3". */
export function summarize(items) {
  const counts = new Map();
  for (const item of items) counts.set(actionOf(item), (counts.get(actionOf(item)) ?? 0) + 1);
  const thoughts = counts.get("think") ?? 0;
  counts.delete("think");
  if (!counts.size) return thoughts === 1 ? "Thought" : `Thought ×${thoughts}`;
  const text = [...counts].map(([action, n]) => PHRASE[action](n)).join(", ");
  return text[0].toUpperCase() + text.slice(1);
}
