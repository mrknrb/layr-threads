// The thread panel: one Claude Code conversation, live. Loads the transcript with thread_transcript, then follows
// the claude:thread.<id> events (entries, text deltas, status). Each turn (your message and what followed) is a block
// of its own: a finished one folds its work into one row (folds.js), replies in the boxes format get boxes with
// answers to pick (replies.js), and a thread that is a pipeline task gets the task's strip, with Send, answers and Stop
// going through the pipeline (pipeline.js).
import { answerPrefix, hasPicks, pickIn, questionsOf, toggleAgree } from "./boxes.js";
import {
  STATUS_LABEL,
  call,
  effortOptions,
  fillSelect,
  h,
  icon,
  modelOptions,
  money,
  notify,
  on,
  permissionOptions,
  readImage,
  ready,
  relTime,
  tokens,
} from "./common.js";
import { createDraftStore } from "./drafts.js";
import { foldTurn, groupRuns, isWork, tokensTitle } from "./folds.js";
import { renderTaskStrip } from "./pipeline.js";
import { prototypeEmbeds } from "./prototypes.js";
import { markdown, setMarkdownHooks, toolIcon, toolInputView, toolLabel, toolSummary } from "./render.js";
import { renderReply } from "./replies.js";
import {
  adoptThread,
  contextMenu,
  copyText,
  onPhone,
  openFolderOnPc,
  ToolFailed,
  openLink,
  pipelineCall,
  pluginCall,
  threadLink,
  threadTask,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const scroller = $("scroller");
const input = $("input");

const state = {
  id: null,
  thread: null,
  models: [],
  lastSeq: 0,
  firstSeq: null,
  more: false,
  pending: new Set(),
  tools: new Map(), // toolUseId → {el, state, body, children, name}
  approvals: new Map(), // requestId → {el, entry}
  answered: new Map(), // requestId → answer entry
  live: new Map(), // stream key → {el, text, block}
  attachments: [],
  loaded: false,
  buffered: [],
  turnStartedAt: null,
  titleSet: false,
  /** The latest top-level reply: {entry, holder, sections}; its questions can be answered. */
  latest: null,
  /** Answers picked in the latest reply: {replyId, picked} (boxes.js picks). */
  picks: { replyId: null, picked: {} },
  /** Half-filled answers to pending questions: {[requestId]: {[question index]: {picked, own}}}. */
  answers: {},
  /** The pipeline task of this thread: undefined (no pipeline), null (not a task) or the task. */
  task: undefined,
  changes: null,
  commands: null,
  phone: false,
};

// ------------------------------------------------------------------ start

const layr = await ready();
state.id = layr.info?.params?.thread ?? layr.info?.state?.thread ?? new URLSearchParams(location.search).get("thread");
if (!state.id) {
  log.replaceChildren(h("div", { class: "empty" }, "No thread to show. Open one from Claude threads."));
  throw new Error("no thread");
}
layr.panel.setState({ thread: state.id });
state.phone = onPhone();
$("attach").append(icon("image"));
$("more").append(icon("more", 16));
const drafts = createDraftStore(layr.data);
setMarkdownHooks({
  openLink,
  run: state.phone ? null : async ({ shell, command }, btn) => {
    btn.disabled = true;
    try {
      await call("run_in_terminal", { thread: state.id, shell, command, at: Date.now() });
      btn.textContent = "✓ Opened";
      setTimeout(() => (btn.textContent = "▶ Run"), 1500);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      btn.disabled = false;
    }
  },
});

on(`claude:thread.${state.id}`, (ev) => {
  if (!state.loaded) state.buffered.push(ev);
  else handleEvent(ev);
});
on("pipeline:changed", () => void refreshTask());

// ------------------------------------------------------------------ loading

async function loadTranscript() {
  try {
    const r = await call("thread_transcript", { thread: state.id, limit: 1500 });
    log.replaceChildren();
    main.turns = [];
    state.more = r.more;
    state.pending = new Set(r.pending ?? []);
    if (r.more) log.append(loadMoreButton());
    for (const e of r.entries) addEntry(e);
    state.firstSeq = r.entries[0]?.seq ?? null;
    setThread(r.thread);
    state.loaded = true;
    for (const ev of state.buffered.splice(0)) handleEvent(ev);
    refreshApprovals();
    renderLatest();
    scrollToBottom(true);
  } catch (error) {
    log.replaceChildren(h("div", { class: "error-box" }, `Could not load the thread: ${error.message}`));
  }
}

function loadMoreButton() {
  const btn = h("button", { class: "btn small load-more" }, "Show earlier messages");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const r = await call("thread_transcript", { thread: state.id, limit: 500, before: state.firstSeq });
    const height = scroller.scrollHeight;
    // Render the older entries into a holder of their own turns, then move them in front of what is shown.
    const older = { container: h("div"), turns: [] };
    for (const e of r.entries) addEntry(e, { into: older });
    btn.remove();
    log.prepend(...(r.more ? [btn] : []), ...older.container.childNodes);
    main.turns.unshift(...older.turns);
    state.firstSeq = r.entries[0]?.seq ?? state.firstSeq;
    btn.disabled = false;
    scroller.scrollTop = scroller.scrollHeight - height;
  });
  return btn;
}

// ------------------------------------------------------------------ events

function handleEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  if (ev.kind === "entry" && ev.entry) {
    if (ev.entry.seq <= state.lastSeq) return;
    if (ev.entry.seq > state.lastSeq + 1 && state.lastSeq > 0) {
      void fillGap(ev.entry.seq);
      return;
    }
    const near = isNearBottom();
    addEntry(ev.entry);
    renderLatest();
    if (near) scrollToBottom();
  } else if (ev.kind === "delta") {
    const near = isNearBottom();
    for (const d of ev.deltas ?? []) addDelta(d);
    if (near) scrollToBottom();
  } else if (ev.kind === "status" && ev.thread) {
    setThread(ev.thread);
  }
}

let filling = false;
async function fillGap() {
  if (filling) return;
  filling = true;
  try {
    const r = await call("thread_transcript", { thread: state.id, after: state.lastSeq, limit: 5000 });
    for (const e of r.entries) if (e.seq > state.lastSeq) addEntry(e);
    state.pending = new Set(r.pending ?? []);
    setThread(r.thread);
    refreshApprovals();
    renderLatest();
    scrollToBottom();
  } finally {
    filling = false;
  }
}

// ------------------------------------------------------------------ turns

/** Where entries go: the log and its turns, or (Show earlier messages) a holder of older turns. */
const main = { container: log, turns: [] };

/** A turn: your message and what followed, up to your next one. */
function newTurn(into, userEl) {
  const turn = { el: h("div", { class: "turn" }), user: userEl, items: [], ended: false, open: false, groupsOpen: new Set(), foldRow: null };
  if (userEl) turn.el.append(userEl);
  into.container.append(turn.el);
  into.turns.push(turn);
  return turn;
}

function currentTurn(into) {
  return into.turns.at(-1) ?? newTurn(into, null);
}

/** Add an item ({kind, name?, entry, el}) to the turn; in a running turn a run of finished work before it groups. */
function addItem(turn, item) {
  if (!turn.ended && !isWork(item) && item.kind !== "end") wrapRun(turn);
  turn.items.push(item);
  turn.el.append(item.el);
}

