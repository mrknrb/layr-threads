// Prototypes inside replies (layr_code's PrototypeEmbeds): when a reply links `layr://concepts/prototype/<id>`, the
// prototype's page shows live under the text, several side by side. The page comes from the concepts plugin
// (`prototype_page {node}`) and runs in a locked-down frame as the Concepts panel's (plugins/concepts/shared/links.js
// prototypeDocument): srcdoc, sandbox allow-scripts only (no origin: it can't reach this panel or layr), a CSP that
// lets nothing load or be sent, layr's theme and styles inline, and the page saying how tall it is. Its height follows
// the page until it's dragged. Without the concepts plugin (not installed, not allowed) nothing shows.
import { h } from "./common.js";
import { ToolFailed, openLink, pluginCall } from "./ui.js";

const LINK = /layr:\/\/concepts\/prototype\/([^\s)"'<>\]]+)/gi;
const MD_LINK = /\[([^\]\n]*)\]\(\s*layr:\/\/concepts\/prototype\/([^\s)"'<>]+)\s*\)/gi;
const FIT = { min: 120, max: 560 };
const DRAGGED = { min: 60, max: 3000 };
/** The zoom steps, as the Concepts panel's prototypes (plugins/concepts/panels/model.js PROTOTYPE_ZOOMS). */
export const ZOOMS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];
/** The plugin data key of the zooms set by hand: {[prototype id]: percent} (100 is not kept). */
const ZOOM_KEY = "prototype-zoom";

/** The next zoom step from `zoom` in `direction` (+1 in, -1 out); `zoom` itself at the end. */
export function nextZoom(zoom, direction) {
  const levels = direction > 0 ? ZOOMS : [...ZOOMS].reverse();
  return levels.find((level) => (level - zoom) * direction > 0) ?? zoom;
}

/** The prototypes a text links to, each once, in order: [{id, title}] (the title: the Markdown link's text). */
export function prototypeIds(text) {
  const s = String(text ?? "");
  const titles = new Map();
  for (const m of s.matchAll(MD_LINK)) {
    const id = decode(m[2]);
    if (id && m[1].trim() && !titles.has(id)) titles.set(id, m[1].trim());
  }
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(LINK)) {
    const id = decode(m[1].replace(/[.,;:!?]+$/, ""));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: titles.get(id) ?? null });
  }
  return out;
}

