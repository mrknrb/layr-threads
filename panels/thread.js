// The thread panel: one Claude Code conversation, live. Loads the transcript with thread_transcript, then follows
// the claude:thread.<id> events (entries, text deltas, status). Each turn (your message and what followed) is a block
// of its own: a finished one folds its work into one row (folds.js), replies in the boxes format get boxes with
// answers to pick (replies.js), and a thread that is a pipeline task gets the task's strip, with Send, answers and Stop
// going through the pipeline (pipeline.js).
import { answerPrefix, hasPicks, pickIn, questionsOf, toggleAgree } from "./boxes.js";
import {
  call,
  clock,
  defaultModelName,
  effortOptions,
  fillSelect,
  h,
  icon,
  modelName,
  modelOptions,
  money,
  notify,
  on,
  permissionOptions,
  readImage,
  ready,
  relTime,
  statusLabel,
  tokens,
} from "./common.js";
import { createDraftStore } from "./drafts.js";
import { foldTurn, groupRuns, isWork, relayFold, tokensTitle } from "./folds.js";
import { renderTaskStrip } from "./pipeline.js";
import { prototypeEmbeds } from "./prototypes.js";
import { markdown, setMarkdownHooks, toolIcon, toolInputView, toolLabel, toolSummary } from "./render.js";
import { renderReply } from "./replies.js";
import {
  adoptThread,
  confirmIn,
  contextMenu,
  copyText,
  onPhone,
  onPipelineChange,
  openFolderOnPc,
  ToolFailed,
  openLink,
  pipelineCall,
  pluginCall,
  pluginPageLink,
  threadLink,
  threadTask,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const scroller = $("scroller");
const input = $("input");
const subview = $("subview");
const PLACEHOLDER = input.placeholder;

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
  /** Answers picked in the latest reply: {replyId, picked, sent?} (boxes.js picks). `sent`: Approve or Send took
   * them along and they still wait (for Away, or the pipeline): they show, locked, until your message is in the
   * thread. */
  picks: { replyId: null, picked: {} },
  /** Half-filled answers to pending questions: {[requestId]: {[question index]: {picked, own}}}. */
  answers: {},
  /** The pipeline task of this thread: undefined (no pipeline), null (not a task) or the task. */
  task: undefined,
  changes: null,
  commands: null,
  phone: false,
  /** Every entry of the main transcript loaded, in order: a subagent's view is drawn from them. */
  entries: [],
  /** Agent call id → the subagent it started: {toolUseId, description, type, prompt, parent, agent, result}. */
  agents: new Map(),
  /** The subagent shown instead of the main conversation (subagents' view), or null. */
  sub: null,
  /** The subagents' views to go back to (a subagent's own subagent opened from its view). */
  subStack: [],
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
// The pipeline installed, removed, allowed or denied: the task strip, "+ Pipeline" and When Away follow, no reload.
onPipelineChange(() => void refreshTask());

// ------------------------------------------------------------------ loading

async function loadTranscript() {
  try {
    const r = await call("thread_transcript", { thread: state.id, limit: 1500 });
    log.replaceChildren();
    main.turns = [];
    state.entries = [];
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
    state.entries.unshift(...r.entries);
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
  } else if (ev.kind === "reset") {
    // The thread went back (here or in another panel): the transcript lost its end, draw it again.
    void reloadTranscript();
  }
}

/** The transcript drawn again from the start, nothing kept from what was shown. */
function reloadTranscript() {
  state.tools.clear();
  state.approvals.clear();
  state.answered.clear();
  for (const block of state.live.values()) block.el?.remove();
  state.live.clear();
  state.latest = null;
  return loadTranscript();
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
  const fold = turn.relay ? relayFold(turn.items) : foldTurn(turn.items);
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
  noteAgent(e);
  const el = drawEntry(e, into);
  if (into === main) {
    picksArrived(e);
    state.entries.push(e);
    if (state.sub) subFollow(e);
  }
  return el;
}

function drawEntry(e, into) {
  if (into === main) state.lastSeq = Math.max(state.lastSeq, e.seq);
  const parentCard = e.parent ? state.tools.get(e.parent) : null;
  if (parentCard && !parentCard.hidden) return addChild(parentCard, e);
  // What a subagent was told shows only in its own view.
  if (e.parent && e.type === "user") return null;
  const kept = (el) => el && addItem(currentTurn(into), { kind: "kept", entry: e, el });
  switch (e.type) {
    case "created":
      return kept(h("div", { class: "sys" }, `Started in ${e.workspace?.kind === "worktree" ? `worktree ${e.workspace.branch}` : e.workspace?.path ?? ""}`));
    case "user":
      if (e.relay) {
        // Your message to a subagent: one line; the main agent's turn passing it on folds away (relayFold).
        if (e.steer) return kept(relayLine(e));
        newTurn(into, relayLine(e)).relay = true;
        return null;
      }
      if (e.steer) return kept(userBubble(e));
      return newTurn(into, userBubble(e));
    case "turn_start": {
      state.turnStartedAt = Date.parse(e.ts);
      // A turn after one that passed a message on (the subagent's answer came back): not folded with it.
      const last = into.turns.at(-1);
      if (last?.relay && last.ended) newTurn(into, null);
      return null;
    }
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
      if (e.subtype === "saved" && e.commit) return kept(savedLine(e));
      if (e.subtype === "limit_pause") return kept(h("div", { class: "sys" }, icon("clock", 12), e.text));
      return kept(h("div", { class: `sys${e.subtype === "background_lost" ? " warn" : ""}` }, e.text));
    case "error":
      return kept(e.retry ? retryBox(e) : h("div", { class: "error-box" }, e.message));
    default:
      return null;
  }
}

/** "Saved as a version: …" after a turn, with the commit as a chip that opens it in the plugin page's History. */
function savedLine(e) {
  const short = e.short ?? String(e.commit).slice(0, 7);
  const chip = e.plugin
    ? h("button", { class: "commit-chip", title: "Open this version in the plugin's History" },
      icon("history", 11), short)
    : h("span", { class: "commit-chip", title: e.commit }, short);
  if (e.plugin) chip.addEventListener("click", () => openLink(pluginPageLink(e.plugin, "history", e.commit)));
  return h("div", { class: "sys saved" }, e.text, " ", chip);
}

/** A failure the thread can get over by sending its last message again (Claude Code couldn't read its config). */
function retryBox(e) {
  const again = h("button", { class: "btn small primary" }, icon("refresh", 14), "Try again");
  again.addEventListener("click", async () => {
    again.disabled = true;
    try {
      await call("thread_retry", { thread: state.id });
    } catch (error) {
      notify(error.message, "error");
      again.disabled = false;
    }
  });
  return h("div", { class: "error-box" }, e.message, h("div", { class: "actions" }, again));
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

// ------------------------------------------------------------------ subagents

/** The subagent id an Agent call's result names ("agentId: a7a4…"), for threads from before layr kept their ids. */
const agentIdIn = (text) => /agentId:\s*([0-9a-f]{8,})/i.exec(String(text ?? ""))?.[1] ?? null;

/** Learn the subagents from the entries: their Agent calls, the ids their messages carry, their results. */
function noteAgent(e) {
  if (e.type === "tool_use" && (e.name === "Agent" || e.name === "Task")) {
    if (state.agents.has(e.id)) return;
    state.agents.set(e.id, {
      toolUseId: e.id,
      description: String(e.input?.description ?? ""),
      type: e.input?.subagent_type ?? null,
      prompt: String(e.input?.prompt ?? ""),
      asked: typeof e.input?.model === "string" ? e.input.model : null,
      parent: e.parent ?? null,
      agent: null,
      result: null,
    });
    if (state.loaded) renderSubagents();
  } else if (e.parent && e.agent) {
    const a = state.agents.get(e.parent);
    if (a && !a.agent) a.agent = e.agent;
  } else if (e.type === "tool_result" && state.agents.has(e.id)) {
    const a = state.agents.get(e.id);
    a.result = e.content ?? "";
    a.agent ??= agentIdIn(a.result);
  }
}

/** A subagent's id and state: running, done, failed or stopped. */
function agentInfo(a) {
  const known = (state.thread?.subagents ?? []).find((s) => s.toolUseId === a.toolUseId || (a.agent && s.id === a.agent));
  const id = a.agent ?? known?.id ?? agentIdIn(a.result);
  const status = known?.status ?? (a.result != null ? "done" : busy(state.thread) ? "running" : "stopped");
  // The model its answers came from; threads from before layr kept it: the one its Agent call asked for, if any.
  const model = known?.model ? modelName(known.model) : a.asked ? modelName(a.asked) : null;
  return { id, status, model };
}

const SUB_STATUS = { running: "working", done: "finished", failed: "failed", stopped: "stopped" };
const SUB_DOT = { running: "running", done: "done", failed: "failed", stopped: "interrupted" };

/** The id of the subagent shown, or null. */
function subId() {
  const a = state.sub && state.agents.get(state.sub.toolUseId);
  return a ? agentInfo(a).id : null;
}

/** Run `fn` on the subagent's view: its own tool cards and approvals (the main view keeps its own). */
function inSub(fn) {
  const tools = state.tools;
  const approvals = state.approvals;
  state.tools = state.sub.tools;
  state.approvals = state.sub.approvals;
  try {
    return fn();
  } finally {
    state.tools = tools;
    state.approvals = approvals;
  }
}

/**
 * Show a subagent's conversation instead of the main one: from the thread's entries, or (one from before layr kept
 * subagents' text) from Claude Code's own transcript of it. The composer then writes to it.
 */
async function openSub(toolUseId, { push = true } = {}) {
  const a = state.agents.get(toolUseId);
  if (!a) return;
  if (push && state.sub && state.sub.toolUseId !== toolUseId) state.subStack.push(state.sub.toolUseId);
  if (!state.sub) state.mainScroll = scroller.scrollTop;
  const sub = { toolUseId, tools: new Map(), approvals: new Map(), card: { children: subview }, texts: new Set(),
    loading: false, pending: [] };
  state.sub = sub;
  subview.replaceChildren();
  log.hidden = true;
  subview.hidden = false;
  renderSubbar();
  renderComposerMode();
  // Its conversation is complete in the thread when what it was told is there (layr 0.3.9 on); else from disk.
  const told = state.entries.some((e) => e.type === "user" && e.by === "claude" && e.parent === toolUseId);
  const id = agentInfo(a).id;
  if (!told && id) {
    sub.loading = true;
    subview.append(h("div", { class: "empty" }, "Loading the subagent's conversation…"));
    const disk = await call("thread_subagent", { thread: state.id, agent: id }).then((r) => r.entries ?? [], () => []);
    if (state.sub !== sub) return;
    subview.replaceChildren();
    sub.loading = false;
    if (disk.length) {
      // What you wrote to it, passed on word for word, is yours.
      const yours = new Set(state.entries.filter((e) => e.relay?.toolUseId === toolUseId).map((e) => e.text.trim()));
      inSub(() => {
        for (const e of disk) subAdd(e.type === "user" && yours.has(e.text.trim()) ? { ...e, you: true } : e);
      });
      for (const e of sub.pending.splice(0)) subFollow(e);
      scrollToBottom(true);
      return;
    }
  }
  sub.pending = [];
  if (!told) inSub(() => subAdd({ type: "user", id: `${toolUseId}:task`, by: "claude", text: a.prompt, parent: toolUseId }));
  for (const e of state.entries) subFollow(e);
  scrollToBottom(true);
}

/** Back to the subagent this one was opened from, or to the main conversation. */
function closeSub({ all = false } = {}) {
  const back = all ? null : state.subStack.pop();
  if (all) state.subStack = [];
  if (back) return void openSub(back, { push: false });
  state.sub = null;
  subview.replaceChildren();
  subview.hidden = true;
  log.hidden = false;
  renderSubbar();
  renderComposerMode();
  if (state.mainScroll != null) scroller.scrollTop = state.mainScroll;
}

/** A new entry of the thread, drawn in the subagent's view too when it is the subagent's. */
function subFollow(e) {
  if (state.sub.loading) return void state.sub.pending.push(e);
  inSub(() => subAdd(e));
}

/** Draw `e` in the subagent's view when it belongs to it (call in inSub). */
function subAdd(e) {
  const sub = state.sub;
  const put = (el) => (subview.append(el), el);
  if (e.relay) {
    if (e.relay.toolUseId !== sub.toolUseId) return null;
    sub.texts.add(String(e.text ?? "").trim());
    return put(userBubble(e));
  }
  if (e.type === "approval_answer") return state.approvals.has(e.requestId) ? renderApproval(e.requestId) : null;
  if (e.type === "approval") return e.toolUseId && state.tools.has(e.toolUseId) ? addApproval(e, put) : null;
  // The main agent writing to it by itself (SendMessage): what it said, unless it was yours passed on.
  if (e.type === "tool_use" && e.name === "SendMessage" && !e.parent && typeof e.input?.message === "string") {
    const id = subId();
    const to = e.input.to ?? e.input.recipient;
    if (!id || to !== id || sub.texts.has(e.input.message.trim())) return null;
    sub.texts.add(e.input.message.trim());
    return put(fromClaude({ ...e, text: e.input.message }));
  }
  if (!e.parent) return null;
  if (e.parent === sub.toolUseId) {
    if (e.type !== "user") return addChild(sub.card, e);
    if (e.you) return put(userBubble(e));
    const text = String(e.text ?? "").trim();
    if (!text || sub.texts.has(text)) return null;
    sub.texts.add(text);
    return put(fromClaude(e));
  }
  // Its own subagents' work goes in their cards, as in the main view.
  const card = state.tools.get(e.parent);
  return card && !card.hidden ? addChild(card, e) : null;
}

/** What the main agent told a subagent (its task, a message): long ones fold. */
function fromClaude(e) {
  const text = String(e.text ?? "");
  const body = h("div", { class: "md-wrap" }, markdown(text));
  const el = h("div", { class: `msg-user from-claude${text.length > 600 ? " long" : ""}` },
    h("div", { class: "from" }, icon("bot", 12), "From the main agent"), body);
  if (text.length > 600) {
    const more = h("button", { class: "btn ghost small more-btn" }, "Show all");
    more.addEventListener("click", () => {
      el.classList.toggle("long");
      more.textContent = el.classList.contains("long") ? "Show all" : "Show less";
    });
    el.append(more);
  }
  return h("div", { class: "user-wrap from-claude-wrap" }, el, when(e.ts));
}

/** Your message to a subagent, in the main conversation: one line that opens the subagent. */
function relayLine(e) {
  const a = state.agents.get(e.relay.toolUseId);
  const name = e.relay.description || a?.description || "a subagent";
  const el = h("button", { class: "relay-line", title: "Open the subagent" }, icon("send", 12),
    h("span", { class: "who" }, `To subagent “${name}”`), h("span", { class: "t" }, e.text),
    e.images?.length ? h("span", { class: "muted" }, ` · ${e.images.length} image(s)`) : null);
  el.addEventListener("click", () => void openSub(e.relay.toolUseId));
  return h("div", { class: "relay-wrap" }, el, when(e.ts));
}

/** The bar above a subagent's view: back, what it is, its state. */
function renderSubbar() {
  const bar = $("subbar");
  const a = state.sub && state.agents.get(state.sub.toolUseId);
  if (!a) {
    bar.hidden = true;
    return bar.replaceChildren();
  }
  const { status, model } = agentInfo(a);
  const backTo = state.subStack.length ? state.agents.get(state.subStack.at(-1)) : null;
  const back = h("button", { class: "btn ghost small" }, "← ",
    backTo ? `Back to “${backTo.description || "subagent"}”` : "Main thread");
  back.addEventListener("click", () => closeSub());
  const toMain = backTo ? h("button", { class: "btn ghost small" }, "Main thread") : null;
  toMain?.addEventListener("click", () => closeSub({ all: true }));
  bar.replaceChildren(...[back, toMain].filter(Boolean), h("span", { class: `dot ${SUB_DOT[status] ?? ""}` }),
    h("span", { class: "sub-title", title: a.description }, a.description || "Subagent"),
    ...(a.type ? [h("span", { class: "badge" }, a.type)] : []), ...(model ? [h("span", { class: "badge", title: "Its model" }, model)] : []),
    h("span", { class: "muted" }, SUB_STATUS[status] ?? status));
  bar.hidden = false;
}

/** The composer writes to the subagent shown, or to the main agent. */
function renderComposerMode() {
  input.placeholder = state.sub ? "Message this subagent…  (the main agent passes it on word for word)" : PLACEHOLDER;
  renderPrefix();
  renderWorking();
}

/** The thread's subagents, above the composer: each opens its conversation. */
function renderSubagents() {
  const el = $("subagents");
  const list = [...state.agents.values()].filter((a) => !a.parent || !state.agents.has(a.parent));
  if (!list.length) {
    el.hidden = true;
    return el.replaceChildren();
  }
  const infos = list.map((a) => ({ a, ...agentInfo(a) }));
  const running = infos.filter((i) => i.status === "running").length;
  const wasOpen = el.querySelector("details")?.open ?? false;
  for (const { a, model } of infos) setCardModel(a.toolUseId, model);
  const rows = infos.slice().reverse().map(({ a, status, model }) => {
    const row = h("button", { class: `sub-item${state.sub?.toolUseId === a.toolUseId ? " on" : ""}`, title: a.prompt },
      h("span", { class: `dot ${SUB_DOT[status] ?? ""}` }), h("span", { class: "t" }, a.description || "Subagent"),
      h("span", { class: "k" }, [a.type, model, SUB_STATUS[status] ?? status].filter(Boolean).join(" · ")));
    row.addEventListener("click", () => void openSub(a.toolUseId, { push: false }));
    return row;
  });
  el.replaceChildren(h("details", { open: wasOpen },
    h("summary", {}, icon("bot", 14), `${list.length} subagent${list.length > 1 ? "s" : ""}`,
      running ? h("span", { class: "muted" }, `· ${running} working`) : null,
      h("span", { class: "muted hint" }, "open one to see it and write to it")),
    h("div", { class: "sub-list" }, rows)));
  el.hidden = false;
}

/** The model on a subagent's Agent card (it is known once the subagent answers). */
function setCardModel(toolUseId, model) {
  const card = state.tools.get(toolUseId);
  if (card?.model && card.model.textContent !== (model ?? "")) {
    card.model.textContent = model ?? "";
    card.model.hidden = !model;
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
  // 0.9.0: sent by layr, not you: the turn the usage limit stopped goes on.
  if (e.auto === "limit") {
    return h("div", { class: "user-wrap" }, h("div", { class: "msg-user auto", title: e.text },
      icon("refresh", 13), "Went on after the usage limit"), when(e.ts));
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
  const foot = h("div", { class: "user-foot" }, when(e.ts));
  if (!e.steer) {
    const title = "Go back to before this message: it and what came after leave the chat";
    const back = h("button", { class: "go-back", title }, icon("undo", 12), "Go back");
    back.addEventListener("click", () => void goBack(e, foot));
    foot.append(back);
  }
  return h("div", { class: "user-wrap" }, el, foot);
}

/** Claude is working (or its background tasks are): going back waits. */
function isBusy(t) {
  return Boolean(t) && (["running", "waiting", "starting"].includes(t.status) || Boolean(t.background?.length));
}

/**
 * Go back to before the message `e`, after a warning in place of its foot: it and everything after it leave the chat
 * and Claude's memory, files stay; its text and images come back into the composer.
 */
async function goBack(e, foot) {
  if (isBusy(state.thread)) {
    notify("Claude is working: stop it first, then go back", "error");
    return;
  }
  const at = main.turns.findIndex((t) => t.user === foot.parentElement);
  const later = at >= 0 ? main.turns.length - at - 1 : 0;
  const after = later ? ` and the ${later} message${later > 1 ? "s" : ""} after it` : "";
  const text = `Go back to before this message? It${after}, with Claude's work, leave the chat, and Claude forgets ` +
    "them. Files are not changed back: what Claude edited stays.";
  if (!(await confirmIn(foot, text, { ok: "Go back", danger: true }))) return;
  try {
    const r = await call("thread_go_back", { thread: state.id, seq: e.seq });
    const typed = input.value.trim();
    input.value = typed ? `${r.text}

${typed}` : r.text;
    const images = (r.images ?? []).map((i) => ({ ...i, url: `data:${i.mediaType};base64,${i.data}` }));
    state.attachments = [...images, ...state.attachments];
    renderAttachments();
    autosize();
    saveDraft();
    if (r.thread) setThread(r.thread);
    await reloadTranscript();
    input.focus();
  } catch (error) {
    notify(error.message, "error");
  }
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
  if (state.picks.sent) return { picked: state.picks.picked, locked: true };
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
  return state.picks.sent ? "" : picksText();
}

/** The picks as words, sent or not. */
function picksText() {
  const l = state.latest;
  if (!l || state.picks.replyId !== l.entry.id) return "";
  return answerPrefix(questionsOf(l.sections), state.picks.picked);
}

function renderPrefix() {
  const el = $("prefix");
  if (state.picks.sent && !state.sub && picksText()) {
    el.hidden = false;
    return el.replaceChildren(h("span", { class: "label" }, "Sent, waiting to reach the thread:"),
      h("span", { class: "text sent" }, picksText()));
  }
  const text = state.sub ? "" : currentPrefix();
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
  // A subagent's card opens its conversation, where you can write to it too.
  let open = null;
  let model = null;
  if (e.name === "Agent" || e.name === "Task") {
    model = h("span", { class: "badge sub-model", title: "The subagent's model", hidden: true });
    open = h("button", { class: "btn ghost small open-sub", title: "Open this subagent's conversation; you can write to it there" },
      "Open");
    open.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openSub(e.id);
    });
  }
  const el = h("details", { class: "tool" },
    h("summary", {}, chev, toolIcon(e.name), h("span", { class: "name" }, toolLabel(e.name)),
      h("span", { class: "sum", title: summary }, summary), model, open, stateEl),
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
  const card = { el, state: stateEl, body, children, name: e.name, done: false, id: e.id, model };
  state.tools.set(e.id, card);
  const a = model && state.agents.get(e.id);
  if (a) setCardModel(e.id, agentInfo(a).model);
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

const TURN_END_ICON = { done: "check", failed: "x", paused: "clock" };

function turnEnd(e) {
  const bits = [];
  if (e.status === "done") bits.push("Done");
  else if (e.status === "interrupted") bits.push("Stopped");
  else if (e.status === "paused") bits.push("Paused for the usage limit");
  else bits.push(`Failed${e.error ? `: ${e.error}` : ""}`);
  if (e.durationMs) bits.push(duration(e.durationMs));
  if (typeof e.costUsd === "number" && e.costUsd > 0) bits.push(money(e.costUsd));
  if (e.usage?.outputTokens) bits.push(`${tokens(e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens)} in · ${tokens(e.usage.outputTokens)} out`);
  return h("div", { class: `turn-end ${e.status}` }, icon(TURN_END_ICON[e.status] ?? "stop", 13), bits.join(" · "));
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
  if (state.sub && state.approvals !== state.sub.approvals) inSub(refreshApprovals);
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
        ? e.kind === "question" ? `${e.questions?.length === 1 ? `${e.questions[0].question} → ` : "Answered: "}${formatAnswers(answer.answers)}` : e.kind === "plan" ? "Plan approved" : e.kind === "plugin" ? `${e.title}: allowed` : "Allowed"
        : decision === "allow_always" ? e.kind === "plugin" ? `${e.title}: allowed, and every plugin in this thread` : "Allowed for this thread"
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
  if (e.kind === "plugin") return a.el.replaceChildren(pluginRequestCard(e));
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

/** 0.7.0: Claude asks to change a plugin of the thread's list (plugin_change): allow, allow every plugin, refuse. */
function pluginRequestCard(e) {
  const msg = h("input", { class: "input", placeholder: "Tell Claude why, or what to do instead (optional)" });
  const allow = h("button", { class: "btn small primary" }, icon("check", 14), "Allow");
  const always = h("button", { class: "btn small", title: "Claude may change any plugin it asks for in this thread" },
    "Allow every plugin");
  const deny = h("button", { class: "btn small danger" }, "Refuse");
  const buttons = [allow, always, deny];
  allow.addEventListener("click", () => answer(e, { decision: "allow" }, buttons));
  always.addEventListener("click", () => answer(e, { decision: "allow_always" }, buttons));
  deny.addEventListener("click", () => answer(e, { decision: "deny", message: msg.value.trim() || undefined }, buttons));
  msg.addEventListener("keydown", (ev) => ev.key === "Enter" && deny.click());
  return h("div", { class: "approval" },
    h("div", { class: "ask" }, icon("box"), e.title),
    e.reason ? h("div", { class: "reason" }, e.reason) : null,
    h("div", { class: "muted", style: { fontSize: "12px" } },
      "Every change is saved as a version: you can take back what this thread changed at any time."),
    h("div", { class: "actions" }, allow, always, deny, msg));
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
  document.body.classList.toggle("busy", isBusy(t));
  $("status-dot").classList.toggle("paused", Boolean(t.limitPause));
  $("status-label").textContent = `${statusLabel(t)}${t.archived ? " · archived" : ""}`;
  const ws = t.workspace ?? {};
  const wsEl = $("workspace");
  wsEl.replaceChildren(icon(ws.kind === "worktree" ? "branch" : "folder", 12), ws.kind === "worktree" ? ws.branch ?? "worktree" : ws.branch ? `${short(ws.path)} · ${ws.branch}` : short(ws.path));
  wsEl.title = ws.path ?? "";
  // A thread on a plugin or an extension (0.3.2) says which, instead of the folder; one with a plugin list (0.7.0)
  // how many it has (the list is the bar under the header). A thread in a project with a plugin list (0.11.0) keeps
  // its folder and branch here.
  if (t.target?.kind === "plugins") {
    const n = t.plugins.length;
    wsEl.replaceChildren(icon("box", 12), n ? `${n} plugin${n === 1 ? "" : "s"}` : "no plugin yet");
    wsEl.title = `The plugins this thread may read and change · its own folder ${ws.path ?? ""}`;
  } else if (t.target?.plugin) {
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
  renderSubagents();
  renderSubbar();
  renderTodos(t.todos ?? []);
  renderGone(t);
  renderQueue(t);
  renderPickers();
  renderWorking();
  renderPlugins(t);
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
  el.classList.toggle("waiting", t?.status === "waiting" || Boolean(t?.limitPause));
  $("stop").hidden = !isBusy;
  $("steer").hidden = !isBusy || !input.value.trim() || Boolean(state.task);
  // 🌙 When away needs the pipeline (state.task is undefined without it). A pipeline that gives the task's toggles
  // makes it a switch: on, what you send waits for Away (not while it plans: planning needs you).
  const away = awayOn();
  const waits = away && !state.task?.planning;
  $("send").textContent = waits ? "🌙 Send when away" : isBusy && !state.task ? "Queue" : "Send";
  $("away").hidden = state.task === undefined || Boolean(state.task?.toggles);
  $("away").classList.toggle("on", away);
  $("hint").textContent = waits ? "Waits for Away" : state.task ? "Sent through the pipeline" : isBusy ? "Enter queues · Ctrl+Enter steers" : "";
  if (state.sub) {
    const id = subId();
    $("send").textContent = "Send to subagent";
    $("steer").hidden = true;
    $("away").hidden = true;
    $("hint").textContent = id ? "The main agent passes it on" : "It can't take messages: its id isn't known";
  }
  clearInterval(workingTimer);
  if (!isBusy) return;
  const tick = () => {
    const secs = state.turnStartedAt ? Math.round((Date.now() - state.turnStartedAt) / 1000) : null;
    $("working-text").textContent =
      t.limitPause ? `Paused for the usage limit · goes on at ${clock(t.limitPause.until)}`
      : t.status === "waiting" ? `Waiting for your answer${state.sub ? "" : " above"}`
        : `${state.sub ? "Main agent working" : "Working"}${secs != null ? ` · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : "…"}`;
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

/** 0.3.12: the thread's folder is gone: a worktree comes back with the next message or Restore worktree now. */
function renderGone(t) {
  const el = $("gone");
  if (!t.folderGone) {
    el.hidden = true;
    return;
  }
  if (el.dataset.path === t.cwd && !el.hidden) return;
  el.dataset.path = t.cwd ?? "";
  const worktree = t.workspace?.kind === "worktree";
  const branch = t.workspace?.branch ? ` (branch ${t.workspace.branch})` : "";
  const text = worktree
    ? `This thread's worktree is gone${branch}: ${t.cwd}. It is made again from the newest base when you send a ` +
      "message, or now."
    : `This thread's folder is gone: ${t.cwd}. Claude can't work here any more.`;
  const tip = "Make the worktree again in the same folder now (files that were never committed don't come back)";
  const restore = worktree
    ? h("button", { class: "btn small primary", title: tip }, icon("branch", 13), "Restore worktree")
    : null;
  restore?.addEventListener("click", async () => {
    restore.disabled = true;
    try {
      const r = await call("thread_restore_workspace", { thread: state.id });
      if (r.thread) setThread(r.thread);
    } catch (error) {
      notify(error.message, "error");
      restore.disabled = false;
    }
  });
  el.replaceChildren(h("span", { class: "t" }, text), restore);
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
  // What "Default" stands for: the model Claude Code said it runs (while none is picked), Claude Code's settings.
  const defaults = t.defaults ?? {};
  const defaultName = defaultModelName(state.models, { resolved: t.model ? null : t.resolvedModel,
    setting: defaults.model });
  const opts = modelOptions(models, { defaultName });
  if (t.model && !opts.some((o) => o.value === t.model)) opts.push({ value: t.model, label: t.model });
  if (document.activeElement !== modelSel) fillSelect(modelSel, opts, t.model ?? "");
  const effortSel = $("effort");
  const eopts = effortOptions(models, t.model ?? "default", { defaultEffort: defaults.effort });
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
      ? { label: "History and undo", icon: "history", run: () => openLink(pluginPageLink(t.target.plugin, "history")) }
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
/** The saved draft is in the text box (before that, `boxSent` waits: the box would look empty). */
let draftReady = false;
async function refreshTask() {
  const task = await threadTask(state.id);
  state.task = task;
  // 🌙 When away went off with messages waiting: they come back into the text box, unsent.
  if (task?.unsent) {
    input.value = input.value.trim() ? `${input.value.replace(/\s+$/, "")}\n\n${task.unsent}` : task.unsent;
    autosize();
    notify("When away is off: your unsent message is back in the text box", "info");
    saveDraft();
    void pipelineCall("thread_action", { thread: state.id, action: "unsent_taken" }).catch(() => {});
  }
  // Away sent what waited from the text box: the box empties, unless it holds something typed after that.
  if (typeof task?.boxSent === "string" && draftReady) {
    if (composerText().trim() === task.boxSent.trim()) clearBox();
    void pipelineCall("thread_action", { thread: state.id, action: "box_sent_taken" }).catch(() => {});
  }
  renderTaskStrip($("task"), task ?? null, state.id, () => void refreshTask(), { composerText, onSent: composerSent, syncBox, onBoxed: boxed });
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
  $("steer").hidden = !(t && (t.status === "running" || t.status === "waiting")) || !input.value.trim() || Boolean(state.task) ||
    Boolean(state.sub);
}
input.addEventListener("input", () => {
  autosize();
  renderSlash();
  renderMention();
  saveDraft();
});

input.addEventListener("keydown", (ev) => {
  if (mentionKey(ev)) return;
  if (slashKey(ev)) return;
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    send(ev.ctrlKey || ev.metaKey ? "steer" : "queue");
  }
});
$("send").addEventListener("click", () => send("queue"));
/** The task's 🌙 When away is on. */
const awayOn = () => Boolean(state.task?.toggles?.whenAway?.on);
$("away").addEventListener("click", async () => {
  // Not a task yet: it becomes one, and (a pipeline with toggles) its 🌙 When away goes on; what you typed then
  // waits for Away. An older pipeline: 🌙 sends this one message for Away.
  if (state.task !== null) return send("queue", { away: true });
  $("away").disabled = true;
  try {
    const number = (await pipelineCall("act", { action: "adopt", threadId: state.id }))?.number;
    if (number == null) throw new Error("The thread couldn't become a pipeline task");
    await refreshTask();
    if (!state.task?.toggles) return send("queue", { away: true });
    await pipelineCall("thread_action", { thread: state.id, action: "toggle_away", on: true });
    await refreshTask();
    if (input.value.trim() || state.attachments.length) await send("queue");
    else notify("🌙 When away is on: what you send waits until you're Away", "success");
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("away").disabled = false;
  }
});
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

/**
 * What Send would send to the main agent now: the picked answers ("My answers: …"), then what is typed. The task
 * strip's Approve and Send now take it along (empty in a subagent's view: its text is for that subagent).
 */
function composerText() {
  if (state.sub) return "";
  const typed = input.value;
  const prefix = currentPrefix();
  return prefix ? (typed.trim() ? `${prefix}

${typed}` : prefix) : typed.trim() ? typed : "";
}

/**
 * The task strip sent composerText(): the text box goes empty; pictures stay for a message of their own. The picks
 * stay in the reply, locked, until the message is in the thread (picksArrived).
 */
function composerSent() {
  input.value = "";
  holdPicks();
  renderLatest();
  renderSlash();
  autosize();
  if (state.attachments.length) saveDraft();
  else void drafts.clear(state.id);
}

/** Keep the picks showing, locked, until your message reaches the thread; none: nothing to keep. */
function holdPicks() {
  if (hasPicks(state.picks.picked)) state.picks.sent = true;
  else state.picks.picked = {};
}

/** Your message is in the thread: the picks it took along go. */
function picksArrived(e) {
  if (!state.picks.sent || e.type !== "user" || e.parent || e.relay) return;
  state.picks = { replyId: state.picks.replyId, picked: {} };
  renderLatest();
}

// ------------------------------------------------------------------ the text box's waiting item (🌙)
// With the task's When away on, Send and Approve leave the text in the box: what waits for Away is the box itself, kept
// up to date here (pipeline thread_action box_text), sent as it is when Away comes (then `boxSent` empties the box).

let boxTimer = null;
/** What the images last sent to the box's waiting item were (null: not sent from this panel yet). */
let boxImages = null;
const imagesKey = () => state.attachments.map((a) => `${a.mediaType}:${a.data.length}:${a.data.slice(-24)}`).join("|");

/** Bring the box's waiting item up to date with the box (`now`: at once, else after a pause in typing). */
function syncBox(now = false) {
  clearTimeout(boxTimer);
  if (!state.task?.box || state.sub) return Promise.resolve();
  const go = async () => {
    const key = imagesKey();
    const images = key !== boxImages ? state.attachments.map(({ mediaType, data }) => ({ mediaType, data })) : undefined;
    try {
      const r = await pipelineCall("thread_action", { thread: state.id, action: "box_text", text: composerText(), ...(images ? { images } : {}) });
      if (images) boxImages = key;
      if (r?.boxWaits === false) void refreshTask();
    } catch (error) {
      notify(`Pipeline: ${error.message}`, "error");
    }
  };
  if (now) return go();
  boxTimer = setTimeout(go, 400);
  return Promise.resolve();
}

/** Send or Approve left the text in the box: it waits for Away (`images`: they went with it). */
function boxed({ start = false, images = false } = {}) {
  boxImages = images ? imagesKey() : null;
  notify(start ? "Approved: it starts when you go Away, with what the text box holds then (Unapprove takes it back)"
    : "It waits for Away, as the text box holds it then (Unsend takes it back)", "success");
  // Approve takes no pictures along: the box's go to its item now.
  void refreshTask().then(() => !images && state.attachments.length && syncBox(true));
}

/** What Away sent from the box is in the thread: the box empties. */
function clearBox() {
  input.value = "";
  state.attachments = [];
  state.picks = { replyId: state.picks.replyId, picked: {} };
  renderAttachments();
  renderLatest();
  renderSlash();
  autosize();
  void drafts.clear(state.id);
}

/** `away`: it waits in the pipeline's Ready until the user goes Away (a thread that isn't a task becomes one first). */
async function send(mode, { away = false } = {}) {
  const typed = input.value;
  // In a subagent's view: to that subagent (the main agent passes it on), never through the pipeline.
  const toSub = state.sub && !away ? subId() : null;
  if (state.sub && !away && !toSub) return notify("This subagent can't take messages: its id isn't known", "error");
  const prefix = toSub ? "" : currentPrefix();
  const text = prefix ? (typed.trim() ? `${prefix}\n\n${typed}` : prefix) : typed;
  if (!text.trim() && !state.attachments.length) return;
  const images = state.attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const sendBtn = $(away ? "away" : "send");
  sendBtn.disabled = true;
  let heldBack = false;
  try {
    let r = null;
    if (toSub) r = await call("thread_send", { thread: state.id, text, images, agent: toSub });
    else if (away) {
      const number = state.task?.number ?? (await pipelineCall("act", { action: "adopt", threadId: state.id }))?.number;
      if (number == null) throw new Error("The thread couldn't become a pipeline task");
      await pipelineCall("send", { number, text, whenAway: true, ...(images.length ? { images } : {}) });
      notify("It waits in the pipeline's Ready until you go Away", "success");
      void refreshTask();
    } else if (state.task) {
      // The box waits for Away already: what it holds then goes; Send now (the strip) sends it at once.
      if (state.task.box) {
        await syncBox(true);
        return notify("It waits for Away already, as the text box holds it then (Send now sends it now)", "info");
      }
      // The pipeline holds it back for Away when the task's 🌙 is on: then the text stays in the box (`boxWaits`).
      const waits = awayOn() && !state.task.planning;
      const sent = await pipelineCall("send", { number: state.task.number, text, box: true, ...(images.length ? { images } : {}) });
      if (sent?.boxWaits) return boxed({ images: true });
      heldBack = waits;
      if (waits) notify("It waits in the pipeline's Ready until you go Away", "success");
      if (waits) void refreshTask();
    }
    else r = await call("thread_send", { thread: state.id, text, images, mode });
    input.value = "";
    state.attachments = [];
    // Held back for Away: the picks show, locked, until it is sent.
    if (!toSub && (away || heldBack)) holdPicks();
    else if (!toSub) state.picks.picked = {};
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

// ------------------------------------------------------------------ plugins in the thread (0.7.0)

const MODE_LABEL = {
  read: ["reads", "Claude may read it, and asks you before changing it"],
  change: ["changes", "Claude may change it: every change is saved as a version"],
};

/** The bar under the header of a thread with a plugin list: its plugins, what Claude may do with each. */
function renderPlugins(t) {
  const el = $("plugins");
  if (!Array.isArray(t.plugins)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const chips = t.plugins.map((p) => {
    const [label, title] = MODE_LABEL[p.mode] ?? MODE_LABEL.read;
    const heldTitle = p.held ? `
Held back: the app runs ${p.held.version} until you switch these changes on` +
      `${p.held.why ? ` (${p.held.why})` : ""}` : "";
    // 0.12.0: the thread's own copy: the app runs the plugin as it was until you land it (or try it).
    const copyTitle = p.copy ? `
Own copy: the app runs ${p.name} as it was until you land these changes${p.copy.trying ? " (you are trying the copy now)" : ""}` : "";
    const modeText = p.held ? "held back" : p.copy ? (p.copy.trying ? "trying copy" : "own copy") : label;
    const chip = h("button", { class: `plugin-chip ${p.mode}${p.held ? " held" : ""}${p.copy ? " copy" : ""}${p.copy?.trying ? " trying" : ""}`,
      title: `${p.name} (${p.id}${p.version ? ` ${p.version}` : ""}): ${title}${heldTitle}${copyTitle}` },
    icon(p.extension ? "puzzle" : "box", 12), h("span", { class: "name" }, p.name),
    p.version ? h("span", { class: "ver" }, p.version) : null, h("span", { class: "mode" }, modeText));
    chip.addEventListener("click", (ev) => pluginMenu(ev, p));
    chip.addEventListener("contextmenu", (ev) => pluginMenu(ev, p));
    return chip;
  });
  const add = h("button", { class: "btn ghost small", title: "Put a plugin on the list: type @ and its name" },
    icon("plus", 12), "Plugin");
  add.addEventListener("click", () => {
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at);
    input.value = `${before}${before && !/\s$/.test(before) ? " " : ""}@${input.value.slice(at)}`;
    input.focus();
    input.selectionStart = input.selectionEnd = before.length + (before && !/\s$/.test(before) ? 2 : 1);
    renderMention();
  });
  const copies = t.plugins.filter((p) => p.copy);
  const land = copies.length ? h("button", { class: "btn primary small", title: `Put this thread's changes into the app: ${copies.map((p) => p.name).join(", ")}` },
    icon("check", 12), copies.length > 1 ? `Land all (${copies.length})` : `Land ${copies[0].name}`) : null;
  land?.addEventListener("click", () => void copyAction("land", null));
  const own = h("button", { class: `btn ghost small copies-switch${t.pluginCopies ? " on" : ""}`,
    title: t.pluginCopies
      ? "Own copies on: plugins Claude may change get a copy of their own; the app runs them as they were until you land the changes. Click to change plugins in the app directly from now on."
      : "Own copies off: Claude changes plugins in the app directly (you see each change at once). Click to give plugins Claude may change a copy of their own from now on." },
  icon(t.pluginCopies ? "branch" : "sparkle", 12), t.pluginCopies ? "Own copies" : "Live");
  own.addEventListener("click", () => setPlugin({ copies: !t.pluginCopies }));
  el.replaceChildren(...[
    h("span", { class: "plugins-label", title: "What this thread may read and change. Mention a plugin with @ to " +
      "let Claude read it; Claude asks before changing one." }, "Plugins"),
    ...chips,
    t.plugins.length ? null : h("span", { class: "muted" }, "none yet: mention one with @, or Claude asks"),
    add,
    own,
    land,
    t.allowAllPlugins ? h("span", { class: "badge", title: "Claude may change any plugin it asks for in this thread" },
      "all allowed") : null,
  ].filter(Boolean));
}

async function setPlugin(args) {
  try {
    const r = await call("thread_plugin_set", { thread: state.id, ...args });
    if (r?.thread) setThread(r.thread);
  } catch (error) {
    notify(error.message, "error");
  }
}

function pluginMenu(ev, p) {
  const t = state.thread;
  void contextMenu([
    p.mode === "read"
      ? { label: "Let Claude change it", icon: "edit", run: () => setPlugin({ plugin: p.id, mode: "change" }) }
      : { label: "Read only", icon: "visibility", run: () => setPlugin({ plugin: p.id, mode: "read" }) },
    p.held ? { label: `Run these changes now (the app runs ${p.held.version})`, icon: "refresh",
      run: () => setPlugin({ plugin: p.id, held: false }) } : null,
    p.copy ? { label: "Land: put these changes into the app", icon: "check", run: () => copyAction("land", p) } : null,
    p.copy ? (p.copy.trying
      ? { label: "Stop trying: the app runs the plugin as it was", icon: "close", run: () => copyAction("untry", p) }
      : { label: "Try: the app runs this copy for now", icon: "play_arrow", run: () => copyAction("try", p) }) : null,
    p.copy ? { label: "Drop: throw these changes away", icon: "delete", run: () => copyAction("drop", p) } : null,
    p.mode === "change" && !p.copy ? { label: "Take back this thread's changes", icon: "undo", run: () => takeBack(p) } : null,
    p.place !== "inside" ? { label: "History and undo", icon: "history", run: () => openLink(pluginPageLink(p.id, "history")) } : null,
    p.extension ? { label: "Reload the extension", icon: "refresh", run: () => layr.tools.call("extension_reload", { plugin: p.id },
      { plugin: "layr" }).then(() => notify("Extension reloaded", "success"), (e) => notify(e.message, "error")) } : null,
    "-",
    t?.plugins?.filter((x) => x.mode === "change").length > 1
      ? { label: "Take back everything this thread changed", icon: "undo", run: () => takeBack(null) } : null,
    t?.allowAllPlugins ? { label: "Ask again before changing plugins", icon: "lock", run: () => setPlugin({ allowAll: false }) } : null,
    { label: "Take it off the list", icon: "close", run: () => setPlugin({ plugin: p.id, remove: true }) },
  ], ev);
}

/**
 * 0.12.0: an own copy's Land / Drop / Try / Stop trying (`p` null: every copy, land and drop only). A clash on land
 * offers to let Claude resolve it in the copy.
 */
async function copyAction(action, p) {
  const holder = $("plugins");
  if (action === "drop" && !(await confirmIn(holder, `Throw away this thread's changes to ${p ? p.name : "every plugin"}? The plugin stays as the app runs it.`,
    { ok: "Drop", danger: true }))) return;
  try {
    const r = await call("thread_plugin_copy", { thread: state.id, action, ...(p ? { plugin: p.id } : {}) });
    if (r?.thread) setThread(r.thread);
    const results = r?.results ?? [];
    if (action === "try" || action === "untry") {
      notify(action === "try" ? `The app runs your copy of ${p.name} now` : `The app runs ${p.name} as it was again`, "success");
      return;
    }
    const clashes = results.filter((x) => x.landed === false);
    const done = results.filter((x) => x.landed || x.dropped).map((x) => x.plugin);
    if (done.length) notify(`${action === "land" ? "Landed" : "Dropped"}: ${done.join(", ")}`, "success");
    if (clashes.length && (await confirmIn(holder, `${clashes.map((x) => x.plugin).join(", ")} changed meanwhile and clashes with ` +
      `this thread's changes (${clashes.flatMap((x) => x.conflicts).join(", ")}). Let Claude resolve it, then land again?`,
    { ok: "Let Claude resolve it" }))) {
      const text = clashes.map((x) => x.prompt).filter(Boolean).join("\n\n");
      const s = await call("thread_send", { thread: state.id, text });
      if (s?.thread) setThread(s.thread);
    }
  } catch (error) {
    notify(error.message, "error");
  }
}

/** Undo what this thread changed in a plugin (null: in every plugin it may change), after asking. */
async function takeBack(p) {
  const what = p ? p.name : "every plugin";
  const holder = $("plugins");
  if (!(await confirmIn(holder, `Take back everything this thread changed in ${what}? Each undo is saved as a new version.`,
    { ok: "Take back", danger: true }))) return;
  try {
    const r = await call("thread_take_back", { thread: state.id, ...(p ? { plugin: p.id } : {}) });
    const failed = (r.results ?? []).filter((x) => x.error);
    if (failed.length) notify(`Stopped: ${failed.map((x) => `${x.plugin}: ${x.error}`).join("; ")}`, "error");
    else notify(`Taken back: ${(r.results ?? []).map((x) => `${x.plugin} (${x.undone})`).join(", ")}`, "success");
  } catch (error) {
    notify(error.message, "error");
  }
}

// `@` in the message of a thread with a plugin list: a picker of installed plugins (and, after `@id@`, their versions).
let mentionShown = [];
let mentionIndex = 0;
let pluginCatalog = null;

/** The `@word` being typed right before the caret, or null. */
function mentionAt() {
  const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(^|[\s(\[{,;"'])@([\w.@-]*)$/.exec(upto);
  return m ? { q: m[2], start: upto.length - m[2].length - 1, end: upto.length } : null;
}

function renderMention() {
  const el = $("slash");
  const m = Array.isArray(state.thread?.plugins) ? mentionAt() : null;
  if (!m) {
    if (mentionShown.length) el.hidden = true;
    mentionShown = [];
    return;
  }
  if (!pluginCatalog) {
    pluginCatalog = [];
    void call("targets_list").then((r) => {
      pluginCatalog = r.targets ?? [];
      renderMention();
    }, () => (pluginCatalog = null));
    return;
  }
  const [idq, verq] = m.q.toLowerCase().split("@");
  const match = (t) => !idq || t.id.includes(idq) || t.name.toLowerCase().includes(idq);
  const rows = [];
  for (const t of pluginCatalog.filter(match).sort((a, b) => Number(!a.id.startsWith(idq)) - Number(!b.id.startsWith(idq)) ||
    a.name.localeCompare(b.name))) {
    if (verq === undefined) {
      rows.push({ t, version: null, source: null, text: t.description || PLACE_TEXT[t.place] || "" });
      continue;
    }
    const main = t.sources?.[0]?.source ?? null;
    for (const s of t.sources ?? []) {
      for (const v of s.versions.filter((x) => x.startsWith(verq))) {
        rows.push({ t, version: v, source: s.source === main ? null : s.source,
          text: `${v === t.version ? "the version that runs · " : ""}${s.text}` });
      }
    }
  }
  mentionShown = rows.slice(0, 50);
  if (!mentionShown.length) {
    el.hidden = true;
    return;
  }
  mentionIndex = Math.min(mentionIndex, mentionShown.length - 1);
  el.replaceChildren(...mentionShown.map((r, i) => {
    const row = h("button", { class: `slash-row${i === mentionIndex ? " on" : ""}` },
      h("span", { class: "name" }, `@${r.t.id}${r.version ? `@${r.version}` : ""}`),
      h("span", { class: "hint" }, r.version ? "" : r.t.name), h("span", { class: "desc" }, r.text));
    row.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      void pickMention(r);
    });
    return row;
  }));
  el.hidden = false;
  el.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

const PLACE_TEXT = { made: "yours", changed: "your copy of a store plugin", store: "from the store", inside: "in a repository" };

/** Puts `@id` (or `@id@version`) into the message and the plugin on the list, to read. */
async function pickMention(r) {
  const m = mentionAt();
  if (!m) return;
  const token = `@${r.t.id}${r.version ? `@${r.version}` : ""} `;
  input.value = input.value.slice(0, m.start) + token + input.value.slice(m.end);
  input.selectionStart = input.selectionEnd = m.start + token.length;
  mentionShown = [];
  mentionIndex = 0;
  $("slash").hidden = true;
  autosize();
  saveDraft();
  input.focus();
  try {
    const r2 = await call("thread_plugin_add", { thread: state.id, plugin: r.t.id, mode: "read",
      ...(r.version && r.version !== r.t.version ? { version: r.version } : {}), ...(r.source ? { source: r.source } : {}) });
    if (r2?.thread) setThread(r2.thread);
  } catch (error) {
    notify(error.message, "error");
  }
}

function mentionKey(ev) {
  if ($("slash").hidden || !mentionShown.length) return false;
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    mentionIndex = (mentionIndex + (ev.key === "ArrowDown" ? 1 : -1) + mentionShown.length) % mentionShown.length;
    renderMention();
  } else if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey)) {
    void pickMention(mentionShown[mentionIndex]);
  } else if (ev.key === "Escape") {
    $("slash").hidden = true;
    mentionShown = [];
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
    picks: hasPicks(state.picks.picked) && !state.picks.sent
      ? { replyId: state.picks.replyId, picked: state.picks.picked }
      : null,
    answers: state.answers,
  });
  void syncBox();
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
draftReady = true;
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