/** The work items right before the end of the running turn, two or more, go into one group in place. */
function wrapRun(turn) {
  let start = turn.items.length;
  while (start > 0 && isWork(turn.items[start - 1]) && !turn.items[start - 1].grouped) start--;
  const run = turn.items.slice(start);
  if (run.length < 2 || run.some((i) => i.el.classList?.contains("needs-you"))) return;
  const [row] = groupRuns(run);
  if (row?.type !== "group") return;
  const marker = document.createComment("");
  run[0].el.before(marker);
  marker.replaceWith(groupEl(turn, run, row.label));
  for (const i of run) i.grouped = true;
}

function groupEl(turn, items, label) {
  const key = items[0].entry?.seq ?? items[0].entry?.id;
  const chev = icon("chevron", 13);
  chev.classList.add("chev");
  const det = h("details", { class: "group", open: turn.groupsOpen.has(key) },
    h("summary", {}, chev, icon("tool", 13), h("span", { class: "label" }, label), h("span", { class: "count muted" }, `${items.length}`)));
  det.addEventListener("toggle", () => (det.open ? turn.groupsOpen.add(key) : turn.groupsOpen.delete(key)));
  const body = h("div", { class: "group-body" });
  for (const i of items) body.append(i.el);
  det.append(body);
  return det;
}

/** Lay a finished turn out again: folded (only what stays, behind one row) or open, runs of work grouped. */
function arrange(turn) {
  const fold = foldTurn(turn.items);
  if (!fold) {
    turn.foldRow?.remove();
    turn.foldRow = null;
  } else {
    const chev = icon("chevron", 13);
    chev.classList.add("chev");
    const end = turn.items.find((i) => i.kind === "end")?.entry;
    turn.foldRow = h("button", { class: `fold-row${turn.open ? " open" : ""} ${end?.status ?? ""}`, title: tokensTitle(end?.usage) },
      chev, h("span", {}, fold.label), h("span", { class: "muted" }, turn.open ? "hide the work" : `${fold.hidden.size} steps`));
    turn.foldRow.addEventListener("click", () => {
      turn.open = !turn.open;
      arrange(turn);
    });
  }
  const visible = turn.items.filter((_, i) => !fold || turn.open || !fold.hidden.has(i));
  const rows = groupRuns(visible).map((r) => (r.type === "item" ? visible[r.index].el : groupEl(turn, r.indexes.map((k) => visible[k]), r.label)));
  for (const i of turn.items) i.grouped = true;
  turn.el.replaceChildren(...[turn.user, turn.foldRow, ...rows].filter(Boolean));
  turn.el.classList.toggle("folded", Boolean(fold) && !turn.open);
}

// ------------------------------------------------------------------ entries

function addEntry(e, { into = main } = {}) {
  if (into === main) state.lastSeq = Math.max(state.lastSeq, e.seq);
  const parentCard = e.parent ? state.tools.get(e.parent) : null;
  if (parentCard && !parentCard.hidden) return addChild(parentCard, e);
  const kept = (el) => el && addItem(currentTurn(into), { kind: "kept", entry: e, el });
  switch (e.type) {
    case "created":
      return kept(h("div", { class: "sys" }, `Started in ${e.workspace?.kind === "worktree" ? `worktree ${e.workspace.branch}` : e.workspace?.path ?? ""}`));
    case "user":
      if (e.steer) return kept(userBubble(e));
      return newTurn(into, userBubble(e));
    case "turn_start":
      state.turnStartedAt = Date.parse(e.ts);
      return null;
    case "text": {
      const el = replyHolder(e);
      const liveBlock = state.live.get(e.id);
      const turn = currentTurn(into);
      if (liveBlock) {
        state.live.delete(e.id);
        liveBlock.el.remove();
      }
      addItem(turn, { kind: "text", entry: e, el });
      if (into === main) setLatest(e, el);
      return el;
    }
    case "thinking": {
      const liveBlock = state.live.get(e.id);
      const el = thinkingBlock(e.text, false);
      if (liveBlock) {
        el.open = liveBlock.el.open;
        liveBlock.el.remove();
        state.live.delete(e.id);
      }
      addItem(currentTurn(into), { kind: "thinking", entry: e, el });
      return el;
    }
    case "tool_use":
      if (e.name === "AskUserQuestion" || e.name === "ExitPlanMode") {
        state.tools.set(e.id, { hidden: true, name: e.name });
        return null;
      }
      return addItem(currentTurn(into), { kind: "tool", name: e.name, entry: e, el: toolCard(e) });
    case "tool_result": {
      const card = state.tools.get(e.id);
      if (!card || card.hidden) return null;
      setToolResult(card, e);
      return null;
    }
    case "approval":
      return addApproval(e, (el) => kept(el));
    case "approval_answer":
      state.answered.set(e.requestId, e);
      state.pending.delete(e.requestId);
      delete state.answers[e.requestId];
      renderApproval(e.requestId);
      return null;
    case "turn_end": {
      if (into === main) clearLive();
      state.turnStartedAt = null;
      for (const card of state.tools.values()) if (card.state && !card.done) markToolUnfinished(card);
      const turn = currentTurn(into);
      turn.items.push({ kind: "end", entry: e, el: turnEnd(e) });
      turn.ended = true;
      turn.el.dataset.ended = e.status;
      arrange(turn);
      if (into === main) {
        scheduleChanges();
        if (state.loaded) scheduleConcepts();
        if (!state.commandsKnown) state.commands = null;
      }
      return null;
    }
    case "system":
      if (e.subtype === "init") {
        if (!e.failedMcp?.length) return null;
        return kept(h("div", { class: "sys warn" }, `Could not connect: ${e.failedMcp.join(", ")}`));
      }
      return kept(h("div", { class: `sys${e.subtype === "background_lost" ? " warn" : ""}` }, e.text));
    case "error":
      return kept(h("div", { class: "error-box" }, e.message));
    default:
      return null;
  }
}

/** Entries of a subagent go inside its Task card. */
function addChild(card, e) {
  const put = (el) => {
    card.children.hidden = false;
    card.children.append(el);
    return el;
  };
  switch (e.type) {
    case "text":
      return put(h("div", { class: "msg-text" }, markdown(e.text)));
    case "thinking":
      return put(thinkingBlock(e.text, false));
    case "tool_use":
      if (e.name === "AskUserQuestion" || e.name === "ExitPlanMode") return state.tools.set(e.id, { hidden: true, name: e.name });
      return put(toolCard(e));
    case "tool_result": {
      const c = state.tools.get(e.id);
      if (c && !c.hidden) setToolResult(c, e);
      return null;
    }
    case "approval":
      return addApproval(e, put);
    case "error":
      return put(h("div", { class: "error-box" }, e.message));
    default:
      return null;
  }
}

/** "14:05", the full date on hover. */
function when(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date().toDateString() === d.toDateString();
  const text = today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return h("time", { class: "when", datetime: iso, title: d.toLocaleString([], { dateStyle: "full", timeStyle: "medium" }) }, text);
}

