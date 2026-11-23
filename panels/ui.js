// Panel pieces shared by the threads list and the thread panel: right-click menus, layr:// links, the phone check,
// in-panel confirms, and the pipeline plugin's tools (feature-detected: everything pipeline hides without it).
import { call, h, notify } from "./common.js";

/**
 * Shown on a phone (UI there, calls on the PC): buttons that open windows on the PC (▶ Run, VS Code, File Explorer)
 * are hidden. `layr.info.device` and `platform` are the showing device's (docs/ARCHITECTURE.md › Phone modes).
 */
export function onPhone() {
  const info = window.layr?.info ?? {};
  return info.device?.kind === "phone" || info.platform === "android" || info.platform === "ios";
}

/**
 * The shell's right-click menu (layr.ui.contextMenu); where there is none (an older core, the dev server) a small
 * menu of our own. Items: {label, icon?, danger?, disabled?, run} or "-".
 */
export async function contextMenu(items, ev) {
  ev?.preventDefault?.();
  const list = items.filter(Boolean);
  if (typeof window.layr?.ui?.contextMenu === "function") {
    try {
      return await window.layr.ui.contextMenu(list, ev);
    } catch (error) {
      if (!/NOT_AVAILABLE|not available|isn't in it/i.test(`${error?.code ?? ""} ${error?.message ?? ""}`)) throw error;
    }
  }
  return ownMenu(list, ev);
}

function ownMenu(items, ev) {
  document.querySelector(".own-menu")?.remove();
  return new Promise((resolve) => {
    const menu = h("div", { class: "own-menu", role: "menu" });
    const close = (picked) => {
      menu.remove();
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", onKey, true);
      if (picked?.run) picked.run(picked);
      resolve(picked ?? null);
    };
    const outside = (e) => !menu.contains(e.target) && close(null);
    const onKey = (e) => e.key === "Escape" && close(null);
    for (const it of items) {
      if (it === "-") {
        menu.append(h("div", { class: "sep" }));
        continue;
      }
      const b = h("button", { class: `${it.danger ? "danger" : ""}`, disabled: Boolean(it.disabled) }, it.label);
      b.addEventListener("click", () => close(it));
      menu.append(b);
    }
    document.body.append(menu);
    const x = ev?.clientX ?? 20;
    const y = ev?.clientY ?? 20;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
    setTimeout(() => {
      window.addEventListener("pointerdown", outside, true);
      window.addEventListener("keydown", onKey, true);
    });
  });
}

/**
 * Open a layr:// link in layr, never in the browser: `layr.links.open` when the core has it, else
 * `layr://<plugin>/<path>/<id>` opened as that plugin's panel `<path>` with {<path>: id, id}.
 */
export async function openLink(url) {
  try {
    if (typeof window.layr?.links?.open === "function") return await window.layr.links.open(url);
    const m = /^layr:\/\/([a-z][a-z0-9-]*)\/([^/?#]+)(?:\/([^?#]+))?/i.exec(String(url));
    if (!m) throw new Error(`Not a layr link: ${url}`);
    const [, plugin, panel, rawId] = m;
    const id = rawId ? decodeURIComponent(rawId) : undefined;
    const own = plugin === window.layr?.info?.plugin;
    const params = id === undefined ? {} : own && panel === "thread" ? { thread: id } : { [panel]: id, id };
    return await window.layr.panels.open(panel, params, own ? undefined : { plugin });
  } catch (error) {
    notify(`Could not open ${url}: ${error.message ?? error}`, "error");
  }
}

export const threadLink = (id) => `layr://threads/thread/${id}`;

/** A plugin's page in layr (0.3.14: the Plugins list and plugin pages are layr's own): a tab, a commit in History. */
export const pluginPageLink = (plugin, tab, commit) =>
  `layr://layr/plugin/${encodeURIComponent(plugin)}${tab ? `/${tab}` : ""}${tab && commit ? `/${commit}` : ""}`;

export async function copyText(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    notify(what, "success");
  } catch {
    notify("Could not copy", "error");
  }
}

/** An in-panel confirm in place of `holder`'s content: resolves true (OK) or false. */
export function confirmIn(holder, text, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const before = [...holder.childNodes];
    const yes = h("button", { class: `btn small ${danger ? "danger solid" : "primary"}` }, ok);
    const no = h("button", { class: "btn small" }, "Cancel");
    const done = (v) => {
      holder.replaceChildren(...before);
      resolve(v);
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    holder.replaceChildren(h("div", { class: "confirm" }, h("span", { class: "confirm-text" }, text), yes, no));
    yes.focus();
  });
}

/** A small popup over the panel asking `text`: resolves true (OK) or false (Cancel, Escape, a click beside it). */
export function confirmPopup(text, { ok = "OK" } = {}) {
  return new Promise((resolve) => {
    const yes = h("button", { class: "btn small primary" }, ok);
    const no = h("button", { class: "btn small" }, "Cancel");
    const box = h("div", { class: "popup", role: "dialog" }, h("div", { class: "popup-text" }, text), h("div", { class: "popup-buttons" }, no, yes));
    const back = h("div", { class: "popup-back" }, box);
    const done = (v) => {
      document.removeEventListener("keydown", key, true);
      back.remove();
      resolve(v);
    };
    const key = (e) => {
      if (e.key === "Escape") (e.preventDefault(), done(false));
    };
    yes.addEventListener("click", () => done(true));
    no.addEventListener("click", () => done(false));
    back.addEventListener("click", (e) => e.target === back && done(false));
    document.addEventListener("keydown", key, true);
    document.body.append(back);
    yes.focus();
  });
}

// ------------------------------------------------------------------ the pipeline plugin

/** A pipeline tool; throws when the pipeline isn't installed, or doesn't have the tool. */
export function pipelineCall(tool, args) {
  return pluginCall("pipeline", tool, args);
}

/** Thrown by pluginCall when the tool ran and said it failed (as opposed to: no such plugin, tool, or access). */
export class ToolFailed extends Error {}

/** Another plugin's tool, its value: structured content, else its text parsed as JSON, else the text. */
export function pluginCall(plugin, tool, args) {
  return window.layr.tools.call(tool, args, { plugin }).then((result) => {
    if (result?.isError) {
      throw new ToolFailed((result.content ?? []).map((c) => c.text ?? "").join("\n") || `${tool} failed`);
    }
    if (result?.isError) throw new Error((result.content ?? []).map((c) => c.text ?? "").join("\n") || `${tool} failed`);
    if (result?.structuredContent !== undefined) {
      const s = result.structuredContent;
      return s && typeof s === "object" && Object.keys(s).length === 1 && "result" in s ? s.result : s;
    }
    const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
    try {
      return JSON.parse(text);
    } catch {
      return text || null;
    }
  });
}

/**
 * Whether the optional connection to the pipeline can be used (installed and allowed), asked of layr once and again
 * after `layr:connections`: false, or null when layr can't say (a core from before connections: just call).
 */
let pipelineUsable = null;
let pipelineWatched = false;
function pipelineReady() {
  if (!pipelineWatched) {
    pipelineWatched = true;
    onPipelineChange(() => {});
  }
  pipelineUsable ??= Promise.resolve()
    .then(() => window.layr.connections.usable("pipeline"))
    .catch(() => null);
  return pipelineUsable;
}

/** fn() whenever the pipeline may have come or gone (installed, removed, allowed, denied); returns a stop function. */
export function onPipelineChange(fn) {
  try {
    const stop = window.layr?.connections?.onChange?.(() => {
      pipelineUsable = null;
      fn();
    });
    return typeof stop === "function" ? stop : () => {};
  } catch {
    return () => {};
  }
}

/**
 * The pipeline task a thread belongs to (`pipeline__thread_task`): the task, null when it isn't one, or undefined
 * when there is no pipeline (not installed, too old, or not allowed). Asks layr first, so that an unallowed pipeline
 * is never called (no access question just to find out).
 */
export async function threadTask(threadId) {
  if ((await pipelineReady()) === false) return undefined;
  try {
    const task = await pipelineCall("thread_task", { thread: threadId });
    return task && typeof task === "object" && task.number != null ? task : null;
  } catch {
    return undefined;
  }
}

/** "+ Pipeline": the thread becomes a pipeline task. */
export async function adoptThread(threadId) {
  try {
    await pipelineCall("act", { action: "adopt", threadId });
    notify("The thread is a pipeline task now", "success");
    return true;
  } catch (error) {
    notify(`Pipeline: ${error.message}`, "error");
    return false;
  }
}

/** Open a thread's folder on the PC (not offered on a phone). */
export function openFolderOnPc(threadId, app) {
  return call("open_folder", { thread: threadId, app, at: Date.now() }).catch((e) => notify(e.message, "error"));
}
