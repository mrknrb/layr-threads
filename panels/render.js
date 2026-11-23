// Rendering pieces for the thread panel: Markdown, diffs, tool calls.
import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.mjs";
import { h, icon } from "./common.js";

marked.setOptions({ gfm: true, breaks: false });

/** DOMPurify's own list of safe link schemes, plus layr:// (links into layr). */
const URI_OK = /^(?:(?:https?|mailto|tel|layr):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
const PURIFY = { ADD_ATTR: ["target"], ALLOWED_URI_REGEXP: URI_OK };
const SHELLS = {
  powershell: "powershell", pwsh: "powershell", ps: "powershell", ps1: "powershell", cmd: "cmd", bat: "cmd",
  batch: "cmd", bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
};

/**
 * What the panel does with links and command blocks: `openLink(url)` for layr:// links (never the browser),
 * `run({shell, command})` for ▶ Run on a powershell / cmd / bash block (null: no Run buttons, e.g. on a phone).
 */
const hooks = { openLink: null, run: null };
export function setMarkdownHooks(next) {
  Object.assign(hooks, next);
}

/** `layr://plugin/path/id` in plain text becomes a link (marked links only http and www by itself). */
function linkifyLayr(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (/layr:\/\//.test(n.data) && !n.parentElement.closest("a, code, pre") ? 1 : 2),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.data.split(/(layr:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?])/);
    node.replaceWith(...parts.map((p, i) => (i % 2 ? h("a", { href: p }, p) : p)));
  }
}

/** Inline Markdown (no paragraph), sanitized, as a <span>. */
export function inlineMarkdown(text, cls = "") {
  const el = h("span", { class: cls });
  el.innerHTML = DOMPurify.sanitize(marked.parseInline(String(text ?? "")), PURIFY);
  wireLinks(el);
  return el;
}

function wireLinks(el) {
  linkifyLayr(el);
  for (const a of el.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^layr:\/\//i.test(href)) {
      a.classList.add("layr-link");
      a.removeAttribute("target");
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        hooks.openLink?.(href);
      });
    } else {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }
}

/** Markdown → a sanitized element, with copy buttons (and ▶ Run on command blocks) and links opening outside. */
export function markdown(text, cls = "md") {
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? "")), PURIFY);
  wireLinks(el);
  for (const pre of el.querySelectorAll("pre")) {
    const lang = /language-([\w-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1]?.toLowerCase();
    const shell = lang && Object.hasOwn(SHELLS, lang) ? SHELLS[lang] : null;
    if (shell && hooks.run) {
      const run = h("button", { class: "run-btn", title: `Run in a new ${shell} window on the PC, in the thread's folder` }, "▶ Run");
      run.addEventListener("click", () => hooks.run({ shell, command: pre.querySelector("code")?.textContent ?? "" }, run));
      pre.classList.add("runnable");
      pre.append(run);
    }
    const btn = h("button", { class: "copy-btn", title: "Copy" }, "Copy");
    btn.addEventListener("click", () => {
      navigator.clipboard?.writeText(pre.querySelector("code")?.innerText ?? pre.innerText).then(
        () => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        },
        () => {},
      );
    });
    pre.append(btn);
  }
  return el;
}

/** Line diff (LCS) of two texts as [{op: " "|"+"|"-", text}]; big inputs fall back to all-removed, all-added. */
export function diffLines(oldText, newText) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  if (a.length * b.length > 400_000) {
    return [...a.map((t) => ({ op: "-", text: t })), ...b.map((t) => ({ op: "+", text: t }))];
  }
  // Trim the common start and end first: edits are usually small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const n = midA.length;
  const m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = a.slice(0, start).map((t) => ({ op: " ", text: t }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      out.push({ op: " ", text: midA[i] });
      i++;
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      out.push({ op: "-", text: midA[i++] });
    } else {
      out.push({ op: "+", text: midB[j++] });
    }
  }
  for (let k = endA + 1; k < a.length; k++) out.push({ op: " ", text: a[k] });
  return out;
}

/** A diff element; unchanged runs longer than 2×context are folded. */
export function diffView(lines, { context = 3 } = {}) {
  const el = h("div", { class: "diff" });
  const changed = lines.map((l) => l.op !== " ");
  const keep = lines.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) if (changed[k]) return true;
    return false;
  });
  let folded = 0;
  const flush = () => {
    if (folded) el.append(h("div", { class: "ln gap" }, h("span", { class: "g" }, "⋯"), h("span", { class: "t" }, `${folded} unchanged line${folded > 1 ? "s" : ""}`)));
    folded = 0;
  };
  lines.forEach((l, i) => {
    if (!keep[i] && lines.length > 12) {
      folded++;
      return;
    }
    flush();
    el.append(
      h("div", { class: `ln ${l.op === "+" ? "add" : l.op === "-" ? "del" : ""}` },
        h("span", { class: "g" }, l.op === " " ? "" : l.op),
        h("span", { class: "t" }, l.text || " ")),
    );
  });
  flush();
  return el;
}