function userBubble(e) {
  // Sent by layr, not you: a turn cut off by a restart of the Claude engine, picked up again.
  if (e.auto === "restart") {
    return h("div", { class: "user-wrap" }, h("div", { class: "msg-user auto", title: e.text },
      icon("refresh", 13), "Picked up again after the Claude engine restarted"), when(e.ts));
  }
  const el = h("div", { class: `msg-user${e.steer ? " steer" : ""}` });
  if (e.images?.length) {
    const imgs = h("div", { class: "imgs" });
    for (const img of e.images) {
      const tag = h("img", { alt: "attached image" });
      call("attachment_read", { thread: state.id, name: img.name })
        .then((r) => (tag.src = `data:${r.mediaType};base64,${r.data}`))
        .catch(() => (tag.alt = "image not found"));
      tag.addEventListener("click", () => showImage(tag.src));
      imgs.append(tag);
    }
    el.append(imgs);
  }
  if (e.text) el.append(e.text);
  return h("div", { class: "user-wrap" }, el, when(e.ts));
}

/**
 * A reply: boxes or Markdown, the prototypes it links to (live, prototypes.js), its time. The latest one is drawn
 * again with its answers pickable: only its text, so the prototypes' pages don't start over.
 */
function replyHolder(e) {
  const holder = h("div", { class: "msg-text" });
  const { el, sections } = renderReply(e.text);
  const body = h("div", { class: "reply-body" }, el);
  holder.append(...[body, prototypeEmbeds(e.text), when(e.ts)].filter(Boolean));
  holder.reply = { entry: e, sections, body };
  return holder;
}

function setLatest(e, holder) {
  const prev = state.latest;
  state.latest = { entry: e, holder, sections: holder.reply.sections };
  // The previous latest reply's questions can't be answered any more.
  if (prev && prev.holder !== holder && questionsOf(prev.sections).length) drawReply(prev, null);
  if (state.picks.replyId !== e.id) {
    const had = hasPicks(state.picks.picked);
    state.picks = { replyId: e.id, picked: {} };
    if (had && state.loaded) saveDraft();
  }
}

/** Draw the latest reply with its answers pickable (when it has questions), and the composer's prefix. */
function renderLatest() {
  const l = state.latest;
  if (l && questionsOf(l.sections).length) drawReply(l, picker());
  renderPrefix();
}

function drawReply(l, pick) {
  const { el } = renderReply(l.entry.text, pick);
  l.holder.reply.body.replaceChildren(el);
}

function picker() {
  return {
    picked: state.picks.picked,
    onPick: (q, letter) => {
      state.picks.picked = pickIn(state.picks.picked, q, letter);
      afterPick();
    },
    onAgree: () => {
      state.picks.picked = toggleAgree(state.picks.picked);
      afterPick();
    },
  };
}

function afterPick() {
  renderLatest();
  saveDraft();
  input.focus();
}

/** What the next message starts with: "I agree with everything recommended" or "My answers: …". */
function currentPrefix() {
  const l = state.latest;
  if (!l || state.picks.replyId !== l.entry.id) return "";
  return answerPrefix(questionsOf(l.sections), state.picks.picked);
}

function renderPrefix() {
  const el = $("prefix");
  const text = currentPrefix();
  el.hidden = !text;
  if (!text) return el.replaceChildren();
  const clear = h("button", { class: "btn ghost small icon-only", title: "Clear the picked answers" }, icon("x", 12));
  clear.addEventListener("click", () => {
    state.picks.picked = {};
    afterPick();
  });
  el.replaceChildren(h("span", { class: "label" }, "Sent first:"), h("span", { class: "text" }, text), clear);
}

function thinkingBlock(text, live) {
  const el = h("details", { class: `thinking${live ? " live" : ""}` },
    h("summary", {}, icon("chevron", 13), icon("brain", 14), h("span", { class: "label" }, live ? "Thinking" : "Thought")),
  );
  el.querySelector(".icon").classList.add("chev");
  el.append(markdown(text));
  return el;
}

function addDelta(d) {
  let block = state.live.get(d.key);
  if (!block) {
    const el = d.block === "thinking" ? thinkingBlock("", true) : h("div", { class: "msg-text live" });
    block = { el, text: "", block: d.block, rendered: 0 };
    state.live.set(d.key, block);
    currentTurn(main).el.append(el);
  }
  block.text += d.text;
  // Re-render the Markdown at most every 80 ms.
  if (!block.timer) {
    block.timer = setTimeout(() => {
      block.timer = null;
      const md = markdown(block.text);
      if (block.block === "thinking") block.el.querySelector(".md")?.replaceWith(md);
      else block.el.replaceChildren(md);
      if (isNearBottom(200)) scrollToBottom();
    }, 80);
  }
}

function clearLive() {
  for (const block of state.live.values()) {
    clearTimeout(block.timer);
    if (block.block !== "thinking") {
      block.el.classList.remove("live");
      block.el.replaceChildren(markdown(block.text));
    } else block.el.classList.remove("live");
  }
  state.live.clear();
}

function toolCard(e) {
  const stateEl = h("span", { class: "state" }, h("span", { class: "spinner" }));
  const chev = icon("chevron", 13);
  chev.classList.add("chev");
  const summary = toolSummary(e.name, e.input);
  const el = h("details", { class: "tool" },
    h("summary", {}, chev, toolIcon(e.name), h("span", { class: "name" }, toolLabel(e.name)),
      h("span", { class: "sum", title: summary }, summary), stateEl),
  );
  const body = h("div", { class: "body" });
  const children = h("div", { class: "children" });
  children.hidden = true;
  if (e.name === "TodoWrite" && Array.isArray(e.input?.todos)) {
    body.append(todoList(e.input.todos));
    el.open = true;
  } else {
    const view = toolInputView(e.name, e.input);
    if (view) body.append(view);
  }
  body.append(children);
  el.append(body);
  const card = { el, state: stateEl, body, children, name: e.name, done: false, id: e.id };
  state.tools.set(e.id, card);
  return el;
}

function setToolResult(card, e) {
  card.done = true;
  card.state.className = `state ${e.isError ? "err" : "ok"}`;
  card.state.replaceChildren(icon(e.isError ? "x" : "check", 14));
  if (card.name === "TodoWrite") return;
  const text = e.content ?? "";
  if (!text && !e.images) return;
  const pre = h("pre", { class: `block${e.isError ? " error" : ""}` }, text ? prettyJson(text) : `[${e.images} image(s)]`);
  card.body.insertBefore(h("div", {}, h("div", { class: "label" }, e.isError ? "Error" : "Result"), pre), card.children);
  if (e.isError) card.el.open = true;
}

/** Tool results that are one JSON value read better indented. */
function prettyJson(text) {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("[")) || t.length > 50_000) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

function markToolUnfinished(card) {
  card.done = true;
  card.state.className = "state";
  card.state.replaceChildren(h("span", { class: "muted", style: { fontSize: "11px" } }, "not run"));
}

function todoList(todos) {
  return h("ul", { class: "todo-list" },
    todos.map((t) => h("li", { class: t.status }, h("span", { class: "box" }, t.status === "completed" ? icon("check", 11) : null),
      h("span", {}, t.status === "in_progress" && t.activeForm ? t.activeForm : t.content))));
}

function turnEnd(e) {
  const bits = [];
  if (e.status === "done") bits.push("Done");
  else if (e.status === "interrupted") bits.push("Stopped");
  else bits.push(`Failed${e.error ? `: ${e.error}` : ""}`);
  if (e.durationMs) bits.push(duration(e.durationMs));
  if (typeof e.costUsd === "number" && e.costUsd > 0) bits.push(money(e.costUsd));
  if (e.usage?.outputTokens) bits.push(`${tokens(e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens)} in · ${tokens(e.usage.outputTokens)} out`);
  return h("div", { class: `turn-end ${e.status}` }, icon(e.status === "done" ? "check" : e.status === "failed" ? "x" : "stop", 13), bits.join(" · "));
}

