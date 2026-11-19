// Shared by the plugin's panels: the layr SDK (window.layr, from /_layr/layr.js), tool calls, formatting.

/** Wait for layr.js to load and connect. */
export async function ready() {
  for (let i = 0; !window.layr && i < 200; i++) await new Promise((r) => setTimeout(r, 25));
  if (!window.layr) throw new Error("layr.js did not load");
  await window.layr.ready;
  return window.layr;
}

/** Call one of this plugin's backend tools; gives its structured result, throws its error text. */
export async function call(tool, args = {}) {
  const result = await window.layr.tools.call(tool, args);
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    throw new Error(text || `${tool} failed`);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function notify(text, kind = "info") {
  try {
    window.layr.ui.notify(text, kind);
  } catch {
    console.log(`[${kind}] ${text}`);
  }
}

/** Subscribe to a topic; the handler gets the event's data. */
export function on(topic, fn) {
  return window.layr.events.on(topic, (data) => fn(data));
}

/** document.createElement with props and children: h("div", {class: "x", onclick}, "text", child). */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** An inline SVG icon from a small built-in set (no icon font needed). */
export function icon(name, size = 16) {
  const paths = ICONS[name] ?? ICONS.dot;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.classList.add("icon");
  svg.innerHTML = paths;
  return svg;
}

const ICONS = {
  dot: '<circle cx="12" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-11 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  unarchive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="m9 15 3-3 3 3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  terminal: '<path d="m4 17 6-5-6-5"/><path d="M12 19h8"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/>',
  brain: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h0a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"/><path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h0a3 3 0 0 1-3-3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h0a3 3 0 0 1 3 3v4h-3a2 2 0 1 0 0 4h3v4a3 3 0 0 1-3 3h-4v-3a2 2 0 1 0-4 0v3H6a3 3 0 0 1-3-3v-4h3a2 2 0 1 0 0-4H3V6a3 3 0 0 1 3-3z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};

export const STATUS_LABEL = {
  starting: "Starting",
  running: "Working",
  waiting: "Waiting for you",
  done: "Done",
  failed: "Failed",
  interrupted: "Stopped",
  idle: "Idle",
};

export const PERMISSION_LABEL = {
  default: "Ask before changes",
  acceptEdits: "Accept edits",
  bypassPermissions: "Never ask",
  plan: "Plan only",
  dontAsk: "Only allowed tools",
};

export function relTime(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

export function money(usd) {
  if (typeof usd !== "number") return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function tokens(n) {
  if (typeof n !== "number") return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function duration(ms) {
  if (typeof ms !== "number") return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Fill a <select> with options [{value, label}] and select `value`. */
export function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((o) => h("option", { value: o.value }, o.label)));
  select.value = value ?? "";
  if (select.value !== (value ?? "") && options.length) select.value = options[0].value;
}

/** Until Claude Code says which models it has. */
const FALLBACK_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/**
 * The options of a model picker. `defaultName`: which model "Default model" stands for (defaultModelName), shown
 * after it.
 */
export function modelOptions(models, { includeDefault = true, defaultName = null } = {}) {
  const label = defaultName ? `Default model (${defaultName})` : "Default model";
  const out = includeDefault ? [{ value: "", label }] : [];
  const list = models?.length ? models : FALLBACK_MODELS;
  for (const m of list) {
    if (m.id === "default") continue;
    out.push({ value: m.id, label: m.label });
  }
  return out;
}

/** A model id as people say it: "claude-opus-5-5" → "Opus 5.5", "claude-sonnet-5-5[1m]" → "Sonnet 5.5 (1M)". */
export function modelName(id) {
  const s = String(id ?? "").trim();
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(s);
  if (!m) return s;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}${m[4] ? " (1M)" : ""}`;
}

/**
 * Which model "Default model" stands for, or null when nothing says: the one Claude Code said a thread runs
 * (`resolved`), else the `model` of Claude Code's settings (`setting`: an alias or an id), else what its "default"
 * entry says ("… (currently Opus 5.5)").
 */
export function defaultModelName(models, { resolved = null, setting = null } = {}) {
  if (resolved) return modelName(resolved);
  const list = models ?? [];
  if (setting) return list.find((m) => m.id === setting && m.id !== "default")?.label ?? modelName(setting);
  const d = list.find((m) => m.id === "default");
  if (d?.resolved) return modelName(d.resolved);
  const said = /currently ([^)·,]+)/i.exec(d?.description ?? "");
  return said ? said[1].trim() : null;
}

/** The options of an effort picker for `modelId`. `defaultEffort`: what "Default effort" stands for, after it. */
export function effortOptions(models, modelId, { defaultEffort = null } = {}) {
  const m = models.find((x) => x.id === modelId) ?? models.find((x) => x.id === "default") ?? null;
  const efforts = m?.efforts?.length ? m.efforts : ["low", "medium", "high", "xhigh", "max"];
  return [{ value: "", label: defaultEffort ? `Default effort (${defaultEffort})` : "Default effort" },
    ...efforts.map((e) => ({ value: e, label: `Effort: ${e}` }))];
}

export function permissionOptions() {
  return Object.entries(PERMISSION_LABEL).map(([value, label]) => ({ value, label }));
}

/** Read an image File/Blob as {mediaType, data(base64), url}. */
export function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ mediaType: file.type || "image/png", data: url.split(",")[1] ?? "", url, name: file.name || "image" });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
