// The threads panel: projects with their Claude threads, live status, search, archive, and the new-thread form.
// 0.3.2: a switch at the top says what threads work on: Projects (folders), Plugins (layr plugins) or Extensions
// (plugins that bring a Chrome extension); the form then picks a project, or a plugin / extension (or a new one).
import {
  STATUS_LABEL,
  call,
  effortOptions,
  fillSelect,
  h,
  icon,
  modelOptions,
  notify,
  on,
  permissionOptions,
  relTime,
  ready,
} from "./common.js";
import { adoptThread, contextMenu, copyText, onPhone, openFolderOnPc, threadLink, threadTask } from "./ui.js";

const $ = (id) => document.getElementById(id);
const MODES = [["projects", "folder", "Projects"], ["plugin", "box", "Plugins"], ["extension", "puzzle", "Extensions"]];
const savedMode = localStorage.getItem("claude.mode");
const state = {
  mode: MODES.some(([m]) => m === savedMode) ? savedMode : "projects",
  targets: [],
  targetsError: null,
  devtools: false,
  projects: [],
  threads: new Map(),
  models: [],
  archived: false,
  query: "",
  collapsed: new Set(JSON.parse(localStorage.getItem("claude.collapsed") || "[]")),
  active: null,
  usage: null,
};

const layr = await ready();
$("search-icon").append(icon("search", 14));
$("new").append(icon("plus", 14), "New");
$("add-project").append(icon("folder", 14));
$("show-archived").append(icon("archive", 14));

on("claude:threads", (ev) => {
  if (ev?.kind === "thread" && ev.thread) {
    const t = ev.thread;
    if (Boolean(t.archived) !== state.archived) state.threads.delete(t.id);
    else state.threads.set(t.id, t);
    render();
  } else if (ev?.kind === "projects") void loadProjects().then(render);
});
on("claude:usage", () => void loadUsage(false));
// Plugins installed, linked, switched or removed: the Plugins and Extensions lists follow.
let targetsTimer = null;
on("layr:packages", (ev) => {
  if (ev?.phase !== "done") return;
  clearTimeout(targetsTimer);
  targetsTimer = setTimeout(() => void loadTargets().then(render), 400);
});


// ------------------------------------------------------------------ data

async function loadProjects() {
  try {
    state.projects = (await call("projects_list")).projects ?? [];
  } catch (error) {
    notify(`Claude: ${error.message}`, "error");
  }
}

async function loadThreads() {
  const r = await call("thread_list", { limit: 500, archived: state.archived });
  state.threads = new Map(r.threads.map((t) => [t.id, t]));
}

async function loadTargets() {
  try {
    const r = await call("targets_list");
    state.targets = r.targets ?? [];
    state.targetsError = r.error ?? null;
  } catch (error) {
    state.targetsError = error.message;
  }
}

async function loadModels() {
  try {
    state.models = (await call("models_list")).models ?? [];
  } catch {
    state.models = [];
  }
}

async function loadUsage(refresh) {
  try {
    state.usage = await call("usage", { refresh });
    renderUsage();
  } catch {
    // usage is a nice-to-have
  }
}

// ------------------------------------------------------------------ list

function renderModes() {
  const nav = $("modes");
  nav.replaceChildren(...MODES.map(([id, ic, label]) => {
    const b = h("button", { type: "button", class: state.mode === id ? "on" : "",
      title: { projects: "Threads in your project folders", plugin: "Threads on your layr plugins",
        extension: "Threads on your Chrome extensions (plugins that bring one)" }[id] }, icon(ic, 13), label);
    b.addEventListener("click", () => setMode(id));
    return b;
  }));
  $("add-project").hidden = state.mode !== "projects";
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  localStorage.setItem("claude.mode", mode);
  closeForm();
  renderModes();
  render();
}