function duration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ------------------------------------------------------------------ approvals

function addApproval(e, put) {
  const card = e.toolUseId ? state.tools.get(e.toolUseId) : null;
  const holder = h("div");
  state.approvals.set(e.requestId, { el: holder, entry: e, inline: Boolean(card && !card.hidden) });
  if (card && !card.hidden) {
    card.body.append(holder);
    card.el.open = true;
  } else put(holder);
  renderApproval(e.requestId);
  return holder;
}

function refreshApprovals() {
  for (const id of state.approvals.keys()) renderApproval(id);
}

function renderApproval(requestId) {
  const a = state.approvals.get(requestId);
  if (!a) return;
  const e = a.entry;
  const answer = state.answered.get(requestId);
  const card = e.toolUseId ? state.tools.get(e.toolUseId) : null;
  const open = !answer && state.pending.has(requestId);
  card?.el?.classList.toggle("needs-you", open);
  if (answer || !open) {
    const decision = answer?.decision ?? "expired";
    const text =
      decision === "allow"
        ? e.kind === "question" ? `${e.questions?.length === 1 ? `${e.questions[0].question} → ` : "Answered: "}${formatAnswers(answer.answers)}` : e.kind === "plan" ? "Plan approved" : "Allowed"
        : decision === "allow_always" ? "Allowed for this thread"
          : decision === "deny" ? `${e.kind === "plan" ? "Kept planning" : answer.reason === "cancelled" ? "Cancelled" : "Denied"}${answer.message ? `: ${answer.message}` : ""}`
            : `Not answered${e.kind === "question" && e.questions?.[0] ? `: ${e.questions[0].question}` : e.kind === "permission" ? `: ${describePermission(e)}` : ""} (the turn ended)`;
    const cls = decision.startsWith("allow") ? "allow" : decision === "deny" ? "deny" : "";
    const parts = [];
    if (e.kind === "plan" && e.plan && !a.inline) parts.push(h("div", { class: "plan-box md-wrap" }, markdown(e.plan)));
    a.el.replaceChildren(
      ...(e.kind === "plan" && e.plan ? [h("div", { class: "approval", style: { borderColor: "var(--border)", background: "var(--bg-2)" } },
        h("div", { class: "ask" }, icon("list"), "Claude's plan"), ...parts)] : []),
      h("div", { class: `approval done ${cls}${a.inline ? " inline" : ""}` },
        icon(decision.startsWith("allow") ? "check" : decision === "deny" ? "x" : "dot", 14), text),
    );
    return;
  }
  if (e.kind === "question") return a.el.replaceChildren(questionCard(e, a.inline));
  if (e.kind === "plan") return a.el.replaceChildren(planCard(e));
  a.el.replaceChildren(permissionCard(e, a.inline));
}

function formatAnswers(answers) {
  if (!answers) return "";
  return Object.values(answers).map((v) => (Array.isArray(v) ? v.join(", ") : v)).join("; ");
}

/** Answer what the thread waits for: through the pipeline for a task's thread, else answer_approval. */
async function answer(e, args, buttons) {
  for (const b of buttons) b.disabled = true;
  try {
    if (state.task) {
      const { number } = state.task;
      await pipelineCall("send", args.answers && args.decision !== "deny" ? { number, answers: args.answers }
        : { number, decision: args.decision, ...(args.message ? { message: args.message } : {}) });
    } else {
      await call("answer_approval", { thread: state.id, requestId: e.requestId, ...args });
    }
    delete state.answers[e.requestId];
    saveDraft();
  } catch (error) {
    notify(error.message, "error");
    for (const b of buttons) b.disabled = false;
  }
}

function permissionCard(e, inline) {
  const what = e.title || describePermission(e);
  const msg = h("input", { class: "input", placeholder: "Tell Claude why, or what to do instead (optional)" });
  const allow = h("button", { class: "btn small primary" }, icon("check", 14), "Allow");
  const always = h("button", { class: "btn small", title: `Don't ask again for ${e.tool} in this thread` }, "Allow always");
  const deny = h("button", { class: "btn small danger" }, "Deny");
  const buttons = [allow, always, deny];
  allow.addEventListener("click", () => answer(e, { decision: "allow" }, buttons));
  always.addEventListener("click", () => answer(e, { decision: "allow_always" }, buttons));
  deny.addEventListener("click", () => answer(e, { decision: "deny", message: msg.value.trim() || undefined }, buttons));
  msg.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") deny.click();
  });
  return h("div", { class: `approval${inline ? " inline" : ""}` },
    h("div", { class: "ask" }, icon("shield"), what),
    e.reason || e.blockedPath ? h("div", { class: "reason" }, [e.reason, e.blockedPath].filter(Boolean).join(" · ")) : null,
    inline ? null : toolInputView(e.tool, e.input),
    h("div", { class: "actions" }, allow, e.canAlwaysAllow !== false ? always : null, deny, msg),
  );
}

function describePermission(e) {
  const s = toolSummary(e.tool, e.input);
  const verbs = { Bash: "run a command", PowerShell: "run a command", Write: "create a file", Edit: "edit a file",
    MultiEdit: "edit a file", NotebookEdit: "edit a notebook", WebFetch: "open a web page", WebSearch: "search the web" };
  const verb = verbs[e.tool] ?? `use ${toolLabel(e.tool)}`;
  return `Claude wants to ${verb}${s && e.tool !== "Bash" ? `: ${s}` : ""}`;
}

/** Claude's question; what you pick or type is kept in the draft until it's answered. */
function questionCard(e, inline) {
  const saved = (state.answers[e.requestId] ??= {});
  const picked = e.questions.map((_, qi) => new Set(saved[qi]?.picked ?? []));
  const others = e.questions.map((_, qi) => h("input", { class: "input", placeholder: "Or type your own answer", value: saved[qi]?.own ?? "" }));
  const submit = h("button", { class: "btn small primary" }, "Answer");
  const skip = h("button", { class: "btn small" }, "Skip");
  const keep = () => {
    e.questions.forEach((_, qi) => (saved[qi] = { picked: [...picked[qi]], own: others[qi].value }));
    saveDraft();
  };
  const qs = e.questions.map((q, qi) => {
    const opts = q.options.map((o) => {
      const btn = h("button", { class: `opt${q.multiSelect ? " multi" : ""}${picked[qi].has(o.label) ? " sel" : ""}` }, h("span", { class: "mark" }),
        h("span", {}, h("div", {}, o.label), o.description && o.description !== o.label ? h("div", { class: "d" }, o.description) : null));
      btn.addEventListener("click", () => {
        if (q.multiSelect) picked[qi].has(o.label) ? picked[qi].delete(o.label) : picked[qi].add(o.label);
        else {
          picked[qi].clear();
          picked[qi].add(o.label);
        }
        [...btn.parentElement.children].forEach((b, i) => b.classList.toggle("sel", picked[qi].has(q.options[i].label)));
        update();
        keep();
      });
      return btn;
    });
    others[qi].addEventListener("input", () => {
      update();
      keep();
    });
    return h("div", { class: "question" }, q.header ? h("div", { class: "q-head" }, q.header) : null,
      h("div", { class: "q-text" }, q.question), h("div", { class: "opts" }, opts), others[qi]);
  });
  function update() {
    submit.disabled = !e.questions.every((_, i) => picked[i].size || others[i].value.trim());
  }
  update();
  submit.addEventListener("click", () => {
    const answers = {};
    e.questions.forEach((q, i) => {
      const own = others[i].value.trim();
      const list = [...picked[i], ...(own ? [own] : [])];
      answers[q.question] = q.multiSelect ? list : list[0];
    });
    answer(e, { decision: "allow", answers }, [submit, skip]);
  });
  skip.addEventListener("click", () => answer(e, { decision: "deny", message: "The user skipped the question." }, [submit, skip]));
  return h("div", { class: `approval${inline ? " inline" : ""}` }, h("div", { class: "ask" }, icon("question"), "Claude asks"), ...qs,
    h("div", { class: "actions" }, submit, skip));
}

