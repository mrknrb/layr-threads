// The threads panel: every thread in one list (the last changed first), live status, search, archive, and the
// new-thread form.
// 0.12.0: no Projects / Plugins / Extensions tabs any more, and threads aren't grouped by project or plugin. Each row
// says what it works on. The form asks "Works on": a project (then which folder) or plugins (an empty folder whose
// plugin list fills as you mention plugins with @; an extension is just a plugin that brings one).
import {
  call,
  defaultModelName,
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
  statusLabel,
} from "./common.js";
import {
  adoptThread,
  contextMenu,
  copyText,
  onPhone,
  openFolderOnPc,
  openLink,
  pluginPageLink,
  threadLink,
  threadTask,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const state = {
  targets: [],
  targetsError: null,
  projects: [],
  threads: new Map(),
  models: [],
  archived: false,
  query: "",
  active: null,
  usage: null,
};

const layr = await ready();
$("search-icon").append(icon("search", 14));
$("new").append(icon("plus", 14), "New");
$("add-project").append(icon("folder", 14));
$("show-archived").append(icon("archive", 14));

on("threads:threads", (ev) => {
  if (ev?.kind === "thread" && ev.thread) {
    const t = ev.thread;
    if (Boolean(t.archived) !== state.archived) state.threads.delete(t.id);
    else state.threads.set(t.id, t);
    render();
  } else if (ev?.kind === "projects") void loadProjects().then(render);
});
on("threads:usage", () => void loadUsage(false));
// Plugins installed, linked, switched or removed: the rows' plugin names follow.
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

const isPluginProject = (p) => p.kind === "plugin";

/** 0.12.0: what a thread works on, for its row: the project's name, or the plugins on its list. */
function whereOf(t) {
  if (t.kind !== "plugin") {
    const p = state.projects.find((x) => x.id === t.projectId);
    return { icon: "folder", text: p?.name ?? "", title: p?.path ?? t.cwd ?? "" };
  }
  const ids = Array.isArray(t.plugins) ? t.plugins : t.target?.plugin ? [{ id: t.target.plugin }] : [];
  const names = ids.map((r) => r.name || state.targets.find((x) => x.id === r.id)?.name || r.id);
  return { icon: "box", text: names.length ? names.join(", ") : "No plugins yet", title: names.length ? `Plugins: ${names.join(", ")}` : "Plugins: none on its list yet" };
}

/** Every thread (projects and plugins together) matching the search, the last changed first. */
function visibleThreads() {
  const q = state.query.toLowerCase();
  return [...state.threads.values()]
    .filter((t) => !q || `${t.title} ${t.preview} ${t.workspace?.branch ?? ""} ${whereOf(t).text}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
}

function render() {
  const list = $("list");
  const threads = visibleThreads();
  if (!threads.length) {
    const make = h("button", { class: "btn primary" }, icon("plus", 14), "New thread");
    make.addEventListener("click", () => openForm());
    list.replaceChildren(h("div", { class: "empty" },
      state.query ? "No threads match." : state.archived ? "No archived threads." : [
        h("div", { style: { fontSize: "15px", fontWeight: 600, color: "var(--fg)", marginBottom: "6px" } }, "No threads yet"),
        h("div", {}, "Start one in a project folder, or on your layr plugins: say what Claude should make or change."),
        h("div", { style: { marginTop: "14px" } }, make),
      ]));
    return;
  }
  list.replaceChildren(...threads.map(threadRow));
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
  const where = whereOf(t);
  const row = h("div", { class: `row${state.active === t.id ? " active" : ""}`, tabindex: "0", title: `${statusLabel(t)} · ${t.cwd}` },
    h("span", { class: `dot ${t.status}${t.limitPause ? " paused" : ""}` }),
    h("span", { class: "title" }, t.title),
    h("span", { class: "time" }, relTime(t.lastActivity)),
    h("div", { class: "sub" },
      waiting ? h("span", { class: "badge wait" }, icon("shield", 11), "Needs you") : null,
      where.text ? h("span", { class: "badge where", title: where.title }, icon(where.icon, 11), where.text) : null,
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
    t.kind === "plugin" ? null : { label: "New thread in this project", icon: "add", run: () => openForm({ on: "project", projectId: t.projectId }) },
    ...pluginItems(t),
    { label: "Rename", icon: "edit", run: () => renameRow(t, row) },
    { label: t.archived ? "Bring back" : "Archive", icon: t.archived ? "unarchive" : "archive", run: () => row.querySelector(".row-acts button")?.click() },
    { label: "Copy link", icon: "link", run: () => copyText(threadLink(t.id), "Link copied") },
  ], ev);
}

/** A plugin thread's menu items for its plugins: their history page, and reloading the ones that bring an extension. */
function pluginItems(t) {
  if (t.kind !== "plugin" || !Array.isArray(t.plugins) || !t.plugins.length) return [];
  const items = ["-"];
  for (const p of t.plugins) {
    if (p.place !== "inside") items.push({ label: `${p.name || p.id}: history and undo`, icon: "history", run: () => openLink(pluginPageLink(p.id, "history")) });
    if (p.extension) items.push({ label: `${p.name || p.id}: reload its extension`, icon: "refresh", run: () => reloadExtension(p) });
  }
  return items;
}

async function reloadExtension(p) {
  try {
    await layr.tools.call("extension_reload", { plugin: p.id }, { plugin: "layr" }).then((r) => {
      if (r?.isError) throw new Error(r.content?.map((c) => c.text).join("\n") || "Reload failed");
    });
    notify(`Reloaded ${p.name || p.id}`, "success");
  } catch (error) {
    notify(error.message, "error");
  }
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
  openForm();
});
$("add-project").addEventListener("click", () => openForm({ on: "project", addProject: true }));

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
 * `{new: true, target: "plugin" | "extension", plugin?}` opens it on plugins; a plugin id puts that plugin on the
 * thread's list from the start (`"new"`: Claude makes a new one), left out: an empty list.
 */
function openFormFrom(params) {
  if (!params?.new && !params?.prompt) return;
  const open = !$("new-form").hidden;
  const typed = $("new-form").querySelector("textarea")?.value.trim();
  if (open && (!params.prompt || typed)) return;
  if (params.target === "plugin" || params.target === "extension") {
    const preset = params.plugin === "new" ? { kind: params.target, plugin: null }
      : typeof params.plugin === "string" && params.plugin ? { kind: params.target, plugin: params.plugin } : null;
    return openForm({ on: "plugins", preset, prompt: params.prompt });
  }
  const project = projectOf(params.project);
  openForm({
    on: params.project || params.prompt ? "project" : undefined,
    projectId: project?.id, addProject: Boolean(project?.path), path: project?.path, prompt: params.prompt,
  });
}

/**
 * The one new-thread form. "Works on": a project (pick or add its folder; folder or worktree) or plugins (Claude
 * starts in an empty folder of its own; plugins come onto its list as you or Claude mention them, and it asks before
 * changing one). `preset` ({kind, plugin}: an id, or null for a new one) starts a plugin thread with that plugin on
 * its list, allowed to change (other panels open the form so).
 */
function openForm({ on: onArg, projectId, addProject = false, path: folder = "", prompt: text = "", preset = null } = {}) {
  const form = $("new-form");
  form.hidden = false;
  const own = () => state.projects.filter((p) => !isPluginProject(p));
  const lastOn = localStorage.getItem("claude.lastOn");
  let on = onArg ?? (addProject || projectId ? "project" : lastOn === "project" || lastOn === "plugins" ? lastOn : own().length ? "project" : "plugins");
  const last = localStorage.getItem("claude.lastProject");

  const projectSel = h("select", { class: "select" });
  const removeProject = h("button", { type: "button", class: "btn ghost small icon-only", title: "Remove this project from the list (its folder stays)" }, icon("trash", 13));
  const pathRow = h("div", { class: "inline-row" });
  const pathInput = h("input", { class: "input", placeholder: "Folder path, e.g. C:\\Users\\me\\code\\my-app" });
  const pathAdd = h("button", { class: "btn small" }, "Add");
  pathRow.append(pathInput, pathAdd);
  const prompt = h("textarea", { class: "textarea" });
  const model = h("select", { class: "select" });
  const effort = h("select", { class: "select" });
  const mode = h("select", { class: "select" });
  const title = h("input", { class: "input", placeholder: "Title (optional: from the prompt)" });
  const branch = h("input", { class: "input mono", placeholder: "layr/<from the title>" });
  const existing = h("select", { class: "select" });
  const remember = h("input", { type: "checkbox" });
  const note = h("div", { class: "target-note" });
  let workspace = "project";

  const onButtons = [["project", "folder", "A project"], ["plugins", "box", "Plugins"]].map(([id, ic, label]) => {
    const b = h("button", { type: "button", title: { project: "Claude works in one of your folders", plugins: "Claude makes or changes your layr plugins (and Chrome extensions, which plugins can bring)" }[id] }, icon(ic, 13), label);
    b.addEventListener("click", () => setOn(id));
    return [id, b];
  });
  const wsButtons = [["project", "folder", "Folder"], ["worktree", "branch", "New worktree"], ["existing", "branch", "Worktree…"]].map(
    ([id, ic, label]) => {
      const b = h("button", { type: "button", title: { project: "Work in the project folder itself", worktree: "A new git worktree on a new branch", existing: "An existing git worktree of the project" }[id] }, icon(ic, 13), label);
      b.addEventListener("click", () => setWorkspace(id));
      return [id, b];
    },
  );
  const projectRow = h("div", { class: "field" }, h("span", {}, "Project"), h("div", { class: "inline-row" }, projectSel, removeProject));
  const wsRow = h("div", { class: "field wide" }, h("span", {}, "Workspace"), h("div", { class: "ws-choice" }, wsButtons.map(([, b]) => b)));
  const wsBranchRow = h("label", { class: "field wide" }, h("span", {}, "Branch"), branch);
  const wsExistingRow = h("label", { class: "field wide" }, h("span", {}, "Worktree"), existing);
  const titleRow = h("label", { class: "field wide" }, h("span", {}, "Title"), title);
  const rememberRow = h("label", { class: "muted", style: { fontSize: "12px", display: "flex", gap: "6px", alignItems: "center" } }, remember, "Remember model, effort and permissions for this project");

  function setWorkspace(id) {
    workspace = id;
    for (const [k, b] of wsButtons) b.classList.toggle("on", k === id);
    wsBranchRow.hidden = on !== "project" || id !== "worktree";
    wsExistingRow.hidden = on !== "project" || id !== "existing";
    if (on === "project" && id === "existing") void loadWorktrees();
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
  function setOn(id) {
    on = id;
    for (const [k, b] of onButtons) b.classList.toggle("on", k === id);
    const p = id === "project";
    projectRow.hidden = !p;
    pathRow.hidden = !p || projectSel.value !== "__add";
    wsRow.hidden = !p;
    titleRow.hidden = !p;
    rememberRow.hidden = !p;
    note.hidden = p;
    setWorkspace(workspace);
    const presetName = preset ? (preset.plugin ? state.targets.find((t) => t.id === preset.plugin)?.name ?? preset.plugin : `a new ${preset.kind === "extension" ? "extension" : "plugin"}`) : "";
    note.textContent = preset
      ? `Starts with ${presetName} on its list, allowed to change. Mention more plugins with @ as you go. Every change is saved as a version you can take back.`
      : "Claude starts in an empty folder of its own. Plugins you mention with @ it may read, and it asks you before changing one (or making a new one). It changes its own copy of each plugin: the app runs the plugin as it was until you press Land (Try shows it first).";
    prompt.placeholder = p ? "What should Claude do?  (Ctrl+Enter to start)"
      : "For example: make @youtube sort by date, the way @pipeline does, or: a new plugin for my lab notes.  (Ctrl+Enter to start)";
    applyDefaults();
  }

  function fillProjects(selected) {
    fillSelect(projectSel, [...own().map((p) => ({ value: p.id, label: p.name })), { value: "__add", label: "+ Add a folder…" }], selected);
    pathRow.hidden = on !== "project" || projectSel.value !== "__add";
    removeProject.hidden = projectSel.value === "__add";
    applyDefaults();
  }
  /** The options with what "Default" stands for in the folder Claude starts in (Claude Code's settings there). */
  const startProject = () => on === "project" ? state.projects.find((x) => x.id === projectSel.value)
    : state.projects.find(isPluginProject) ?? state.projects[0];
  const shown = () => {
    const d = startProject()?.claudeDefaults ?? {};
    return { defaultName: defaultModelName(state.models, { setting: d.model }), defaultEffort: d.effort ?? null };
  };
  const modelOpts = () => modelOptions(state.models, { defaultName: shown().defaultName });
  const effortOpts = () =>
    effortOptions(state.models, model.value || "default", { defaultEffort: shown().defaultEffort });
  function applyDefaults() {
    const p = on === "project" ? state.projects.find((x) => x.id === projectSel.value) : null;
    fillSelect(model, modelOpts(), p?.defaultModel ?? "");
    fillSelect(effort, effortOpts(), p?.defaultEffort ?? "");
    // A new plugin: files without asking (commands still ask), as the plugin maker did.
    fillSelect(mode, permissionOptions(), p?.defaultPermissionMode ?? (preset && !preset.plugin ? "acceptEdits" : "default"));
  }
  projectSel.addEventListener("change", () => {
    pathRow.hidden = projectSel.value !== "__add";
    removeProject.hidden = projectSel.value === "__add";
    if (projectSel.value === "__add") pathInput.focus();
    else {
      applyDefaults();
      if (workspace === "existing") void loadWorktrees();
    }
  });
  removeProject.addEventListener("click", async () => {
    if (removeProject.dataset.armed !== "1") {
      removeProject.dataset.armed = "1";
      removeProject.classList.add("danger");
      removeProject.title = "Click again to remove (its folder and threads stay)";
      setTimeout(() => {
        removeProject.dataset.armed = "";
        removeProject.classList.remove("danger");
        removeProject.title = "Remove this project from the list (its folder stays)";
      }, 3000);
      return;
    }
    removeProject.dataset.armed = "";
    removeProject.classList.remove("danger");
    try {
      await call("project_remove", { project: projectSel.value });
      await loadProjects();
      fillProjects(own()[0]?.id ?? "__add");
      render();
    } catch (error) {
      notify(error.message, "error");
    }
  });
  model.addEventListener("change", () => fillSelect(effort, effortOpts(), effort.value));
  document.addEventListener("claude-models", () => {
    if (!model.isConnected) return;
    fillSelect(model, modelOpts(), model.value);
    fillSelect(effort, effortOpts(), effort.value);
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
    if (on === "project" && (projectSel.value === "__add" || !projectSel.value)) return notify("Pick or add a project first", "error");
    if (!prompt.value.trim()) return prompt.focus();
    const args = {
      prompt: prompt.value,
      permissionMode: mode.value,
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
    };
    if (on === "project") {
      args.project = projectSel.value;
      if (title.value.trim()) args.title = title.value.trim();
      if (workspace === "worktree") {
        args.workspace = "worktree";
        if (branch.value.trim()) args.branch = branch.value.trim();
      } else if (workspace === "existing") {
        if (!existing.value) return notify("Pick a worktree", "error");
        args.workspace = { worktreePath: existing.value };
      }
    } else {
      args.target = preset ? { kind: preset.kind, ...(preset.plugin ? { plugin: preset.plugin } : {}) } : { kind: "plugins" };
    }
    start.disabled = true;
    const presetTarget = preset?.plugin ? state.targets.find((t) => t.id === preset.plugin) : null;
    status.textContent = on === "project" && workspace === "worktree" ? "Making the worktree…"
      : preset && !preset.plugin ? "Making the plugin's folder…" : presetTarget?.place === "store" ? "Making your copy…" : "Starting…";
    try {
      const r = await call("thread_start", args);
      localStorage.setItem("claude.lastOn", on);
      if (on === "project") {
        localStorage.setItem("claude.lastProject", projectSel.value);
        if (remember.checked) {
          await call("project_update", { project: projectSel.value, defaultModel: model.value || null, defaultEffort: effort.value || null, defaultPermissionMode: mode.value });
          await loadProjects();
        }
      } else await loadTargets();
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
    h("div", { class: "field" }, h("span", {}, "Works on"), h("div", { class: "ws-choice" }, onButtons.map(([, b]) => b))),
    projectRow,
    pathRow,
    note,
    h("label", { class: "field" }, h("span", {}, "Prompt"), prompt),
    h("div", { class: "grid" },
      h("label", { class: "field" }, h("span", {}, "Model"), model),
      h("label", { class: "field" }, h("span", {}, "Effort"), effort),
      h("label", { class: "field wide" }, h("span", {}, "Permissions"), mode),
      wsRow,
      wsBranchRow,
      wsExistingRow,
      titleRow),
    rememberRow,
    h("div", { class: "form-actions" }, status, cancel, start),
  );
  const initial = projectId ?? (own().some((p) => p.id === last) ? last : own()[0]?.id ?? "__add");
  fillProjects(addProject ? "__add" : initial);
  setOn(on);
  if (folder) pathInput.value = folder;
  if (text) prompt.value = String(text);
  prompt.addEventListener("input", () => {
    const slug = (title.value || prompt.value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
    branch.placeholder = `layr/${slug || "<from the title>"}`;
  });
  if (text) prompt.dispatchEvent(new Event("input"));
  (on === "project" && (addProject || projectSel.value === "__add") ? pathInput : prompt).focus();
}

// ------------------------------------------------------------------ start (last, so every binding above exists)

await Promise.all([loadProjects(), loadTargets(), loadThreads().catch((e) => notify(`Claude: ${e.message}`, "error"))]);
render();
void loadModels().then(() => document.dispatchEvent(new Event("claude-models")));
void loadUsage(false);
openFormFrom(layr.info?.params);
// "New thread" while this (single) panel is open: it is opened again with {new: true} (or {prompt, project}).
layr.panel.onParams((params) => openFormFrom(params));
setInterval(render, 30_000);
setInterval(() => loadUsage(false), 5 * 60_000);