/** Threads matching the search, newest first. */
function visibleThreads() {
  const q = state.query.toLowerCase();
  return [...state.threads.values()]
    .filter((t) => !q || `${t.title} ${t.preview} ${t.workspace?.branch ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
}

const isPluginProject = (p) => p.kind === "plugin";

function render() {
  if (state.mode !== "projects") return renderTargets();
  const list = $("list");
  const q = state.query.toLowerCase();
  const threads = visibleThreads().filter((t) => t.kind !== "plugin");
  const projects = state.projects.filter((p) => !isPluginProject(p));
  if (!projects.length) {
    list.replaceChildren(
      h("div", { class: "empty" },
        h("div", { style: { fontSize: "15px", fontWeight: 600, color: "var(--fg)", marginBottom: "6px" } }, "No projects yet"),
        h("div", {}, "A project is a folder Claude works in. Add one to start a thread."),
        h("div", { style: { marginTop: "14px" } }, addProjectButton())),
    );
    return;
  }
  const groups = projects.map((p) => ({ p, threads: threads.filter((t) => t.projectId === p.id) }));
  const orphans = threads.filter((t) => !projects.some((p) => p.id === t.projectId));
  if (orphans.length) groups.push({ p: { id: "_", name: "Other", path: "" }, threads: orphans });
  // Projects with recent activity first.
  groups.sort((a, b) => String(b.threads[0]?.lastActivity ?? "").localeCompare(String(a.threads[0]?.lastActivity ?? "")));
  const visible = q ? groups.filter((g) => g.threads.length) : groups;
  if (!visible.length) {
    list.replaceChildren(h("div", { class: "empty" }, state.archived ? "No archived threads." : "No threads match."));
    return;
  }
  list.replaceChildren(...visible.map(projectGroup));
}

function projectGroup({ p, threads }) {
  const collapsed = state.collapsed.has(p.id) && !state.query;
  const chev = icon("chevron", 12);
  chev.classList.add("chev");
  chev.style.transform = collapsed ? "rotate(0deg)" : "rotate(90deg)";
  const toggle = () => {
    state.collapsed.has(p.id) ? state.collapsed.delete(p.id) : state.collapsed.add(p.id);
    localStorage.setItem("claude.collapsed", JSON.stringify([...state.collapsed]));
    render();
  };
  const add = h("button", { class: "btn ghost small icon-only", title: `New thread in ${p.name}` }, icon("plus", 13));
  add.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openForm(p.id);
  });
  const remove = h("button", { class: "btn ghost small icon-only", title: "Remove the project from the list (its folder stays)" }, icon("trash", 13));
  remove.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (remove.dataset.armed !== "1") {
      remove.dataset.armed = "1";
      remove.classList.add("danger");
      remove.title = "Click again to remove";
      setTimeout(() => {
        remove.dataset.armed = "";
        remove.classList.remove("danger");
      }, 3000);
      return;
    }
    await call("project_remove", { project: p.id }).catch((e) => notify(e.message, "error"));
    await loadProjects();
    render();
  });
  const head = h("div", { class: "project-head" }, chev, h("span", { class: "name", title: p.path }, p.name),
    h("span", { class: "path", title: p.path }, p.path), p.id !== "_" ? h("span", { class: "acts" }, add, remove) : null);
  chev.addEventListener("click", toggle);
  head.querySelector(".name").addEventListener("click", toggle);
  const rows = threads.map(threadRow);
  return h("div", { class: `project${collapsed ? " collapsed" : ""}` }, head,
    h("div", { class: "threads" }, rows.length ? rows : h("div", { class: "none" }, state.archived ? "No archived threads" : "No threads yet")));
}

// ------------------------------------------------------------------ plugins and extensions

const PLACE = {
  made: ["yours", "Made by you: its own repository, with History and Undo in My plugins"],
  changed: ["your copy", "A store plugin with your changes (branch mine): History and Undo in My plugins"],
  store: ["store", "As it came from the store: Claude works on your own copy"],
  inside: ["in a repo", "Linked from a bigger repository: commits go there"],
};

/** Which list a plugin belongs to: extension when it brings a Chrome extension. */
const targetMode = (t) => (t.extension ? "extension" : "plugin");

function renderTargets() {
  const list = $("list");
  const kind = state.mode;
  const threads = visibleThreads().filter((t) => t.kind === "plugin");
  const byPlugin = new Map();
  for (const t of threads) {
    const id = t.target?.plugin ?? "_";
    if (!byPlugin.has(id)) byPlugin.set(id, []);
    byPlugin.get(id).push(t);
  }
  const known = new Map(state.targets.map((t) => [t.id, t]));
  const groups = [];
  for (const t of state.targets) {
    if (targetMode(t) !== kind) continue;
    const own = byPlugin.get(t.id) ?? [];
    // Store plugins nobody worked on stay in the form's list, not here.
    if (t.place === "store" && !own.length) continue;
    groups.push({ t, threads: own });
  }
  for (const [id, own] of byPlugin) {
    if (known.has(id)) continue;
    const k = own[0].target?.kind ?? "plugin";
    if (k !== kind) continue;
    groups.push({ t: { id, name: id === "_" ? "Other" : id, place: "made", path: own[0].cwd, extension: k === "extension",
      missing: true }, threads: own });
  }
  groups.sort((a, b) => String(b.threads[0]?.lastActivity ?? "").localeCompare(String(a.threads[0]?.lastActivity ?? "")) ||
    a.t.name.localeCompare(b.t.name));
  const q = state.query;
  const visible = q ? groups.filter((g) => g.threads.length || g.t.name.toLowerCase().includes(q.toLowerCase())) : groups;
  const word = kind === "extension" ? "extension" : "plugin";
  if (!visible.length) {
    const make = h("button", { class: "btn primary" }, icon("plus", 14), `New ${word}`);
    make.addEventListener("click", () => openTargetForm({ kind, plugin: null }));
    const pick = h("button", { class: "btn" }, icon(kind === "extension" ? "puzzle" : "box", 14), `Change an installed one`);
    pick.addEventListener("click", () => openTargetForm({ kind, plugin: "" }));
    list.replaceChildren(h("div", { class: "empty" },
      q ? h("div", {}, "No threads match.") : [
        h("div", { style: { fontSize: "15px", fontWeight: 600, color: "var(--fg)", marginBottom: "6px" } },
          kind === "extension" ? "No Chrome extensions yet" : "No plugins of yours yet"),
        h("div", {}, kind === "extension"
          ? "Say what an extension should do and Claude makes it: it runs in layr's web panels, talks to layr's tools, and keeps every version."
          : "Say what layr should do and Claude makes the plugin, or changes one you have. Every change is kept as a version you can undo."),
        state.targetsError ? h("div", { class: "muted", style: { marginTop: "8px" } }, state.targetsError) : null,
        h("div", { style: { marginTop: "14px" } }, make, kind === "plugin" ? pick : null),
      ]));
    return;
  }
  list.replaceChildren(...visible.map(targetGroup));
}

function targetGroup({ t, threads }) {
  const key = `t:${t.id}`;
  const collapsed = state.collapsed.has(key) && !state.query;
  const chev = icon("chevron", 12);
  chev.classList.add("chev");
  chev.style.transform = collapsed ? "rotate(0deg)" : "rotate(90deg)";
  const toggle = () => {
    state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
    localStorage.setItem("claude.collapsed", JSON.stringify([...state.collapsed]));
    render();
  };
  const acts = [];
  if (t.id !== "_") {
    const add = h("button", { class: "btn ghost small icon-only", title: `New thread on ${t.name}` }, icon("plus", 13));
    add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openTargetForm({ kind: state.mode, plugin: t.id });
    });
    acts.push(add);
  }
  if (state.devtools && !t.missing && (t.place === "made" || t.place === "changed")) {
    const hist = h("button", { class: "btn ghost small icon-only", title: "History, undo and sharing (My plugins)" },
      icon("history", 13));
    hist.addEventListener("click", (ev) => {
      ev.stopPropagation();
      layr.panels.open("main", { plugin: t.id }, { plugin: "devtools" }).catch?.((e) => notify(e.message, "error"));
    });
    acts.push(hist);
  }
  if (t.extension && !t.missing) {
    const reload = h("button", { class: "btn ghost small icon-only", title: "Reload the extension in layr's web panels" },
      icon("refresh", 13));
    reload.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void reloadExtension(t);
    });
    acts.push(reload);
  }
  const [placeLabel, placeTitle] = PLACE[t.place] ?? PLACE.made;
  const head = h("div", { class: "project-head" }, chev, h("span", { class: "name", title: t.description || t.path }, t.name),
    h("span", { class: `place ${t.place}`, title: placeTitle }, placeLabel),
    h("span", { class: "path", title: t.path ?? "" }, t.path ?? ""), acts.length ? h("span", { class: "acts" }, acts) : null);
  chev.addEventListener("click", toggle);
  head.querySelector(".name").addEventListener("click", toggle);
  const rows = threads.map(threadRow);
  return h("div", { class: `project${collapsed ? " collapsed" : ""}` }, head,
    h("div", { class: "threads" }, rows.length ? rows : h("div", { class: "none" }, state.archived ? "No archived threads" : "No threads yet")));
}

async function reloadExtension(t) {
  try {
    await layr.tools.call("extension_reload", { plugin: t.id }, { plugin: "layr" }).then((r) => {
      if (r?.isError) throw new Error(r.content?.map((c) => c.text).join("\n") || "Reload failed");
    });
    notify(`Reloaded ${t.name}`, "success");
  } catch (error) {
    notify(error.message, "error");
  }
}

function threadRow(t) {
  const ws = t.workspace ?? {};
  const waiting = t.pendingApprovals?.length || t.status === "waiting";
  const arch = h("button", { class: "btn ghost small icon-only", title: t.archived ? "Bring back" : "Archive" }, icon(t.archived ? "unarchive" : "archive", 13));
  arch.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    try {
      await call("thread_archive", { thread: t.id, archived: !t.archived });
      state.threads.delete(t.id);
      render();
    } catch (error) {
      notify(error.message, "error");
    }
  });
  const row = h("div", { class: `row${state.active === t.id ? " active" : ""}`, tabindex: "0", title: `${STATUS_LABEL[t.status] ?? t.status} · ${t.cwd}` },
    h("span", { class: `dot ${t.status}` }),
    h("span", { class: "title" }, t.title),
    h("span", { class: "time" }, relTime(t.lastActivity)),
    h("div", { class: "sub" },
      waiting ? h("span", { class: "badge wait" }, icon("shield", 11), "Needs you") : null,
      ws.kind === "worktree" ? h("span", { class: "badge mono", title: ws.path }, icon("branch", 11), ws.branch ?? "worktree") : null,
      t.folderGone ? h("span", { class: "badge warn", title: `Its folder is gone: ${t.cwd}` }, "gone") : null,
      t.queue?.length ? h("span", { class: "badge" }, `${t.queue.length} queued`) : null,
      t.background?.length ? h("span", { class: "badge", title: t.background.map((b) => b.description).join("\n") },
        `${t.background.length} in background`) : null,
      h("span", { class: "prev" }, t.status === "failed" && t.error ? t.error : t.preview || "")),
    h("div", { class: "row-acts" }, arch),
  );
  const open = () => {
    state.active = t.id;
    layr.panels.open("thread", { thread: t.id }).catch?.((e) => notify(e.message, "error"));
    render();
  };
  row.addEventListener("click", open);
  row.addEventListener("keydown", (ev) => ev.key === "Enter" && open());
  row.addEventListener("contextmenu", (ev) => void rowMenu(t, row, ev));
  return row;
}

/** A thread row's right-click menu (the shell's, layr.ui.contextMenu). */
async function rowMenu(t, row, ev) {
  ev.preventDefault();
  // "+ Pipeline" only when the pipeline is there and the thread isn't a task yet.
  const slow = new Promise((resolve) => setTimeout(() => resolve(undefined), 1500));
  const task = t.archived ? undefined : await Promise.race([threadTask(t.id), slow]);
  const phone = onPhone();
  await contextMenu([
    { label: "Open", icon: "open_in_new", run: () => row.click() },
    "-",
    phone ? null : { label: "Open folder in VS Code", icon: "code", run: () => openFolderOnPc(t.id, "vscode") },
    phone ? null : { label: "Open folder in File Explorer", icon: "folder_open", run: () => openFolderOnPc(t.id, "explorer") },
    task === null ? { label: "+ Pipeline", icon: "view_kanban", run: () => adoptThread(t.id) } : null,
    { label: "Rename", icon: "edit", run: () => renameRow(t, row) },
    { label: t.archived ? "Bring back" : "Archive", icon: t.archived ? "unarchive" : "archive", run: () => row.querySelector(".row-acts button")?.click() },
    { label: "Copy link", icon: "link", run: () => copyText(threadLink(t.id), "Link copied") },
  ], ev);
}

function renameRow(t, row) {
  const title = row.querySelector(".title");
  const field = h("input", { class: "input rename", value: t.title });
  field.addEventListener("click", (e) => e.stopPropagation());
  title.replaceWith(field);
  field.focus();
  field.select();
  let finished = false;
  const done = async (save) => {
    if (finished) return;
    finished = true;
    const next = field.value.trim();
    field.replaceWith(title);
    if (!save || !next || next === t.title) return;
    try {
      const r = await call("thread_update", { thread: t.id, title: next });
      state.threads.set(t.id, r.thread);
      render();
    } catch (error) {
      notify(error.message, "error");
    }
  };
  field.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
  field.addEventListener("blur", () => done(true));
}

function renderUsage() {
  const u = state.usage;
  const el = $("usage");
  if (!u?.limits) {
    el.replaceChildren();
    return;
  }
  const meter = (label, w) => {
    if (!w || typeof w.utilization !== "number") return null;
    const pct = Math.max(0, Math.min(100, w.utilization));
    const resets = w.resetsAt ? `resets ${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    return h("span", { class: `meter${pct >= 85 ? " high" : ""}`, title: `${label}: ${pct}% used${resets ? `, ${resets}` : ""}` },
      label, h("span", { class: "bar" }, h("i", { style: { width: `${pct}%` } })), `${Math.round(pct)}%`);
  };
  el.replaceChildren(...[meter("5h", u.limits.fiveHour), meter("Week", u.limits.sevenDay)].filter(Boolean));
  el.title = u.account?.email ? `Claude: ${u.account.email} (${u.account.subscription ?? ""})` : "";
}

// ------------------------------------------------------------------ toolbar

$("search").addEventListener("input", (ev) => {
  state.query = ev.target.value.trim();
  render();
});
$("show-archived").addEventListener("click", async () => {
  state.archived = !state.archived;
  $("show-archived").classList.toggle("on", state.archived);
  $("show-archived").title = state.archived ? "Show active threads" : "Show archived threads";
  await loadThreads();
  render();
});
$("new").addEventListener("click", () => {
  if (!$("new-form").hidden) return closeForm();
  if (state.mode === "projects") openForm();
  else openTargetForm({ kind: state.mode, plugin: null });
});
$("add-project").addEventListener("click", () => openForm(null, { addProject: true }));

function addProjectButton() {
  const b = h("button", { class: "btn primary" }, icon("folder", 14), "Add a project folder");
  b.addEventListener("click", () => openForm(null, { addProject: true }));
  return b;
}

// ------------------------------------------------------------------ new thread form

function closeForm() {
  $("new-form").hidden = true;
  $("new-form").replaceChildren();
}

/** A project from `params.project`: its id, name or folder; a folder that isn't one yet is {path}. */
function projectOf(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  const norm = (p) => String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const found = state.projects.find((p) => p.id === s) || state.projects.find((p) => norm(p.path) === norm(s)) ||
    state.projects.find((p) => p.name.toLowerCase() === s.toLowerCase());
  if (found) return { id: found.id };
  return /[\\/]/.test(s) ? { path: s } : null;
}

/**
 * Open the new-thread form from panel params: `{new: true}`, or `{prompt, project?}` (the concepts panel opens it so,
 * with a prompt to start from). A form open already is filled again only when its prompt is still empty.
 * 0.3.2: `{new: true, target: "plugin" | "extension", plugin?}` opens it on Plugins or Extensions, on that plugin's id
 * (`"new"`: a new one; left out: the first in the list).
 */
function openFormFrom(params) {
  if (!params?.new && !params?.prompt) return;
  const open = !$("new-form").hidden;
  const typed = $("new-form").querySelector("textarea")?.value.trim();
  if (open && (!params.prompt || typed)) return;
  if (params.target === "plugin" || params.target === "extension") {
    setMode(params.target);
    const plugin = params.plugin === "new" ? null : typeof params.plugin === "string" ? params.plugin : "";
    return openTargetForm({ kind: params.target, plugin, prompt: params.prompt });
  }
  if (params.project || params.prompt) setMode("projects");
  else if (state.mode !== "projects") return openTargetForm({ kind: state.mode, plugin: null });
  const project = projectOf(params.project);
  openForm(project?.id, { addProject: Boolean(project?.path), path: project?.path, prompt: params.prompt });
}

function openForm(projectId, { addProject = false, path: folder = "", prompt: text = "" } = {}) {
  const form = $("new-form");
  form.hidden = false;
  const last = localStorage.getItem("claude.lastProject");
  const projectSel = h("select", { class: "select" });
  const pathRow = h("div", { class: "inline-row" });
  const pathInput = h("input", { class: "input", placeholder: "Folder path, e.g. C:\\Users\\me\\code\\my-app" });
  const pathAdd = h("button", { class: "btn small" }, "Add");
  pathRow.append(pathInput, pathAdd);
  const prompt = h("textarea", { class: "textarea", placeholder: "What should Claude do?  (Ctrl+Enter to start)" });
  const model = h("select", { class: "select" });
  const effort = h("select", { class: "select" });
  const mode = h("select", { class: "select" });
  const title = h("input", { class: "input", placeholder: "Title (optional: from the prompt)" });
  const branch = h("input", { class: "input mono", placeholder: "layr/<from the title>" });
  const existing = h("select", { class: "select" });
  const remember = h("input", { type: "checkbox" });
  let workspace = "project";

  const wsButtons = [["project", "folder", "Folder"], ["worktree", "branch", "New worktree"], ["existing", "branch", "Worktree…"]].map(
    ([id, ic, label]) => {
      const b = h("button", { type: "button", title: { project: "Work in the project folder itself", worktree: "A new git worktree on a new branch", existing: "An existing git worktree of the project" }[id] }, icon(ic, 13), label);
      b.addEventListener("click", () => setWorkspace(id));
      return [id, b];
    },
  );
  const wsBranchRow = h("label", { class: "field wide" }, h("span", {}, "Branch"), branch);
  const wsExistingRow = h("label", { class: "field wide" }, h("span", {}, "Worktree"), existing);
  function setWorkspace(id) {
    workspace = id;
    for (const [k, b] of wsButtons) b.classList.toggle("on", k === id);
    wsBranchRow.hidden = id !== "worktree";
    wsExistingRow.hidden = id !== "existing";
    if (id === "existing") void loadWorktrees();
  }
  async function loadWorktrees() {
    fillSelect(existing, [{ value: "", label: "Loading…" }], "");
    try {
      const r = await call("worktrees_list", { project: projectSel.value });
      const trees = (r.worktrees ?? []).filter((t) => !t.main);
      fillSelect(existing, trees.length ? trees.map((t) => ({ value: t.path, label: `${t.branch ?? "(detached)"} — ${t.path}` })) : [{ value: "", label: r.git ? "No other worktrees" : "Not a git repository" }], "");
    } catch (error) {
      fillSelect(existing, [{ value: "", label: error.message }], "");
    }
  }

  function fillProjects(selected) {
    fillSelect(projectSel, [...state.projects.filter((p) => !isPluginProject(p)).map((p) => ({ value: p.id, label: p.name })), { value: "__add", label: "+ Add a folder…" }], selected);
    pathRow.hidden = projectSel.value !== "__add";
    applyDefaults();
  }
  function applyDefaults() {
    const p = state.projects.find((x) => x.id === projectSel.value);
    fillSelect(model, modelOptions(state.models), p?.defaultModel ?? "");
    fillSelect(effort, effortOptions(state.models, model.value || "default"), p?.defaultEffort ?? "");
    fillSelect(mode, permissionOptions(), p?.defaultPermissionMode ?? "default");
  }
  projectSel.addEventListener("change", () => {
    pathRow.hidden = projectSel.value !== "__add";
    if (projectSel.value === "__add") pathInput.focus();
    else {
      applyDefaults();
      if (workspace === "existing") void loadWorktrees();
    }
  });
  model.addEventListener("change", () => fillSelect(effort, effortOptions(state.models, model.value || "default"), effort.value));
  document.addEventListener("claude-models", () => {
    if (!model.isConnected) return;
    fillSelect(model, modelOptions(state.models), model.value);
    fillSelect(effort, effortOptions(state.models, model.value || "default"), effort.value);
  });
  async function addFolder() {
    const path = pathInput.value.trim().replace(/^"|"$/g, "");
    if (!path) return;
    pathAdd.disabled = true;
    try {
      const r = await call("project_add", { path });
      await loadProjects();
      fillProjects(r.project.id);
      render();
      prompt.focus();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      pathAdd.disabled = false;
    }
  }
  pathAdd.addEventListener("click", addFolder);
  pathInput.addEventListener("keydown", (ev) => ev.key === "Enter" && addFolder());

  const start = h("button", { class: "btn primary" }, icon("send", 14), "Start");
  const cancel = h("button", { class: "btn" }, "Cancel");
  const status = h("span", { class: "muted" });
  cancel.addEventListener("click", closeForm);
  async function submit() {
    if (projectSel.value === "__add" || !projectSel.value) return notify("Pick or add a project first", "error");
    if (!prompt.value.trim()) return prompt.focus();
    const args = {
      project: projectSel.value,
      prompt: prompt.value,
      permissionMode: mode.value,
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
    };
    if (workspace === "worktree") {
      args.workspace = "worktree";
      if (branch.value.trim()) args.branch = branch.value.trim();
    } else if (workspace === "existing") {
      if (!existing.value) return notify("Pick a worktree", "error");
      args.workspace = { worktreePath: existing.value };
    }
    start.disabled = true;
    status.textContent = workspace === "worktree" ? "Making the worktree…" : "Starting…";
    try {
      const r = await call("thread_start", args);
      localStorage.setItem("claude.lastProject", projectSel.value);
      if (remember.checked) {
        await call("project_update", { project: projectSel.value, defaultModel: model.value || null, defaultEffort: effort.value || null, defaultPermissionMode: mode.value });
        await loadProjects();
      }
      state.threads.set(r.thread.id, r.thread);
      state.active = r.thread.id;
      closeForm();
      render();
      layr.panels.open("thread", { thread: r.thread.id });
    } catch (error) {
      notify(error.message, "error");
      status.textContent = "";
      start.disabled = false;
    }
  }
  start.addEventListener("click", submit);
  prompt.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submit();
    }
  });
  form.addEventListener("keydown", (ev) => ev.key === "Escape" && closeForm());

  const closeX = h("button", { class: "btn ghost small icon-only", title: "Close" }, icon("x", 14));
  closeX.addEventListener("click", closeForm);
  form.replaceChildren(
    h("div", { class: "form-title" }, "New thread", closeX),
    h("label", { class: "field" }, h("span", {}, "Project"), projectSel),
    pathRow,
    h("label", { class: "field" }, h("span", {}, "Prompt"), prompt),
    h("div", { class: "grid" },
      h("label", { class: "field" }, h("span", {}, "Model"), model),
      h("label", { class: "field" }, h("span", {}, "Effort"), effort),
      h("label", { class: "field wide" }, h("span", {}, "Permissions"), mode),
      h("div", { class: "field wide" }, h("span", {}, "Workspace"), h("div", { class: "ws-choice" }, wsButtons.map(([, b]) => b))),
      wsBranchRow,
      wsExistingRow,
      h("label", { class: "field wide" }, h("span", {}, "Title"), title)),
    h("label", { class: "muted", style: { fontSize: "12px", display: "flex", gap: "6px", alignItems: "center" } }, remember, "Remember model, effort and permissions for this project"),
    h("div", { class: "form-actions" }, status, cancel, start),
  );
  const own = state.projects.filter((p) => !isPluginProject(p));
  const initial = projectId ?? (own.some((p) => p.id === last) ? last : own[0]?.id ?? "__add");
  fillProjects(addProject ? "__add" : initial);
  setWorkspace("project");
  if (folder) pathInput.value = folder;
  if (text) prompt.value = String(text);
  prompt.addEventListener("input", () => {
    const slug = (title.value || prompt.value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
    branch.placeholder = `layr/${slug || "<from the title>"}`;
  });
  if (text) prompt.dispatchEvent(new Event("input"));
  (addProject || projectSel.value === "__add" ? pathInput : prompt).focus();
}

