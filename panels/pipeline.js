// The strip at the top of a thread that is a pipeline task (it replaces the pipeline's old Task page): `#N · column`
// (opens the task in the pipeline), its title, the note or why, the brief (what / asks you / if wrong, stakes) to
// unfold, the landing state and its problem, and the task's buttons (`pipeline__thread_action`), with an in-panel
// confirm where a button asks for one. The task comes from `pipeline__thread_task` (ui.js threadTask).
import { h, icon, notify } from "./common.js";
import { inlineMarkdown, markdown } from "./render.js";
import { confirmIn, onPhone, openLink, pipelineCall } from "./ui.js";

const COLUMN = { proposed: "Proposed", ready: "Ready", running: "Running", stopped: "Stopped", settled: "Settled" };
const STAKES_TONE = { high: "danger", medium: "warn", low: "" };

/** Keeps the brief open or closed across redraws (every refresh draws the strip anew). */
let briefOpen = false;

/** Draw `task` into `el` (hidden when null). `onDone()` after a button ran (to refresh). */
export function renderTaskStrip(el, task, threadId, onDone) {
  if (!task) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  const column = COLUMN[task.column] ?? task.column ?? "";
  const head = h("button", { class: "task-id", title: "Open the task in the pipeline" }, `#${task.number}`, column ? ` · ${column}` : "");
  head.addEventListener("click", () => task.link && openLink(task.link));
  const note = task.note || task.why;
  const parts = [
    h("div", { class: "task-head" }, icon("list", 14), head,
      task.planning ? h("span", { class: "chip warn", title: "The task's thread plans first" }, "planning") : null,
      task.stakes ? h("span", { class: `chip ${STAKES_TONE[task.stakes] ?? ""}`, title: "What's at stake if it's wrong" }, `stakes: ${task.stakes}`) : null,
      h("span", { class: "task-title" }, inlineMarkdown(task.title ?? ""))),
  ];
  if (note) parts.push(h("div", { class: "task-note" }, inlineMarkdown(note)));
  if (task.landing?.state) {
    const bad = Boolean(task.landing.problem);
    parts.push(h("div", { class: `task-landing${bad ? " bad" : ""}` }, icon(bad ? "x" : "branch", 13),
      h("span", {}, `Landing: ${task.landing.state}`), bad ? h("span", { class: "problem" }, ` · ${task.landing.problem}`) : null));
  }
  const b = task.brief;
  if (b && (b.what || b.asks || b.ifWrong)) {
    const det = h("details", { class: "task-brief", open: briefOpen },
      h("summary", {}, icon("chevron", 12), "Brief"),
      b.what ? h("div", { class: "brief-row" }, h("b", {}, "What"), markdown(b.what)) : null,
      b.asks ? h("div", { class: "brief-row asks" }, h("b", {}, "Asks you"), markdown(b.asks)) : null,
      b.ifWrong ? h("div", { class: "brief-row" }, h("b", {}, "If wrong"), markdown(b.ifWrong)) : null);
    det.querySelector(".icon").classList.add("chev");
    det.addEventListener("toggle", () => (briefOpen = det.open));
    parts.push(det);
  }
  // `pc` buttons open a window on the PC (▶ Try): no use on a phone.
  const phone = onPhone();
  const buttons = (task.buttons ?? []).filter((btn) => !(phone && btn.pc)).map((btn) => {
    const kind = btn.kind === "primary" ? " primary" : btn.kind === "danger" ? " danger" : "";
    const el2 = h("button", { class: `btn small${kind}` }, btn.label);
    el2.addEventListener("click", async () => {
      if (btn.confirm && !(await confirmIn(actions, btn.confirm, { ok: btn.label, danger: btn.kind === "danger" }))) return;
      for (const x of actions.querySelectorAll("button")) x.disabled = true;
      try {
        await pipelineCall("thread_action", { thread: threadId, action: btn.id });
      } catch (error) {
        notify(`Pipeline: ${error.message}`, "error");
      } finally {
        for (const x of actions.querySelectorAll("button")) x.disabled = false;
        onDone?.();
      }
    });
    return el2;
  });
  const actions = h("div", { class: "task-actions" }, buttons);
  if (buttons.length) parts.push(actions);
  el.replaceChildren(...parts);
}