function planCard(e) {
  const msg = h("input", { class: "input", placeholder: "What should change in the plan?" });
  const go = h("button", { class: "btn small primary" }, icon("check", 14), "Approve plan");
  const keep = h("button", { class: "btn small" }, "Keep planning");
  go.addEventListener("click", () => answer(e, { decision: "allow" }, [go, keep]));
  keep.addEventListener("click", () => answer(e, { decision: "deny", message: msg.value.trim() || undefined }, [go, keep]));
  msg.addEventListener("keydown", (ev) => ev.key === "Enter" && keep.click());
  return h("div", { class: "approval" }, h("div", { class: "ask" }, icon("list"), "Claude has a plan"),
    h("div", { class: "plan-box" }, markdown(e.plan || "(empty plan)")), h("div", { class: "actions" }, go, keep, msg));
}

// ------------------------------------------------------------------ header, dock

function setThread(t) {
  if (!t) return;
  const prev = state.thread;
  state.thread = t;
  $("title").textContent = t.title;
  if (!state.titleSet || prev?.title !== t.title) {
    layr.panel.setTitle(t.title.length > 40 ? `${t.title.slice(0, 38)}…` : t.title);
    state.titleSet = true;
  }
  $("status-dot").className = `dot ${t.status}`;
  $("status-label").textContent = `${STATUS_LABEL[t.status] ?? t.status}${t.archived ? " · archived" : ""}`;
  const ws = t.workspace ?? {};
  const wsEl = $("workspace");
  wsEl.replaceChildren(icon(ws.kind === "worktree" ? "branch" : "folder", 12), ws.kind === "worktree" ? ws.branch ?? "worktree" : ws.branch ? `${short(ws.path)} · ${ws.branch}` : short(ws.path));
  wsEl.title = ws.path ?? "";
  // A thread on a plugin or an extension (0.3.2) says which, instead of the folder.
  if (t.target?.plugin) {
    const ext = t.target.kind === "extension";
    wsEl.replaceChildren(icon(ext ? "puzzle" : "box", 12), t.target.plugin);
    wsEl.title = `${ext ? "Chrome extension" : "layr plugin"} ${t.target.plugin} · ${ws.path ?? ""}`;
  }
  $("cost").textContent = t.costUsd ? money(t.costUsd) : "";
  renderContext(t);
  for (const id of t.pendingApprovals ?? []) state.pending.add(id);
  if (prev && prev.pendingApprovals?.join() !== t.pendingApprovals?.join()) {
    state.pending = new Set(t.pendingApprovals ?? []);
    refreshApprovals();
  }
  if (prev && busy(prev) && !busy(t)) scheduleChanges();
  renderBackground(t.background ?? []);
  renderTodos(t.todos ?? []);
  renderQueue(t);
  renderPickers();
  renderWorking();
}

const busy = (t) => t && (t.status === "running" || t.status === "starting" || t.status === "waiting");

/** How full the context is: "42% context", the tokens in the tooltip; amber from 70%, red from 90%. */
function renderContext(t) {
  const el = $("context");
  const c = t.context ?? (t.contextTokens ? { tokens: t.contextTokens, window: 200_000 } : null);
  el.hidden = !c;
  if (!c) return;
  const percent = c.percent ?? Math.round((c.tokens / c.window) * 1000) / 10;
  el.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% context`;
  el.title = `${c.tokens.toLocaleString()} of ${c.window.toLocaleString()} tokens ` +
    `(${tokens(c.tokens)} / ${tokens(c.window)})`;
  el.className = `ctx${percent >= 90 ? " full" : percent >= 70 ? " high" : ""}`;
}

function short(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

let workingTimer = null;
function renderWorking() {
  const t = state.thread;
  const isBusy = busy(t);
  const el = $("working");
  el.hidden = !isBusy;
  el.classList.toggle("waiting", t?.status === "waiting");
  $("stop").hidden = !isBusy;
  $("steer").hidden = !isBusy || !input.value.trim() || Boolean(state.task);
  $("send").textContent = isBusy && !state.task ? "Queue" : "Send";
  $("hint").textContent = state.task ? "Sent through the pipeline" : isBusy ? "Enter queues · Ctrl+Enter steers" : "";
  clearInterval(workingTimer);
  if (!isBusy) return;
  const tick = () => {
    const secs = state.turnStartedAt ? Math.round((Date.now() - state.turnStartedAt) / 1000) : null;
    $("working-text").textContent =
      t.status === "waiting" ? "Waiting for your answer above" : `Working${secs != null ? ` · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : "…"}`;
  };
  tick();
  workingTimer = setInterval(tick, 1000);
}

const BG_KIND = { local_agent: "agent", local_bash: "shell", monitor: "monitor", local_workflow: "workflow" };

/** What the thread's Claude Code runs in the background (subagents, shells, monitors): it keeps the session open. */
function renderBackground(tasks) {
  const el = $("background");
  if (!tasks.length) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  const wasOpen = el.querySelector("details")?.open ?? false;
  const items = tasks.map((t) => h("div", { class: "bg-item", title: t.description },
    h("span", { class: "t" }, t.description || t.id),
    h("span", { class: "k" }, `${t.agent ?? BG_KIND[t.type] ?? t.type ?? "task"} · ${relTime(t.startedAt)}`)));
  el.replaceChildren(h("details", { open: wasOpen },
    h("summary", {}, h("span", { class: "spinner" }), `${tasks.length} running in the background`),
    h("div", { class: "bg-list" }, items)));
  el.hidden = false;
}

function renderTodos(todos) {
  const el = $("todos");
  if (!todos.length || todos.every((t) => t.status === "completed") && state.thread?.status === "done") {
    el.hidden = true;
    return;
  }
  const done = todos.filter((t) => t.status === "completed").length;
  const wasOpen = el.querySelector("details")?.open ?? false;
  const current = todos.find((t) => t.status === "in_progress");
  const det = h("details", { open: wasOpen }, h("summary", {}, icon("list", 14), `Todos ${done}/${todos.length}`,
    current ? h("span", { style: { color: "var(--fg)" } }, `· ${current.activeForm || current.content}`) : null), todoList(todos));
  det.firstChild.style.cssText = "list-style:none;cursor:pointer;padding:6px 10px;display:flex;gap:8px;align-items:center;color:var(--fg-dim)";
  det.querySelector(".todo-list").style.cssText = "padding:0 12px 8px;max-height:180px;overflow:auto";
  el.replaceChildren(det);
  el.hidden = false;
}

