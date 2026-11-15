// The threads panel: projects with their Claude threads, live status, search, archive, and the new-thread form.
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

const $ = (id) => document.getElementById(id);
const state = {
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

function render() {
  const list = $("list");
  const q = state.query.toLowerCase();
  const threads = [...state.threads.values()]
    .filter((t) => !q || `${t.title} ${t.preview} ${t.workspace?.branch ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
  if (!state.projects.length) {
    list.replaceChildren(
      h("div", { class: "empty" },
        h("div", { style: { fontSize: "15px", fontWeight: 600, color: "var(--fg)", marginBottom: "6px" } }, "No projects yet"),
        h("div", {}, "A project is a folder Claude works in. Add one to start a thread."),
        h("div", { style: { marginTop: "14px" } }, addProjectButton())),
    );
    return;
  }
  const groups = state.projects.map((p) => ({ p, threads: threads.filter((t) => t.projectId === p.id) }));
  const orphans = threads.filter((t) => !state.projects.some((p) => p.id === t.projectId));
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
      t.queue?.length ? h("span", { class: "badge" }, `${t.queue.length} queued`) : null,
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
  return row;
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
$("new").addEventListener("click", () => ($("new-form").hidden ? openForm() : closeForm()));
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

function openForm(projectId, { addProject = false } = {}) {
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
    fillSelect(projectSel, [...state.projects.map((p) => ({ value: p.id, label: p.name })), { value: "__add", label: "+ Add a folder…" }], selected);
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
  const initial = projectId ?? (state.projects.some((p) => p.id === last) ? last : state.projects[0]?.id ?? "__add");
  fillProjects(addProject ? "__add" : initial);
  setWorkspace("project");
  prompt.addEventListener("input", () => {
    const slug = (title.value || prompt.value).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
    branch.placeholder = `layr/${slug || "<from the title>"}`;
  });
  (addProject || projectSel.value === "__add" ? pathInput : prompt).focus();
}

// ------------------------------------------------------------------ start (last, so every binding above exists)

await Promise.all([loadProjects(), loadThreads().catch((e) => notify(`Claude: ${e.message}`, "error"))]);
render();
void loadModels().then(() => document.dispatchEvent(new Event("claude-models")));
void loadUsage(false);
if (layr.info?.params?.new) openForm();
// "New Claude thread" while this (single) panel is open: it is opened again with {new: true}.
layr.panel.onParams((params) => {
  if (params?.new && $("new-form").hidden) openForm();
});
setInterval(render, 30_000);
setInterval(() => loadUsage(false), 5 * 60_000);
