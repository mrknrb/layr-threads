// The thread panel: one Claude Code conversation, live. Loads the transcript with thread_transcript, then follows
// the claude:thread.<id> events (entries, text deltas, status).
import {
  STATUS_LABEL,
  call,
  duration,
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
  tokens,
} from "./common.js";
import { markdown, toolIcon, toolInputView, toolLabel, toolSummary } from "./render.js";

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
};

// ------------------------------------------------------------------ start

const layr = await ready();
state.id = layr.info?.params?.thread ?? layr.info?.state?.thread ?? new URLSearchParams(location.search).get("thread");
if (!state.id) {
  log.replaceChildren(h("div", { class: "empty" }, "No thread to show. Open one from Claude threads."));
  throw new Error("no thread");
}
layr.panel.setState({ thread: state.id });
$("attach").append(icon("image"));

on(`claude:thread.${state.id}`, (ev) => {
  if (!state.loaded) state.buffered.push(ev);
  else handleEvent(ev);
});


// ------------------------------------------------------------------ loading

async function loadTranscript() {
  try {
    const r = await call("thread_transcript", { thread: state.id, limit: 1500 });
    log.replaceChildren();
    state.more = r.more;
    state.pending = new Set(r.pending ?? []);
    if (r.more) log.append(loadMoreButton());
    for (const e of r.entries) addEntry(e, { initial: true });
    state.firstSeq = r.entries[0]?.seq ?? null;
    setThread(r.thread);
    state.loaded = true;
    for (const ev of state.buffered.splice(0)) handleEvent(ev);
    refreshApprovals();
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
    // Render the older entries into a holder, then move them in front of what is shown.
    const holder = h("div");
    for (const e of r.entries) addEntry(e, { initial: true, target: holder });
    btn.remove();
    log.prepend(...(r.more ? [btn] : []), ...holder.childNodes);
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
    scrollToBottom();
  } finally {
    filling = false;
  }
}

// ------------------------------------------------------------------ entries

function addEntry(e, { initial = false, target } = {}) {
  if (!target) state.lastSeq = Math.max(state.lastSeq, e.seq);
  const parentCard = e.parent ? state.tools.get(e.parent) : null;
  const container = target ?? (parentCard ? parentCard.children : log);
  const put = (el) => {
    if (parentCard) parentCard.children.hidden = false;
    container.append(el);
    return el;
  };
  switch (e.type) {
    case "created":
      return put(h("div", { class: "sys" }, `Started in ${e.workspace?.kind === "worktree" ? `worktree ${e.workspace.branch}` : e.workspace?.path ?? ""}`));
    case "user":
      return put(userBubble(e));
    case "turn_start":
      state.turnStartedAt = Date.parse(e.ts);
      return null;
    case "text": {
      const liveBlock = state.live.get(e.id);
      const el = h("div", { class: "msg-text" }, markdown(e.text));
      if (liveBlock) {
        liveBlock.el.replaceWith(el);
        state.live.delete(e.id);
        return el;
      }
      return put(el);
    }
    case "thinking": {
      const liveBlock = state.live.get(e.id);
      const el = thinkingBlock(e.text, false);
      if (liveBlock) {
        el.open = liveBlock.el.open;
        liveBlock.el.replaceWith(el);
        state.live.delete(e.id);
        return el;
      }
      return put(el);
    }
    case "tool_use":
      if (e.name === "AskUserQuestion" || e.name === "ExitPlanMode") {
        state.tools.set(e.id, { hidden: true, name: e.name });
        return null;
      }
      return put(toolCard(e));
    case "tool_result": {
      const card = state.tools.get(e.id);
      if (!card || card.hidden) return null;
      setToolResult(card, e);
      return null;
    }
    case "approval":
      return addApproval(e, put);
    case "approval_answer":
      state.answered.set(e.requestId, e);
      state.pending.delete(e.requestId);
      renderApproval(e.requestId);
      return null;
    case "turn_end":
      clearLive();
      state.turnStartedAt = null;
      for (const card of state.tools.values()) if (card.state && !card.done) markToolUnfinished(card);
      return put(turnEnd(e));
    case "system":
      if (e.subtype === "init") {
        if (!e.failedMcp?.length) return null;
        return put(h("div", { class: "sys warn" }, `Could not connect: ${e.failedMcp.join(", ")}`));
      }
      return put(h("div", { class: "sys" }, e.text));
    case "error":
      return put(h("div", { class: "error-box" }, e.message));
    default:
      return null;
  }
  void initial;
}