function renderQueue(t) {
  const el = $("queue");
  if (!t.queue?.length) {
    el.hidden = true;
    return;
  }
  const items = t.queue.map((q) => {
    const now = h("button", { class: "btn ghost small", title: "Put it into the running turn now" }, "Send now");
    const del = h("button", { class: "btn ghost small icon-only", title: "Remove" }, icon("x", 13));
    now.addEventListener("click", () => call("thread_queue", { thread: state.id, action: "steer", item: q.id }).catch((e) => notify(e.message, "error")));
    del.addEventListener("click", () => call("thread_queue", { thread: state.id, action: "remove", item: q.id }).catch((e) => notify(e.message, "error")));
    return h("div", { class: "q-item" }, h("span", { class: "t" }, q.text || `[${q.images} image(s)]`), now, del);
  });
  const resume = t.queuePaused ? h("button", { class: "btn ghost small" }, "Go on") : null;
  resume?.addEventListener("click", () => call("thread_queue", { thread: state.id, action: "resume" }));
  el.replaceChildren(h("div", { class: "q-title" }, t.queuePaused ? "Queued (paused after Stop)" : "Queued, sent when this turn ends", resume), ...items);
  el.hidden = false;
}

function renderPickers() {
  const t = state.thread;
  if (!t) return;
  const models = state.models.length ? state.models : [{ id: "opus", label: "Opus", efforts: [] }, { id: "sonnet", label: "Sonnet", efforts: [] }, { id: "haiku", label: "Haiku", efforts: [] }];
  const modelSel = $("model");
  const opts = modelOptions(models);
  if (t.model && !opts.some((o) => o.value === t.model)) opts.push({ value: t.model, label: t.model });
  if (document.activeElement !== modelSel) fillSelect(modelSel, opts, t.model ?? "");
  const effortSel = $("effort");
  const eopts = effortOptions(models, t.model ?? "default");
  if (t.effort && !eopts.some((o) => o.value === t.effort)) eopts.push({ value: t.effort, label: `Effort: ${t.effort}` });
  if (document.activeElement !== effortSel) fillSelect(effortSel, eopts, t.effort ?? "");
  const modeSel = $("mode");
  if (document.activeElement !== modeSel) fillSelect(modeSel, permissionOptions(), t.permissionMode ?? "default");
}

for (const [id, key] of [["model", "model"], ["effort", "effort"], ["mode", "permissionMode"]]) {
  $(id).addEventListener("change", async (ev) => {
    const value = ev.target.value;
    try {
      const r = await call("thread_update", { thread: state.id, [key]: key === "permissionMode" ? value : value || null });
      setThread(r.thread);
    } catch (error) {
      notify(error.message, "error");
    }
    ev.target.blur();
  });
}

// Rename by clicking the title (or from the ⋯ menu).
$("head").addEventListener("click", (ev) => {
  if (ev.target.id === "title") startRename();
});

function startRename() {
  const heading = $("title");
  if (!heading || !state.thread) return;
  const t = state.thread;
  const field = h("input", { class: "input", id: "title-edit", value: t.title });
  heading.replaceWith(field);
  field.focus();
  field.select();
  let finished = false;
  const done = async (save) => {
    if (finished) return;
    finished = true;
    const title = field.value.trim();
    heading.textContent = save && title ? title : t.title;
    field.replaceWith(heading);
    if (save && title && title !== t.title) {
      const r = await call("thread_update", { thread: state.id, title }).catch((e) => notify(e.message, "error"));
      if (r?.thread) setThread(r.thread);
    }
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  field.addEventListener("blur", () => done(true));
}

/** The thread's menu: the ⋯ button and a right-click on the header. */
function threadMenu(ev) {
  const t = state.thread;
  if (!t) return;
  void contextMenu([
    state.phone ? null : { label: "Open folder in VS Code", icon: "code", run: () => openFolderOnPc(state.id, "vscode") },
    state.phone ? null : { label: "Open folder in File Explorer", icon: "folder_open", run: () => openFolderOnPc(state.id, "explorer") },
    state.phone ? null : "-",
    state.task === null && !t.archived ? { label: "+ Pipeline", icon: "view_kanban", run: () => adoptThread(state.id).then(() => refreshTask()) } : null,
    t.target?.plugin && t.target.place !== "inside"
      ? { label: "History and undo (My plugins)", icon: "history", run: () => layr.panels.open("main", { plugin: t.target.plugin }, { plugin: "devtools" }).catch((e) => notify(e.message, "error")) }
      : null,
    t.target?.kind === "extension"
      ? { label: "Reload the extension", icon: "refresh", run: () => layr.tools.call("extension_reload", { plugin: t.target.plugin }, { plugin: "layr" })
          .then(() => notify("Extension reloaded", "success"), (e) => notify(e.message, "error")) }
      : null,
    { label: "Rename", icon: "edit", run: startRename },
    { label: t.archived ? "Bring back" : "Archive", icon: t.archived ? "unarchive" : "archive", run: async () => {
      const r = await call("thread_archive", { thread: state.id, archived: !t.archived }).catch((e) => notify(e.message, "error"));
      if (r?.thread) setThread(r.thread);
    } },
    { label: "Copy link", icon: "link", run: () => copyText(threadLink(state.id), "Link copied") },
  ], ev);
}
$("more").addEventListener("click", (ev) => threadMenu(ev));
$("head").addEventListener("contextmenu", (ev) => {
  if (ev.target.closest("input")) return;
  threadMenu(ev);
});

// ------------------------------------------------------------------ the pipeline task

let taskTimer = null;
async function refreshTask() {
  const task = await threadTask(state.id);
  state.task = task;
  renderTaskStrip($("task"), task ?? null, state.id, () => void refreshTask());
  renderWorking();
  clearTimeout(taskTimer);
  // While there is a pipeline, look again every 10 s (its events may not reach this panel).
  if (task !== undefined) taskTimer = setTimeout(refreshTask, 10_000);
}

// ------------------------------------------------------------------ changes

let changesTimer = null;
function scheduleChanges() {
  clearTimeout(changesTimer);
  changesTimer = setTimeout(loadChanges, 1200);
}

async function loadChanges() {
  clearTimeout(changesTimer);
  try {
    state.changes = (await call("thread_changes", { thread: state.id })).changes;
  } catch {
    state.changes = null;
  }
  renderChanges();
  changesTimer = setTimeout(loadChanges, busy(state.thread) ? 20_000 : 60_000);
}


function renderChanges() {
  const c = state.changes;
  const chip = $("changes-chip");
  const drawer = $("changes");
  if (!c || (!c.files && !c.commits && !c.behind)) {
    chip.hidden = true;
    drawer.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.replaceChildren(...[h("span", { class: "add" }, `+${c.added}`), " ", h("span", { class: "del" }, `−${c.removed}`),
    ` · ${c.files} ${c.files === 1 ? "file" : "files"}`,
    c.behind ? h("span", { class: "behind", title: `${c.base} has ${c.behind} commit(s) this branch hasn't` }, ` ↓${c.behind} behind`) : null,
    c.conflicts?.length ? h("span", { class: "conflict", title: c.conflicts.join("\n") }, " ⚠ conflicts") : null].filter(Boolean));
  chip.classList.toggle("on", !drawer.hidden);
  if (!drawer.hidden) drawDrawer();
}

$("changes-chip").addEventListener("click", () => {
  const drawer = $("changes");
  drawer.hidden = !drawer.hidden;
  $("changes-chip").classList.toggle("on", !drawer.hidden);
  if (!drawer.hidden) {
    drawDrawer();
    void loadChanges();
  }
});

let drawerTab = "files";
const openDiffs = new Set();

function drawDrawer() {
  const c = state.changes;
  const drawer = $("changes");
  if (!c) return;
  const tabs = ["files", "commits"].map((tab) => {
    const b = h("button", { class: `tab${drawerTab === tab ? " on" : ""}` }, tab === "files" ? `Files ${c.files}` : `Commits ${c.commits}`);
    b.addEventListener("click", () => {
      drawerTab = tab;
      drawDrawer();
    });
    return b;
  });
  const merge = c.base
    ? [`Against ${c.base}`, `${c.commits} commit${c.commits === 1 ? "" : "s"} ahead`, c.behind ? `↓${c.behind} behind` : "up to date",
      c.conflicts === null ? "merge not checked (old git)" : c.conflicts?.length ? `⚠ conflicts in ${c.conflicts.join(", ")}` : "merges cleanly"]
    : ["Uncommitted changes in the project's own folder"];
  const close = h("button", { class: "btn ghost small icon-only", title: "Close" }, icon("x", 13));
  close.addEventListener("click", () => $("changes-chip").click());
  const body = drawerTab === "files" ? filesView(c) : commitsView(c);
  drawer.replaceChildren(
    h("div", { class: "drawer-head" }, ...tabs, h("span", { class: `merge${c.conflicts?.length ? " bad" : ""}` }, merge.join(" · ")), close),
    body);
}

function filesView(c) {
  const groups = [["uncommitted", "Uncommitted"], ["new", "New"], ["committed", "Committed"]];
  const out = h("div", { class: "files" });
  for (const [st, title] of groups) {
    const files = (c.list ?? []).filter((f) => f.state === st);
    if (!files.length) continue;
    out.append(h("div", { class: "files-title" }, `${title} · ${files.length}`));
    for (const f of files) {
      const row = h("button", { class: "file-row", title: f.path }, h("span", { class: "path" }, f.path),
        h("span", { class: "add" }, `+${f.added}`), h("span", { class: "del" }, `−${f.removed}`));
      const holder = h("div", { class: "file-diff" });
      const show = async () => {
        holder.replaceChildren(h("div", { class: "muted" }, "Loading…"));
        try {
          const r = await call("thread_diff", { thread: state.id, file: f.path });
          holder.replaceChildren(unifiedDiff(r.diff));
        } catch (error) {
          holder.replaceChildren(h("div", { class: "error-box" }, error.message));
        }
      };
      row.addEventListener("click", () => {
        if (openDiffs.has(f.path)) {
          openDiffs.delete(f.path);
          holder.replaceChildren();
        } else {
          openDiffs.add(f.path);
          void show();
        }
      });
      if (openDiffs.has(f.path)) void show();
      out.append(row, holder);
    }
  }
  if (!out.children.length) out.append(h("div", { class: "muted" }, "No changed files"));
  return out;
}

function commitsView(c) {
  const list = c.commitList ?? [];
  if (!list.length) return h("div", { class: "files muted" }, c.base ? "No commits on this branch yet" : "Not on a branch of its own");
  return h("div", { class: "files" }, list.map((k) => h("div", { class: "commit-row", title: k.sha },
    h("span", { class: "sha mono" }, k.sha.slice(0, 7)), h("span", { class: "subject" }, k.subject), when(k.at))));
}

/** A unified diff, coloured line by line. */
function unifiedDiff(text) {
  const el = h("div", { class: "diff" });
  const lines = String(text ?? "").split("\n");
  let started = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      started = true;
      el.append(h("div", { class: "ln gap" }, h("span", { class: "g" }, "⋯"), h("span", { class: "t" }, line)));
    } else if (!started) continue;
    else if (line.startsWith("+")) el.append(h("div", { class: "ln add" }, h("span", { class: "g" }, "+"), h("span", { class: "t" }, line.slice(1) || " ")));
    else if (line.startsWith("-")) el.append(h("div", { class: "ln del" }, h("span", { class: "g" }, "-"), h("span", { class: "t" }, line.slice(1) || " ")));
    else if (!line.startsWith("\\")) el.append(h("div", { class: "ln" }, h("span", { class: "g" }), h("span", { class: "t" }, line.slice(1) || " ")));
  }
  if (!el.children.length) el.append(h("div", { class: "ln gap" }, h("span", { class: "t" }, text?.trim() ? text : "No text changes (binary, or only the mode)")));
  return el;
}