// ------------------------------------------------------------------ new thread on a plugin or extension

const EXAMPLES = {
  plugin: [
    "A lab notebook: log samples with date, species, notes and a photo, in a sortable table",
    "Plot the CSV files from my experiments as line charts, with the columns I pick",
    "A reading list of papers with a status (to read, reading, done) and my notes",
  ],
  extension: [
    "Hide YouTube's recommendations and Shorts, so only the video I opened shows",
    "Save the article I'm reading to layr with its title, address and the text I selected",
    "A tool for agents that gives the open page's main text, so Claude can read pages I have open",
  ],
};

/**
 * The form for a thread on a plugin or extension. `plugin`: an id, null for a new one, "" for the first installed one.
 * A store plugin gets your own copy first (the backend asks layr__plugin_edit); a new one gets its own folder and
 * repository in ~/layr-plugins, an extension from a small template that already talks to layr.
 */
function openTargetForm({ kind, plugin, prompt: text = "" }) {
  const form = $("new-form");
  form.hidden = false;
  const word = kind === "extension" ? "extension" : "plugin";
  const mine = state.targets.filter((t) => targetMode(t) === kind && t.place !== "store")
    .sort((a, b) => a.name.localeCompare(b.name));
  const store = kind === "plugin" ? state.targets.filter((t) => t.place === "store").sort((a, b) => a.name.localeCompare(b.name)) : [];
  const targetSel = h("select", { class: "select" },
    h("option", { value: "__new" }, `+ New ${word}`),
    mine.length ? h("optgroup", { label: kind === "extension" ? "Your extensions" : "Your plugins" },
      mine.map((t) => h("option", { value: t.id }, t.place === "inside" ? `${t.name} (in its repository)` : t.name))) : null,
    store.length ? h("optgroup", { label: "Installed from the store (Claude works on your own copy)" },
      store.map((t) => h("option", { value: t.id }, t.name))) : null);
  const first = plugin === "" ? (mine[0] ?? store[0])?.id : plugin;
  targetSel.value = first && state.targets.some((t) => t.id === first) ? first : "__new";
  const name = h("input", { class: "input", placeholder: kind === "extension" ? "Name (optional), e.g. Quiet YouTube" : "Name (optional), e.g. Lab notebook" });
  const nameRow = h("label", { class: "field" }, h("span", {}, "Name"), name);
  const prompt = h("textarea", { class: "textarea" });
  const promptLabel = h("span", {});
  const examples = h("div", { class: "examples" }, EXAMPLES[kind].map((ex) => {
    const b = h("button", { type: "button", class: "chip" }, ex);
    b.addEventListener("click", () => {
      prompt.value = ex;
      prompt.focus();
    });
    return b;
  }));
  const note = h("div", { class: "target-note" });
  const model = h("select", { class: "select" });
  const effort = h("select", { class: "select" });
  const mode = h("select", { class: "select" });
  fillSelect(model, modelOptions(state.models), "");
  fillSelect(effort, effortOptions(state.models, "default"), "");
  model.addEventListener("change", () => fillSelect(effort, effortOptions(state.models, model.value || "default"), effort.value));
  document.addEventListener("claude-models", () => {
    if (!model.isConnected) return;
    fillSelect(model, modelOptions(state.models), model.value);
    fillSelect(effort, effortOptions(state.models, model.value || "default"), effort.value);
  });

  function update() {
    const isNew = targetSel.value === "__new";
    const t = state.targets.find((x) => x.id === targetSel.value);
    nameRow.hidden = !isNew;
    examples.hidden = !isNew;
    promptLabel.textContent = isNew ? "What should it do?" : "What should Claude change?";
    prompt.placeholder = isNew
      ? `Say in your own words what the ${word} should do.  (Ctrl+Enter to start)`
      : `For example: add a search box.  (Ctrl+Enter to start)`;
    // New ones: files without asking (commands still ask), as the plugin maker did; existing ones: as threads do.
    fillSelect(mode, permissionOptions(), isNew ? "acceptEdits" : (mode.dataset.touched ? mode.value : "default"));
    note.textContent = isNew
      ? `A new folder in ~/layr-plugins, its own git repository: every turn is saved as a version you can undo${state.devtools ? " (My plugins › History)" : ""}.`
      : t?.place === "store"
        ? `Claude works on your own copy of ${t.name}; layr runs your copy from then on, and store updates are merged into it.`
        : t ? `${PLACE[t.place]?.[1] ?? ""}. Folder: ${t.path}` : "";
  }
  mode.addEventListener("change", () => (mode.dataset.touched = "1"));
  targetSel.addEventListener("change", update);

  const start = h("button", { class: "btn primary" }, icon("send", 14), "Start");
  const cancel = h("button", { class: "btn" }, "Cancel");
  const status = h("span", { class: "muted" });
  cancel.addEventListener("click", closeForm);
  async function submit() {
    if (!prompt.value.trim()) return prompt.focus();
    const isNew = targetSel.value === "__new";
    const target = { kind, ...(isNew ? (name.value.trim() ? { name: name.value.trim() } : {}) : { plugin: targetSel.value }) };
    start.disabled = true;
    const t = state.targets.find((x) => x.id === targetSel.value);
    status.textContent = isNew ? `Making the ${word}'s folder…` : t?.place === "store" ? "Making your copy…" : "Starting…";
    try {
      const r = await call("thread_start", {
        target,
        prompt: prompt.value,
        permissionMode: mode.value,
        ...(model.value ? { model: model.value } : {}),
        ...(effort.value ? { effort: effort.value } : {}),
      });
      state.threads.set(r.thread.id, r.thread);
      state.active = r.thread.id;
      closeForm();
      await loadTargets();
      render();
      layr.panels.open("thread", { thread: r.thread.id });
    } catch (error) {
      notify(error.message, "error");
      status.textContent = "";
      start.disabled = false;
    }
  }
  start.addEventListener("click", submit);
  prompt.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submit();
    }
  });
  form.addEventListener("keydown", (ev) => ev.key === "Escape" && closeForm());
  const closeX = h("button", { class: "btn ghost small icon-only", title: "Close" }, icon("x", 14));
  closeX.addEventListener("click", closeForm);
  form.replaceChildren(
    h("div", { class: "form-title" }, kind === "extension" ? "New thread on an extension" : "New thread on a plugin", closeX),
    h("label", { class: "field" }, h("span", {}, kind === "extension" ? "Extension" : "Plugin"), targetSel),
    note,
    nameRow,
    h("label", { class: "field" }, promptLabel, prompt),
    examples,
    h("div", { class: "grid" },
      h("label", { class: "field" }, h("span", {}, "Model"), model),
      h("label", { class: "field" }, h("span", {}, "Effort"), effort),
      h("label", { class: "field wide" }, h("span", {}, "Permissions"), mode)),
    h("div", { class: "form-actions" }, status, cancel, start),
  );
  update();
  if (text) prompt.value = String(text);
  prompt.focus();
}

// ------------------------------------------------------------------ start (last, so every binding above exists)

renderModes();
await Promise.all([loadProjects(), loadTargets(), loadThreads().catch((e) => notify(`Claude: ${e.message}`, "error"))]);
// My plugins (devtools) shows a plugin's history; its button is offered only when it is installed.
state.devtools = await layr.commands.list().then((cs) => cs.some((c) => c.id === "devtools.open"), () => false);
render();
void loadModels().then(() => document.dispatchEvent(new Event("claude-models")));
void loadUsage(false);
openFormFrom(layr.info?.params);
// "New Claude thread" while this (single) panel is open: it is opened again with {new: true} (or {prompt, project}).
layr.panel.onParams((params) => openFormFrom(params));
setInterval(render, 30_000);
setInterval(() => loadUsage(false), 5 * 60_000);
