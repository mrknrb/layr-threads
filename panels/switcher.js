// 0.15.0: the thread panel's switcher: ☰ at the left of the head slides a list of the threads in over the panel
// (search on top, the last changed first, this one marked). A click on a thread shows it in this panel; Ctrl+click,
// a middle click or its ↗ opens it in a panel of its own (several thread panels side by side). A click on the dimmed
// rest of the panel, Esc or ☰ again closes it.
import { call, h, icon, notify, relTime, statusLabel } from "./common.js";

/**
 * Put the ☰ button into `button` and the drawer into the page. `currentId`: the thread shown now. `onPick(id)`: show
 * that thread here. `onOpen(id)`: open it in a panel of its own.
 */
export function setupSwitcher(button, { currentId, onPick, onOpen }) {
  button.append(icon("menu", 16));
  const search = h("input", { class: "input", placeholder: "Search threads", autocomplete: "off" });
  const list = h("div", { class: "sw-list" }, h("div", { class: "empty" }, "Loading…"));
  const drawer = h("aside", { class: "sw-drawer", role: "dialog", "aria-label": "Threads" },
    h("div", { class: "sw-head" }, search), list);
  const back = h("div", { class: "sw-back", hidden: true }, drawer);
  document.body.append(back);
  let threads = [];

  const close = () => {
    back.hidden = true;
    button.classList.remove("on");
  };
  const open = async () => {
    back.hidden = false;
    button.classList.add("on");
    search.value = "";
    search.focus();
    try {
      threads = (await call("thread_list", { limit: 300, archived: false })).threads ?? [];
    } catch (error) {
      list.replaceChildren(h("div", { class: "empty" }, `Can't read the threads: ${error.message}`));
      return;
    }
    draw();
  };

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = threads
      .filter((t) => !q || `${t.title} ${t.preview ?? ""} ${t.workspace?.branch ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
    if (!shown.length) {
      list.replaceChildren(h("div", { class: "empty" }, q ? "No threads match." : "No other threads."));
      return;
    }
    list.replaceChildren(...shown.map(row));
  }

  function row(t) {
    const here = t.id === currentId;
    const waiting = t.pendingApprovals?.length || t.status === "waiting";
    const pop = h("button", { class: "btn ghost small icon-only sw-pop", title: "Open in a panel of its own" }, icon("open", 13));
    pop.addEventListener("click", (ev) => {
      ev.stopPropagation();
      close();
      onOpen(t.id);
    });
    const el = h("div", { class: `sw-row${here ? " here" : ""}`, tabindex: "0", title: statusLabel(t) },
      h("span", { class: `dot ${t.status}${t.limitPause ? " paused" : ""}` }),
      h("span", { class: "sw-title" }, t.title),
      waiting ? h("span", { class: "sw-wait", title: "Needs you" }, icon("shield", 11)) : null,
      h("span", { class: "sw-time" }, relTime(t.lastActivity)),
      pop);
    const pick = (ev) => {
      close();
      if (ev.ctrlKey || ev.metaKey) onOpen(t.id);
      else if (!here) onPick(t.id);
    };
    el.addEventListener("click", pick);
    el.addEventListener("auxclick", (ev) => ev.button === 1 && (close(), onOpen(t.id)));
    el.addEventListener("keydown", (ev) => ev.key === "Enter" && pick(ev));
    return el;
  }

  search.addEventListener("input", draw);
  search.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") list.querySelector(".sw-row:not(.here)")?.click();
  });
  // Only the dimmed part outside the list closes it.
  back.addEventListener("click", (ev) => ev.target === back && close());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !back.hidden) {
      ev.stopPropagation();
      close();
    }
  }, true);
  button.addEventListener("click", () => (back.hidden ? void open().catch((e) => notify(e.message, "error")) : close()));
}