function decode(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Inline scripts and styles run, nothing else loads and nothing can be sent anywhere. `eval` stays off. */
export const PROTOTYPE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Runs in the page: says how tall it is, and keeps a click on a link from leaving the prototype. */
const BOOT = `(function () {
  function size() {
    parent.postMessage({ layrPrototypeHeight: document.documentElement.getBoundingClientRect().height }, "*");
  }
  new ResizeObserver(size).observe(document.documentElement);
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("a[href]");
    if (link && link.getAttribute("href").charAt(0) !== "#") e.preventDefault();
  }, true);
})();`;

/** The document a frame's srcdoc gets (as the concepts plugin's prototypeDocument): the policy first, then the page. */
export function prototypeDocument(html, theme = {}, css = "") {
  const variables = Object.entries(theme)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  const style = `${css}:root:root:root{${variables}}html,body{height:auto}body{padding:12px}`.replaceAll("</", "<\\/");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${style}</style><script>${BOOT}</script>${String(html ?? "")}`
  );
}

// ------------------------------------------------------------------ in the panel

/** Is the concepts plugin there for this panel? undefined until asked, then true or false. */
let conceptsThere;
/** Pages by prototype id (one fetch per panel; ↻ fetches again). */
const pages = new Map();
/** Heights dragged by hand, by prototype id, so a reply drawn again keeps them. */
const dragged = new Map();
/** Zooms set by hand, by prototype id (plugin data ZOOM_KEY, read once). */
let zooms = null;
function loadZooms() {
  zooms ??= Promise.resolve(globalThis.layr?.data?.get(ZOOM_KEY))
    .then((v) => (v && typeof v === "object" ? v : {}))
    .catch(() => ({}));
  return zooms;
}
/** Keep the zooms (the object loadZooms gave, changed in place). */
async function saveZooms() {
  const all = await loadZooms();
  await Promise.resolve(globalThis.layr?.data?.set(ZOOM_KEY, all)).catch(() => {});
}
/** Frames shown, for the one message listener: each a function setting its page's height, with its `frame`. */
const fits = new Set();

globalThis.window?.addEventListener("message", (event) => {
  const height = event.data?.layrPrototypeHeight;
  if (typeof height !== "number") return;
  for (const fit of fits) {
    if (fit.frame.contentWindow === event.source) {
      fit.seen = true;
      fit(height);
    } else if (fit.seen && !fit.frame.isConnected) fits.delete(fit);
  }
});

/** A prototype's page, from the concepts plugin: {html} or {error}; null when there is no concepts plugin. */
async function loadPage(id, again = false) {
  if (conceptsThere === false) return null;
  if (!again && pages.has(id)) return pages.get(id);
  const promise = pluginCall("concepts", "prototype_page", { node: id })
    .then((r) => {
      conceptsThere = true;
      if (typeof r?.html !== "string") return { error: "It has no page" };
      return { html: r.html };
    })
    .catch((error) => {
      if (error instanceof ToolFailed) {
        conceptsThere = true;
        return { error: error.message };
      }
      // No concepts plugin, no such tool, or not allowed to call it.
      conceptsThere = false;
      return null;
    });
  pages.set(id, promise);
  return promise;
}

let layrCss = null;
function baseCss() {
  layrCss ??= fetch("/_layr/layr.css")
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  return layrCss;
}

function theme() {
  const style = getComputedStyle(document.documentElement);
  const names = ["--bg", "--bg-2", "--bg-3", "--fg", "--fg-dim", "--border", "--accent", "--accent-fg", "--danger",
    "--radius", "--font", "--font-mono"];
  const out = Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]).filter(([, v]) => v));
  const mode = document.documentElement.getAttribute("data-theme");
  if (mode === "dark" || mode === "light") out["color-scheme"] = mode;
  return out;
}

const linkOf = (id) => `layr://concepts/prototype/${encodeURIComponent(id)}`;

/**
 * The prototypes a reply links to, under its text: one strip with their pages side by side, or null when it links
 * none. It stays empty (hidden) until the concepts plugin answers, and is removed when there is none.
 */
export function prototypeEmbeds(text) {
  const list = prototypeIds(text);
  if (!list.length || conceptsThere === false) return null;
  const el = h("div", { class: "protos", hidden: true });
  void fill(el, list);
  return el;
}

async function fill(el, list, again = false) {
  const loaded = await Promise.all(list.map((p) => loadPage(p.id, again)));
  if (conceptsThere === false || loaded.every((p) => p === null)) return el.remove();
  const css = await baseCss();
  const saved = await loadZooms();
  const many = list.length > 1;
  const reload = h("button", { class: "proto-btn", title: "Run it again" }, "↻");
  reload.addEventListener("click", () => void fill(el, list, true));
  const open = h("button", { class: "proto-btn proto-open", title: "Open it in Concepts" }, "Open in Concepts ↗");
  open.addEventListener("click", () => void openLink(linkOf(list[0].id)));
  const title = many ? `${list.length} prototypes` : list[0].title || "Prototype";
  // One zoom for the strip's pages, as the Concepts panel's (remembered per prototype in the plugin's data).
  const zoomOf = () => Number(saved[list[0].id]) || 100;
  const zoomLabel = h("button", { class: "proto-btn proto-zoom", title: "The page's zoom (click: 100%)" }, "");
  const setZoom = (zoom) => {
    for (const p of list) {
      if (zoom === 100) delete saved[p.id];
      else saved[p.id] = zoom;
    }
    zoomLabel.textContent = `${zoom}%`;
    for (const frame of frames) frame.zoom(zoom);
    void saveZooms();
  };
  const zoomOut = h("button", { class: "proto-btn", title: "Zoom the page out" }, "−");
  const zoomIn = h("button", { class: "proto-btn", title: "Zoom the page in" }, "+");
  zoomOut.addEventListener("click", () => setZoom(nextZoom(zoomOf(), -1)));
  zoomIn.addEventListener("click", () => setZoom(nextZoom(zoomOf(), 1)));
  zoomLabel.addEventListener("click", () => setZoom(100));
  zoomLabel.textContent = `${zoomOf()}%`;
  const frames = [];
  const head = h("div", { class: "proto-head" }, h("span", { class: "proto-title" }, `▣ ${title}`),
    h("span", { class: "grow" }), zoomOut, zoomLabel, zoomIn, reload, many ? null : open);
  const columns = h("div", { class: `proto-columns${many ? " many" : ""}` }, list.map((p, i) => {
    const page = loaded[i];
    const label = many
      ? h("button", { class: "proto-label", title: "Open it in Concepts" }, p.title || "Prototype", " ↗")
      : null;
    label?.addEventListener("click", () => void openLink(linkOf(p.id)));
    if (!page || page.error) {
      return h("div", { class: "proto-column" }, label, h("div", { class: "proto-note" },
        `Couldn't show it: ${page?.error ?? "no concepts plugin"}`));
    }
    const shown = frameFor(p, page.html, css, zoomOf());
    frames.push(shown);
    return h("div", { class: "proto-column" }, label, shown);
  }));
  el.replaceChildren(head, columns);
  el.hidden = false;
}

/**
 * One page in its frame, as tall as the page (within limits) until its bottom edge is dragged. Zoomed as a browser
 * zooms (as the Concepts panel's): the frame is laid out bigger or smaller than its box and scaled to fit, so the
 * page's percents and media queries follow. The element's `zoom(percent)` changes it.
 */
function frameFor(p, html, css, zoom = 100) {
  const frame = h("iframe", { class: "proto-frame", sandbox: "allow-scripts", title: p.title || "Prototype",
    srcdoc: prototypeDocument(html, theme(), css) });
  const box = h("div", { class: "proto-box" }, frame);
  let pageHeight = 240;
  let scale = zoom / 100;
  const setHeight = () => {
    const fitted = Math.min(FIT.max, Math.max(FIT.min, Math.ceil(pageHeight * scale)));
    box.style.height = `${dragged.get(p.id) ?? fitted}px`;
  };
  const setScale = () => {
    frame.style.width = `${100 / scale}%`;
    frame.style.height = `${100 / scale}%`;
    frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
    frame.style.transformOrigin = "0 0";
  };
  setScale();
  setHeight();
  const fit = (height) => {
    pageHeight = height;
    setHeight();
  };
  fit.frame = frame;
  fits.add(fit);
  const grip = h("div", { class: "proto-grip",
    title: "Drag to make it taller or shorter (double-click: as tall as its page)" });
  // The window hears the moves (pointer capture loses them in layr's Windows web views); the frames take no pointer
  // meanwhile, so the page inside doesn't swallow them.
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    document.body.classList.add("proto-resizing");
    grip.classList.add("resizing");
    const start = box.offsetHeight;
    const from = e.clientY;
    const move = (ev) => {
      dragged.set(p.id, Math.min(DRAGGED.max, Math.max(DRAGGED.min, Math.round(start + ev.clientY - from))));
      setHeight();
    };
    const done = () => {
      grip.classList.remove("resizing");
      document.body.classList.remove("proto-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  });
  grip.addEventListener("dblclick", () => {
    dragged.delete(p.id);
    setHeight();
  });
  const el = h("div", { class: "proto-page" }, box, grip);
  el.zoom = (percent) => {
    scale = percent / 100;
    setScale();
    setHeight();
  };
  return el;
}

/** For tests: forget what was learned about the concepts plugin. */
export function resetPrototypes() {
  conceptsThere = undefined;
  pages.clear();
  dragged.clear();
  zooms = null;
}