// ------------------------------------------------------------------ concept nodes

// The concept nodes this thread changed, mentioned or was linked to (`concepts__thread_nodes`): a ◇ N chip in the
// header and a list under it, each opening the node in Concepts. Hidden without the concepts plugin, or with none.
let conceptsTimer = null;
function scheduleConcepts(ms = 1500) {
  if (state.conceptNodes === false) return;
  clearTimeout(conceptsTimer);
  conceptsTimer = setTimeout(loadConcepts, ms);
}

async function loadConcepts() {
  clearTimeout(conceptsTimer);
  try {
    const rows = await pluginCall("concepts", "thread_nodes", { thread: state.id });
    state.conceptNodes = (Array.isArray(rows) ? rows : []).filter((r) => r?.id);
  } catch (error) {
    // No concepts plugin (or not allowed): hidden, and not asked again until concepts says something changed.
    if (!(error instanceof ToolFailed)) state.conceptNodes = false;
  }
  renderConcepts();
  if (state.conceptNodes !== false && busy(state.thread)) conceptsTimer = setTimeout(loadConcepts, 30_000);
}

const DID = { changed: "changed", linked: "linked", mentioned: "mentioned" };

function renderConcepts() {
  const nodes = state.conceptNodes || [];
  const chip = $("concepts-chip");
  const drawer = $("concepts");
  chip.hidden = !nodes.length;
  if (!nodes.length) {
    drawer.hidden = true;
    return;
  }
  chip.textContent = `◇ ${nodes.length}`;
  chip.title = `${nodes.length} concept node${nodes.length === 1 ? "" : "s"} this thread touched`;
  chip.classList.toggle("on", !drawer.hidden);
  if (drawer.hidden) return;
  const close = h("button", { class: "btn ghost small icon-only", title: "Close" }, icon("x", 13));
  close.addEventListener("click", () => chip.click());
  drawer.replaceChildren(h("div", { class: "c-head" }, `Concept nodes this thread touched · ${nodes.length}`,
    h("span", { class: "grow" }), close), ...nodes.map((n) => {
    const title = String(n.text ?? "").split("\n").find((l) => l.trim())?.trim() || "(empty)";
    const row = h("button", { class: "c-node", title: `${title}\nOpen it in Concepts` },
      h("span", { class: "c-title" }, title),
      h("span", { class: `c-did ${n.did ?? ""}` }, DID[n.did] ?? n.did ?? ""),
      n.note ? h("span", { class: "c-note", title: n.note }, n.note) : null);
    row.addEventListener("click", () => void openLink(`layr://concepts/node/${encodeURIComponent(n.id)}`));
    return row;
  }));
}

$("concepts-chip").addEventListener("click", () => {
  const drawer = $("concepts");
  drawer.hidden = !drawer.hidden;
  renderConcepts();
  if (!drawer.hidden) void loadConcepts();
});
on("concepts:changed", () => {
  if (state.conceptNodes === false) state.conceptNodes = undefined;
  scheduleConcepts(2000);
});