function userBubble(e) {
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
  return el;
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
    log.append(el);
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
      ...(e.kind === "plan" && e.plan ? [h("div", { class: "approval" , style: { borderColor: "var(--border)", background: "var(--bg-2)" } },
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

async function answer(e, args, buttons) {
  for (const b of buttons) b.disabled = true;
  try {
    await call("answer_approval", { thread: state.id, requestId: e.requestId, ...args });
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
  const el = h("div", { class: `approval${inline ? " inline" : ""}` },
    h("div", { class: "ask" }, icon("shield"), what),
    e.reason || e.blockedPath ? h("div", { class: "reason" }, [e.reason, e.blockedPath].filter(Boolean).join(" · ")) : null,
    inline ? null : toolInputView(e.tool, e.input),
    h("div", { class: "actions" }, allow, e.canAlwaysAllow !== false ? always : null, deny, msg),
  );
  return el;
}

function describePermission(e) {
  const s = toolSummary(e.tool, e.input);
  const verbs = { Bash: "run a command", PowerShell: "run a command", Write: "create a file", Edit: "edit a file",
    MultiEdit: "edit a file", NotebookEdit: "edit a notebook", WebFetch: "open a web page", WebSearch: "search the web" };
  const verb = verbs[e.tool] ?? `use ${toolLabel(e.tool)}`;
  return `Claude wants to ${verb}${s && e.tool !== "Bash" ? `: ${s}` : ""}`;
}

function questionCard(e, inline) {
  const picked = e.questions.map(() => new Set());
  const others = e.questions.map(() => h("input", { class: "input", placeholder: "Or type your own answer" }));
  const submit = h("button", { class: "btn small primary" }, "Answer");
  const skip = h("button", { class: "btn small" }, "Skip");
  const qs = e.questions.map((q, qi) => {
    const opts = q.options.map((o) => {
      const btn = h("button", { class: `opt${q.multiSelect ? " multi" : ""}` }, h("span", { class: "mark" }),
        h("span", {}, h("div", {}, o.label), o.description && o.description !== o.label ? h("div", { class: "d" }, o.description) : null));
      btn.addEventListener("click", () => {
        if (q.multiSelect) picked[qi].has(o.label) ? picked[qi].delete(o.label) : picked[qi].add(o.label);
        else {
          picked[qi].clear();
          picked[qi].add(o.label);
        }
        for (const b of btn.parentElement.children) b.classList.remove("sel");
        [...btn.parentElement.children].forEach((b, i) => picked[qi].has(q.options[i].label) && b.classList.add("sel"));
        update();
      });
      return btn;
    });
    others[qi].addEventListener("input", update);
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
  $("status-label").textContent = STATUS_LABEL[t.status] ?? t.status;
  const ws = t.workspace ?? {};
  const wsEl = $("workspace");
  wsEl.replaceChildren(icon(ws.kind === "worktree" ? "branch" : "folder", 12), ws.kind === "worktree" ? ws.branch ?? "worktree" : ws.branch ? `${short(ws.path)} · ${ws.branch}` : short(ws.path));
  wsEl.title = ws.path ?? "";
  const costBits = [];
  if (t.costUsd) costBits.push(money(t.costUsd));
  if (t.contextTokens) costBits.push(`${tokens(t.contextTokens)} context`);
  $("cost").textContent = costBits.join(" · ");
  for (const id of t.pendingApprovals ?? []) state.pending.add(id);
  if (prev && prev.pendingApprovals?.join() !== t.pendingApprovals?.join()) {
    state.pending = new Set(t.pendingApprovals ?? []);
    refreshApprovals();
  }
  renderTodos(t.todos ?? []);
  renderQueue(t);
  renderPickers();
  renderWorking();
}

function short(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

let workingTimer = null;
function renderWorking() {
  const t = state.thread;
  const busy = t && (t.status === "running" || t.status === "starting" || t.status === "waiting");
  const el = $("working");
  el.hidden = !busy;
  el.classList.toggle("waiting", t?.status === "waiting");
  $("stop").hidden = !busy;
  $("steer").hidden = !busy || !input.value.trim();
  $("send").textContent = busy ? "Queue" : "Send";
  $("hint").textContent = busy ? "Enter queues · Ctrl+Enter steers" : "";
  clearInterval(workingTimer);
  if (!busy) return;
  const tick = () => {
    const secs = state.turnStartedAt ? Math.round((Date.now() - state.turnStartedAt) / 1000) : null;
    $("working-text").textContent =
      t.status === "waiting" ? "Waiting for your answer above" : `Working${secs != null ? ` · ${secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}` : "…"}`;
  };
  tick();
  workingTimer = setInterval(tick, 1000);
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

// Rename by clicking the title.
$("head").addEventListener("click", (ev) => {
  if (ev.target.id !== "title" || !state.thread) return;
  const t = state.thread;
  const heading = ev.target;
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
});

// ------------------------------------------------------------------ composer

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  const t = state.thread;
  $("steer").hidden = !(t && (t.status === "running" || t.status === "waiting")) || !input.value.trim();
}
input.addEventListener("input", autosize);

input.addEventListener("keydown", (ev) => {
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
    await call("thread_interrupt", { thread: state.id });
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("stop").disabled = false;
  }
});

async function send(mode) {
  const text = input.value;
  if (!text.trim() && !state.attachments.length) return;
  const images = state.attachments.map(({ mediaType, data }) => ({ mediaType, data }));
  const sendBtn = $("send");
  sendBtn.disabled = true;
  try {
    const r = await call("thread_send", { thread: state.id, text, images, mode });
    input.value = "";
    state.attachments = [];
    renderAttachments();
    autosize();
    if (r.thread) setThread(r.thread);
    scrollToBottom(true);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
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
      });
      return h("div", { class: "att" }, h("img", { src: a.url, alt: a.name }), del);
    }),
  );
  el.hidden = !state.attachments.length;
}

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
await loadTranscript();
input.focus();