const TOOL_ICONS = {
  Bash: "terminal", BashOutput: "terminal", KillShell: "terminal", PowerShell: "terminal",
  Read: "eye", Write: "file", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit",
  Glob: "search", Grep: "search", WebFetch: "globe", WebSearch: "globe",
  TodoWrite: "list", Task: "bot", Agent: "bot", AskUserQuestion: "question", ExitPlanMode: "list",
};

export function toolIcon(name) {
  if (String(name).startsWith("mcp__")) return icon("tool", 14);
  return icon(TOOL_ICONS[name] ?? "tool", 14);
}

/** A friendly tool name: mcp__layr__notes__add → notes · add. */
export function toolLabel(name) {
  const n = String(name ?? "");
  if (n.startsWith("mcp__layr__")) {
    const rest = n.slice("mcp__layr__".length);
    const i = rest.indexOf("__");
    return i > 0 ? `${rest.slice(0, i)} · ${rest.slice(i + 2)}` : rest;
  }
  if (n.startsWith("mcp__")) return n.slice(5).replace("__", " · ");
  return n;
}

/** One line about a tool call: the file, command, pattern... */
export function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  const short = (p) => {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : parts.join("/");
  };
  switch (name) {
    case "Bash":
    case "PowerShell":
      return input.description ? `${input.description}` : String(input.command ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return short(input.file_path ?? input.notebook_path ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return `${input.pattern ?? ""}${input.path ? ` in ${short(input.path)}` : ""}`;
    case "WebFetch":
      return String(input.url ?? "");
    case "WebSearch":
      return String(input.query ?? "");
    case "Task":
    case "Agent":
      return String(input.description ?? input.subagent_type ?? "");
    case "TodoWrite":
      return `${input.todos?.length ?? 0} items`;
    default: {
      const v = input.path ?? input.file_path ?? input.command ?? input.query ?? input.url ?? input.title ?? input.text;
      if (typeof v === "string") return v;
      const json = JSON.stringify(input);
      return json === "{}" ? "" : json;
    }
  }
}

/** The body of a tool call or an approval: a diff for edits, the command for Bash, JSON otherwise. */
export function toolInputView(name, input) {
  if (!input || typeof input !== "object" || !Object.keys(input).length) return null;
  if (input._truncated) return h("pre", { class: "block" }, input._truncated);
  if (name === "Edit") {
    return h("div", {}, h("div", { class: "diff-file" }, input.file_path ?? ""), diffView(diffLines(input.old_string, input.new_string)),
      input.replace_all ? h("div", { class: "muted", style: { fontSize: "11.5px", marginTop: "3px" } }, "Every occurrence") : null);
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return h("div", {}, h("div", { class: "diff-file" }, input.file_path ?? ""),
      ...input.edits.map((e) => h("div", { style: { marginBottom: "6px" } }, diffView(diffLines(e.old_string, e.new_string)))));
  }
  if (name === "Write") {
    const lines = String(input.content ?? "").split("\n").map((t) => ({ op: "+", text: t }));
    return h("div", {}, h("div", { class: "diff-file" }, input.file_path ?? ""), diffView(lines.length > 400 ? [...lines.slice(0, 400), { op: " ", text: `… ${lines.length - 400} more lines` }] : lines));
  }
  if (name === "Bash" || name === "PowerShell") {
    return h("div", {}, input.description ? h("div", { class: "muted", style: { fontSize: "12px", marginBottom: "4px" } }, input.description) : null,
      h("pre", { class: "block" }, `$ ${input.command ?? ""}`));
  }
  if (name === "Read") {
    const range = input.offset || input.limit ? ` (lines ${input.offset ?? 1}${input.limit ? `–${(input.offset ?? 1) + input.limit}` : ""})` : "";
    return h("div", { class: "diff-file" }, `${input.file_path ?? ""}${range}`);
  }
  if (name === "Task" || name === "Agent") {
    return input.prompt ? markdown(input.prompt, "md sub-prompt") : null;
  }
  return h("pre", { class: "block" }, JSON.stringify(input, null, 2));
}