// ------------------------------------------------------------------ composer

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  const t = state.thread;
  $("steer").hidden = !(t && (t.status === "running" || t.status === "waiting")) || !input.value.trim() || Boolean(state.task);
}
input.addEventListener("input", () => {
  autosize();
  renderSlash();
  saveDraft();
});

input.addEventListener("keydown", (ev) => {
  if (slashKey(ev)) return;
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send(ev.ctrlKey || ev.metaKey ? "steer" : "queue");
  }
});
$("send").addEventListener("click", () => send("queue"));
$("steer").addEventListener("click", () => send("steer"));
$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  try {
    if (state.task) await pipelineCall("stop", { number: state.task.number });
    else await call("thread_interrupt", { thread: state.id });
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("stop").disabled = false;
  }
});

async function send(mode) {
  const typed = input.value;
  const prefix = currentPrefix();
  const text = prefix ? (typed.trim() ? `${prefix}\n\n${typed}` : prefix) : typed;
  if (!text.trim() && !state.attachments.length) return;
  const images = state.attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const sendBtn = $("send");
  sendBtn.disabled = true;
  try {
    let r = null;
    if (state.task) await pipelineCall("send", { number: state.task.number, text, ...(images.length ? { images } : {}) });
    else r = await call("thread_send", { thread: state.id, text, images, mode });
    input.value = "";
    state.attachments = [];
    state.picks.picked = {};
    renderAttachments();
    renderLatest();
    renderSlash();
    autosize();
    void drafts.clear(state.id);
    if (r?.thread) setThread(r.thread);
    scrollToBottom(true);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

// Slash commands: typing "/" first lists Claude Code's commands for the folder.
let slashIndex = 0;
let slashShown = [];

async function loadCommands() {
  try {
    const r = await call("thread_commands", { thread: state.id });
    state.commands = r.commands ?? [];
    state.commandsKnown = r.known;
  } catch {
    state.commands = [{ name: "compact", description: "Summarize the conversation so far, to free up context", argumentHint: "" }];
  }
}

function renderSlash() {
  const el = $("slash");
  const m = /^\/([\w:.-]*)$/.exec(input.value);
  if (!m) {
    el.hidden = true;
    slashShown = [];
    return;
  }
  if (!state.commands) {
    void loadCommands().then(renderSlash);
    return;
  }
  const q = m[1].toLowerCase();
  slashShown = state.commands.filter((c) => c.name.toLowerCase().startsWith(q))
    .concat(state.commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)))
    .slice(0, 50);
  if (!slashShown.length) {
    el.hidden = true;
    return;
  }
  slashIndex = Math.min(slashIndex, slashShown.length - 1);
  el.replaceChildren(...slashShown.map((c, i) => {
    const row = h("button", { class: `slash-row${i === slashIndex ? " on" : ""}` }, h("span", { class: "name" }, `/${c.name}`),
      c.argumentHint ? h("span", { class: "hint" }, c.argumentHint) : null, h("span", { class: "desc" }, c.description));
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pickSlash(c);
    });
    return row;
  }));
  el.hidden = false;
  el.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

function pickSlash(c) {
  input.value = `/${c.name} `;
  slashIndex = 0;
  renderSlash();
  autosize();
  saveDraft();
  input.focus();
}

function slashKey(ev) {
  if ($("slash").hidden || !slashShown.length) return false;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    slashIndex = (slashIndex + (ev.key === "ArrowDown" ? 1 : -1) + slashShown.length) % slashShown.length;
    renderSlash();
  } else if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey)) {
    // A full name typed already: Enter sends it.
    const c = slashShown[slashIndex];
    if (ev.key === "Enter" && input.value === `/${c.name}`) return false;
    pickSlash(c);
  } else if (ev.key === "Escape") {
    $("slash").hidden = true;
  } else return false;
  ev.preventDefault();
  return true;
}

$("attach").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async (ev) => {
  await addFiles([...ev.target.files]);
  ev.target.value = "";
});
input.addEventListener("paste", async (ev) => {
  const files = [...(ev.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile());
  if (files.length) {
    ev.preventDefault();
    await addFiles(files);
  }
});
const composer = $("composer");
composer.addEventListener("dragover", (ev) => {
  if ([...(ev.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) {
    ev.preventDefault();
    composer.classList.add("drag");
  }
});
composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
composer.addEventListener("drop", async (ev) => {
  composer.classList.remove("drag");
  const files = [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    ev.preventDefault();
    await addFiles(files);
  }
});

async function addFiles(files) {
  for (const f of files) {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.type)) {
      notify(`${f.name || "That file"} is not a PNG, JPEG, GIF or WebP image`, "error");
      continue;
    }
    if (f.size > 5 * 1024 * 1024) {
      notify(`${f.name || "The image"} is larger than 5 MB`, "error");
      continue;
    }
    state.attachments.push(await readImage(f));
  }
  renderAttachments();
  saveDraft();
  input.focus();
}

function renderAttachments() {
  const el = $("attachments");
  el.replaceChildren(
    ...state.attachments.map((a, i) => {
      const del = h("button", { title: "Remove" }, icon("x", 11));
      del.addEventListener("click", () => {
        state.attachments.splice(i, 1);
        renderAttachments();
        saveDraft();
      });
      return h("div", { class: "att" }, h("img", { src: a.url, alt: a.name }), del);
    }),
  );
  el.hidden = !state.attachments.length;
}

// ------------------------------------------------------------------ drafts

function saveDraft() {
  drafts.save(state.id, {
    text: input.value,
    images: state.attachments.map(({ mediaType, data, name }) => ({ mediaType, data, name })),
    picks: hasPicks(state.picks.picked) ? { replyId: state.picks.replyId, picked: state.picks.picked } : null,
    answers: state.answers,
  });
}

async function loadDraft() {
  const d = await drafts.load(state.id).catch(() => null);
  if (!d) return;
  input.value = d.text ?? "";
  state.attachments = (d.images ?? []).filter((i) => i?.data).map((i) => ({ ...i, url: `data:${i.mediaType};base64,${i.data}` }));
  if (d.picks?.replyId) state.picks = { replyId: d.picks.replyId, picked: d.picks.picked ?? {} };
  state.answers = d.answers && typeof d.answers === "object" ? d.answers : {};
  renderAttachments();
  autosize();
}

window.addEventListener("pagehide", () => void drafts.flush());
document.addEventListener("visibilitychange", () => document.hidden && void drafts.flush());

// ------------------------------------------------------------------ helpers

function isNearBottom(px = 120) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < px;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom(400)) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
}

function showImage(src) {
  if (!src) return;
  const box = $("lightbox");
  box.replaceChildren(h("img", { src }));
  box.hidden = false;
  box.onclick = () => (box.hidden = true);
}


// ------------------------------------------------------------------ start (last, so every binding above exists)

call("models_list")
  .then((r) => {
    state.models = r.models ?? [];
    renderPickers();
  })
  .catch(() => {});
await loadDraft();
// The draft's picks belong to a reply: kept only if that reply is still the latest (setLatest drops them otherwise).
const draftPicks = state.picks;
state.picks = { replyId: null, picked: {} };
await loadTranscript();
if (draftPicks.replyId && state.latest?.entry.id === draftPicks.replyId) {
  state.picks = draftPicks;
  renderLatest();
}
void refreshTask();
void loadChanges();
void loadConcepts();
input.focus();
