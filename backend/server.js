#!/usr/bin/env node
// layr plugin "threads" (until 0.15.0 "claude"): layr's chat and agent threads, Claude Code its first harness. An
// MCP server on stdio (the core is its client): its tools are what the panels, other plugins (a pipeline) and agents
// use to run threads.
// Contract: docs/ARCHITECTURE.md > The MCP hub. Environment: LAYR_HUB_URL, LAYR_HUB_TOKEN, LAYR_DATA_DIR...
import { Skills } from "./skills.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Account } from "./account.js";
import { ASK_DEFAULT_MODEL, ask } from "./ask.js";
import { autoCommit, lastPrompt } from "./autoCommit.js";
import { BuildTimes } from "./buildTimes.js";
import { fileDiff, threadChanges } from "./changes.js";
import { Engine, PERMISSION_MODES } from "./engine.js";
import { isGitRepo, listWorktrees, worktreeStatus } from "./git.js";
import { Hub } from "./hub.js";
import { applyMoves } from "./moved.js";
import { linkIfReady, oldPluginsRoot, packagesRoot } from "./pluginMaker.js";
import { Store } from "./store.js";
import { copyNameOf, parseMentions, PluginRestarts, publicRow, ThreadPlugins } from "./threadPlugins.js";
import { isPluginsRoot, listTargets, readManifest, TARGET_KINDS } from "./targets.js";
import { claudeDefaults } from "./defaults.js";
import { checkFresh, openFolder, openTerminal } from "./terminal.js";
import { ensureDir, errorMessage, isDirectory, log, newId, titleFromPrompt, truncate } from "./util.js";

/** Slash commands every Claude Code session has, shown before it has listed its own. */
const BUILTIN_COMMANDS = [
  { name: "compact", description: "Summarize the conversation so far, to free up context", argumentHint: "<what to keep>" },
  { name: "context", description: "Show what fills the context window", argumentHint: "" },
];

const dataDir = process.env.LAYR_DATA_DIR || path.join(os.homedir(), ".layr-claude-dev");
const store = new Store(dataDir);
// Plugin folders the core moved into its home (one folder for each plugin): their projects and threads follow, before
// the engine picks anything up again.
try {
  applyMoves({ store });
} catch (error) {
  log("following the plugin folders layr moved failed:", errorMessage(error));
}
const hub = new Hub({ url: process.env.LAYR_HUB_URL, token: process.env.LAYR_HUB_TOKEN });
// Another Claude account signed in (the accounts plugin switched the live login): its limits, not the old one's.
const account = new Account({
  onAccountChanged: () => {
    hub.emit("threads:usage", { limits: account.limits, account: account.limitsAccount ?? null });
    // Threads paused for the old account's usage limit go on now if this one has room (0.9.0).
    void Promise.resolve()
      .then(() => engine.checkLimitPauses())
      .catch((error) => log("going on after the usage limit:", errorMessage(error)));
  },
});
const buildTimes = new BuildTimes({ dataDir, store });
const engine = new Engine({ store, hub, account, buildTimes });
engine.skills = new Skills({ hub, dataDir });
// 0.7.0: threads with a plugin list (threadPlugins.js): their tools, folders, guard and prompt in each session.
const plugins = new ThreadPlugins({ engine, hub, store, dataDir });
engine.sessionExtras = (meta) => (ThreadPlugins.has(meta) ? plugins.sessionExtras(meta) : Promise.resolve(null));
engine.autoAllow = (meta, toolName, input) => plugins.autoAllow(meta, toolName, input);
// 0.11.0: plugins a turn changed are restarted; threads and pipeline only once no thread has a turn running.
const restarts = new PluginRestarts({
  busy: () => [...engine.lives.values()].some((live) => live.turnActive),
});

// After each turn that ends well: what it changed in a plugin's own repository is committed (autoCommit.js), then
// threads on a plugin link a plugin they made into layr and reload its Chrome extension, if it brings one.
engine.onTurnEnded = (meta, status) => {
  // The plugins this turn held for writing are free again (one thread writes a plugin at a time).
  plugins.locks.release(meta.id);
  void restarts.tick();
  if (status !== "done") return;
  if (ThreadPlugins.has(meta)) {
    void commitPlugins(meta).then((saved) => afterPluginsTurn(meta, saved));
    return;
  }
  void commitTurn(meta).finally(() => {
    if (meta.kind === "plugin") void afterPluginTurn(meta);
  });
};

/** A thread with a plugin list: one commit per plugin it changed (with the thread's trailers), each said in it. */
async function commitPlugins(meta) {
  if (process.env.LAYR_CLAUDE_AUTOCOMMIT === "0") return [];
  const prompt = lastPrompt(store.readTranscript(meta.id));
  const turn = Number.isInteger(meta.turns) && meta.turns > 0 ? meta.turns : undefined;
  const saved = await plugins.commit(meta, { prompt, reply: engine.lastReply(meta.id), turn });
  for (const { row, done } of saved) {
    if (!done.commit) continue;
    log(`saved ${done.files} file(s) of ${row.id}: ${done.subject}`);
    const entry = store.append(meta.id, {
      type: "system",
      subtype: "saved",
      text: `Saved ${row.name} as a version: ${done.subject}`,
      commit: done.commit,
      short: done.short,
      turn: turn ?? null,
      plugin: row.id,
    });
    hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
  }
  return saved;
}

/** After a turn of a thread with a plugin list: plugins made in it are linked into layr (again: manifest changes show),
 * and those it changed that bring a Chrome extension are reloaded. */
async function afterPluginsTurn(meta, saved) {
  const changed = new Set(saved.filter((s) => s.done?.commit).map((s) => s.row.id));
  const jobs = [];
  for (const row of engine.requireThread(meta.id).plugins ?? []) {
    if (row.mode !== "change") continue;
    // 0.11.0: a change held back (it needs a core the app doesn't have) isn't what the app runs: nothing to restart.
    if (row.held) continue;
    // 0.12.0: an own copy isn't what the app runs either (unless the person tries it).
    if (row.copy && !row.copy.trying) continue;
    const manifest = changed.has(row.id) ? readManifest(row.folder) : null;
    if (row.place === "made" && (changed.has(row.id) || (row.isNew && !row.linked))) {
      // A plugin of your own is linked again (manifest changes show; its backend restarts with it).
      jobs.push({ id: row.id, run: () => linkRow(meta, row) });
    } else if (manifest?.backend) {
      jobs.push({ id: row.id, run: () => hub.call("layr__plugin_restart", { plugin: row.id }) });
    }
    if (manifest?.extension) await reloadExtension(meta, row.id);
  }
  if (!jobs.length || !hub.available) return;
  const { later } = await restarts.request(jobs);
  if (later.length) {
    const one = later.length === 1;
    const text = `${later.join(" and ")} restart${one ? "s" : ""} with the changes once no thread is running ` +
      `(${one ? "it runs" : "they run"} the threads)`;
    const entry = store.append(meta.id, { type: "system", text });
    hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
  }
}

function linkRow(meta, row) {
  return linkIfReady(hub, row.folder)
    .then((info) => {
      if (!info) return;
      if (row.linked) return;
      const rows = (meta.plugins ?? []).map((r) => (r.id === row.id ? { ...r, linked: true } : r));
      store.updateThread(meta.id, { plugins: rows });
      const entry = store.append(meta.id, { type: "system", text: `${info.name ?? row.name} is in layr now` });
      hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
      hub.notify(`New plugin: ${info.name ?? row.name}`, "success");
      engine.emitThread(meta);
    })
    .catch((error) => {
      log(`linking ${row.folder} failed:`, errorMessage(error));
      const text = `layr couldn't load ${row.name}'s layr.json, so it still runs the last one it could read: ${truncate(
        errorMessage(error), 400)}`;
      const entry = store.append(meta.id, { type: "system", subtype: "link-failed", text });
      hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
    });
}

async function afterPluginTurn(meta) {
  // Your own plugins (and the old plugin maker's threads) are linked again, so manifest changes show; a store
  // plugin's copy (`mine`) and plugins inside a bigger repository are linked already.
  const place = meta.extra?.place ?? "made";
  const info = place === "made" ? await linkPluginFolder(meta) : null;
  const manifest = readManifest(meta.cwd);
  const plugin = manifest?.id ?? info?.id ?? meta.extra?.pluginId;
  if (!manifest?.extension || !plugin) return;
  await reloadExtension(meta, plugin);
}

/** Reloads a plugin's Chrome extension in layr's web panels, and says in the thread what it reported right after. */
async function reloadExtension(meta, plugin) {
  if (!hub.available) return;
  try {
    const before = await hub.call("layr__extension_logs", { plugin, limit: 1 }).catch(() => null);
    await hub.call("layr__extension_reload", { plugin });
    let text = "Reloaded the Chrome extension in layr's web panels";
    // Errors it logged right after the reload (a broken service worker, a load error) are said in the thread.
    if (before) {
      await new Promise((r) => setTimeout(r, Number(process.env.LAYR_CLAUDE_EXTENSION_SETTLE_MS ?? 4000)));
      const after = before.entries?.at(-1)?.seq ?? 0;
      const logs = await hub.call("layr__extension_logs", { plugin, after, level: "error", limit: 5 }).catch(() => null);
      const errors = logs?.entries ?? [];
      if (errors.length) {
        text += `; it reported ${errors.length} error(s): ${errors.map((e) => truncate(e.text.split("\n")[0], 160)).join(" · ")}`;
      } else if (logs && !logs.connected) text += "; it isn't connected to layr (yet)";
    }
    const entry = store.append(meta.id, { type: "system", text });
    hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
  } catch (error) {
    log(`reloading ${plugin}'s extension failed:`, errorMessage(error));
  }
}

async function commitTurn(meta) {
  if (process.env.LAYR_CLAUDE_AUTOCOMMIT === "0" || !meta.cwd) return;
  try {
    const prompt = lastPrompt(store.readTranscript(meta.id));
    // The turn's number in its thread (1-based: the `turn` of its turn_start and turn_end entries).
    const turn = Number.isInteger(meta.turns) && meta.turns > 0 ? meta.turns : undefined;
    const done = await autoCommit(meta.cwd, { prompt, reply: engine.lastReply(meta.id), thread: meta.id, turn });
    if (!done?.commit) return;
    log(`saved ${done.files} file(s) in ${done.top}: ${done.subject}`);
    // 0.3.14: the commit, so the thread panel links it to the plugin page's History.
    const entry = store.append(meta.id, {
      type: "system",
      subtype: "saved",
      text: `Saved as a version: ${done.subject}`,
      commit: done.commit,
      short: done.short,
      turn: turn ?? null,
      plugin: threadPlugin(meta) ?? pluginOfFolder(done.top),
    });
    hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
  } catch (error) {
    log(`saving the changes in ${meta.cwd} failed:`, errorMessage(error));
  }
}

/** The plugins a thread works on: its list (0.7.0), else its target or the plugin folder it runs in. */
function threadPlugins(meta) {
  if (ThreadPlugins.has(meta)) return meta.plugins.map((r) => r.id);
  return threadPlugin(meta) ?? pluginOfFolder(meta.cwd);
}

/** The installed plugin a thread works on (thread_start's target), or null. */
function threadPlugin(meta) {
  return meta.kind === "plugin" ? (meta.extra?.pluginId ?? null) : null;
}

/** An installed plugin's own folder in layr's home (`packages/<id>/mine` or `packages/<id>/merge`, as Plugin care's
 * update threads use): its id; else null. */
function pluginOfFolder(dir) {
  return /[\\/]packages[\\/]([^\\/]+)[\\/](?:mine|merge)[\\/]?$/i.exec(String(dir ?? ""))?.[1] ?? null;
}

function linkPluginFolder(meta) {
  return linkIfReady(hub, meta.cwd)
    .then((info) => {
      if (!info) return null;
      const first = !meta.extra?.linked;
      store.updateThread(meta.id, { extra: { ...(meta.extra ?? {}), linked: true, pluginId: info.id ?? meta.extra?.pluginId } });
      if (first) {
        const entry = store.append(meta.id, { type: "system", text: `The plugin is in layr now: ${info.name ?? info.id ?? meta.cwd}` });
        hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
        hub.notify(`New plugin: ${info.name ?? info.id}`, "success");
      }
      return info;
    })
    .catch((error) => {
      log(`linking ${meta.cwd} failed:`, errorMessage(error));
      // 0.3.16: said in the thread too: layr keeps running the last layr.json it could read, so the turn's manifest
      // changes (new permissions, panels) silently don't apply until it is fixed.
      const text = `layr couldn't load this plugin's layr.json, so it still runs the last one it could read: ${truncate(
        errorMessage(error), 400)}`;
      const entry = store.append(meta.id, { type: "system", subtype: "link-failed", text });
      hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
      hub.notify(`${meta.extra?.pluginId ?? "A plugin"}: layr.json can't be loaded`, "error");
      return null;
    });
}

const server = new McpServer({ name: "threads", version: "0.11.0" }, { capabilities: { tools: {} } });

/** Register a tool whose handler returns a plain object (sent as JSON text and as structured content). */
function tool(name, description, shape, handler) {
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const result = await handler(args ?? {});
      const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
      return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
    } catch (error) {
      return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
    }
  });
}

const permissionMode = z.enum(PERMISSION_MODES).describe(
  "default: ask before edits and commands; acceptEdits: edit files without asking; bypassPermissions: never ask; " +
    "plan: plan first, no changes; dontAsk: never ask, deny what allowedTools doesn't allow (background jobs)",
);
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const images = z
  .array(z.object({ mediaType: z.string().describe("image/png, image/jpeg, image/gif or image/webp"), data: z.string().describe("base64 (a data: URL is fine)") }))
  .describe("Images to send with the text");
const threadId = z.string().describe("Thread id (thread_list)");

// ------------------------------------------------------------------ projects

tool("projects_list", "The project folders Claude threads work in, with their default model, effort and permission " +
  "mode. `kind`: project, or plugin (a plugin's own folder, for threads on a plugin: thread_start's target).", {}, () => ({
  projects: store.projects.map((p) => ({
    ...p,
    kind: p.kind ?? (isPluginsRoot(p.path) ? "plugin" : "project"),
    exists: isDirectory(p.path),
    // 0.4.0: what "Default model" and "Default effort" stand for in its folder (Claude Code's settings).
    claudeDefaults: claudeDefaults(p.path),
    threads: Object.values(store.threads).filter((t) => t.projectId === p.id && !t.archived).length,
  })),
}));

tool(
  "project_add",
  "Add a folder as a project (gives the existing one when the folder is already a project).",
  {
    path: z.string().describe("Absolute folder path"),
    name: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultEffort: effort.optional(),
    defaultPermissionMode: permissionMode.optional(),
  },
  async (a) => {
    const dir = path.resolve(a.path);
    if (!isDirectory(dir)) throw new Error(`No such folder: ${dir}`);
    const project = store.addProject({ ...a, path: dir });
    hub.emit("threads:threads", { kind: "projects" });
    return { project: { ...project, git: await isGitRepo(dir) } };
  },
);

tool(
  "project_update",
  "Rename a project or change its defaults (model, effort, permission mode) for new threads.",
  {
    project: z.string(),
    name: z.string().optional(),
    defaultModel: z.string().nullable().optional(),
    defaultEffort: effort.nullable().optional(),
    defaultPermissionMode: permissionMode.nullable().optional(),
  },
  (a) => {
    const project = store.updateProject(a.project, a);
    hub.emit("threads:threads", { kind: "projects" });
    return { project };
  },
);

tool("project_remove", "Take a project off the list (its folder and threads stay).", { project: z.string() }, (a) => {
  const project = store.removeProject(a.project);
  hub.emit("threads:threads", { kind: "projects" });
  return { removed: project.id };
});

tool("worktrees_list", "The git worktrees of a project, with their branches.", { project: z.string() }, async (a) => {
  const project = engine.resolveProject(a.project);
  if (!(await isGitRepo(project.path))) return { git: false, worktrees: [] };
  return { git: true, worktrees: await listWorktrees(project.path) };
});

// ------------------------------------------------------------------ threads

tool(
  "thread_start",
  "Start a Claude Code thread in a project with a first prompt. Gives the thread (its id for the other tools). " +
    "The turn runs on; follow it with thread_wait or the threads:thread.<id> events.",
  {
    project: z.string().optional().describe("Project id, name or folder (a folder that isn't a project yet is added); not with target"),
    target: z
      .object({
        kind: z.enum(TARGET_KINDS).describe("plugin, or extension (a plugin that brings a Chrome extension); plugins: no " +
          "plugin yet (the list fills as you go)"),
        plugin: z.string().optional().describe("An installed plugin's id (targets_list), on the list allowed to change; a store plugin gets your own copy first. Leave out to make a new one (kind plugins: none)"),
        version: z.string().optional().describe("With plugin: build on that version instead of the one that runs"),
        source: z.string().optional().describe("With version: another publisher's (targets_list sources)"),
        name: z.string().optional().describe("A new one's name"),
        plugins: z
          .array(z.object({ plugin: z.string(), version: z.string().optional(), source: z.string().optional(),
            change: z.boolean().optional().describe("Allowed to change (default: read only)") }))
          .optional()
          .describe("More plugins on the thread's list"),
      })
      .optional()
      .describe("Work on layr plugins instead of a project: the thread runs in an empty folder of its own with a list " +
        "of the plugins it may read and change (0.7.0), and knows how layr plugins work"),
    prompt: z.string(),
    model: z.string().optional().describe("opus, sonnet, haiku, or an id from models_list (default: the project's)"),
    effort: effort.optional(),
    thinking: z.boolean().optional().describe("false turns thinking off"),
    workspace: z
      .union([
        z.enum(["project", "worktree"]),
        z.object({ worktreePath: z.string().optional(), path: z.string().optional() }),
      ])
      .optional()
      .describe('"project" (default): the project folder; "worktree": a new git worktree on a new branch; {worktreePath}: an existing worktree'),
    branch: z.string().optional().describe("Branch name for a new worktree (default layr/<slug of the title>)"),
    baseRef: z.string().optional().describe("Branch or commit a new worktree starts from (default: the project's HEAD)"),
    permissionMode: permissionMode.optional(),
    allowedTools: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Tools allowed without asking (Claude Code rules, e.g. Read, mcp__layr__pipeline__propose); with dontAsk the rest are denied"),
    title: z.string().optional(),
    images: images.optional(),
    plugins: z
      .array(z.object({ plugin: z.string(), version: z.string().optional(), source: z.string().optional(),
        change: z.boolean().optional().describe("Allowed to change (default: read only)") }))
      .optional()
      .describe("With project (0.11.0): the thread also gets a plugin list, of plugins installed in layr it may read " +
        "and change beside the project (an empty list: none yet, mentions and Claude add them); plugins the prompt " +
        "mentions (@id) go on it to read"),
    pluginCopies: z.boolean().optional().describe("With target or plugins: plugins it may change get a copy of their " +
      "own (a plugin worktree; the default, 0.12.1): the app runs them as they were until the changes land " +
      "(thread_plugin_copy). false: it changes them in the app directly (for fixing a plugin that is broken already)"),
  },
  async (a) => {
    if (a.target) return startOnTarget(a);
    if (!a.project) throw new Error("Which project? Give project (projects_list), or a target (targets_list)");
    if (Array.isArray(a.plugins)) return startInProject(a);
    return engine.startThread(a).then((thread) => ({ thread }));
  },
);

/**
 * thread_start with a target (0.7.0): an empty folder of the thread's own, and its plugin list: the plugin it names
 * (allowed to change: made new, or your copy of a store plugin), more from `plugins`, and the ones the prompt mentions
 * (to read). All plugin threads share one project, "Plugin threads".
 */
async function startOnTarget(a) {
  const kind = a.target.kind;
  const rows = [];
  let main = null;
  // 0.12.0: own copies are named after the thread's folder (its id doesn't exist yet).
  const workDir = ensureDir(plugins.workDir());
  const copyName = a.pluginCopies !== false ? copyNameOf({ id: path.basename(workDir) }) : null;
  if (a.target.plugin) {
    main = await plugins.resolve({ plugin: a.target.plugin, version: a.target.version, source: a.target.source,
      mode: "change", copy: copyName });
  } else if (kind !== "plugins") {
    main = await plugins.resolve({
      newPlugin: { id: a.target.id, name: a.target.name, extension: kind === "extension", description: a.prompt }, mode: "change",
    });
  }
  if (main) rows.push(main);
  for (const p of a.target.plugins ?? []) {
    if (rows.some((r) => r.id === p.plugin)) continue;
    rows.push(await plugins.resolve({ plugin: p.plugin, version: p.version, source: p.source, mode: p.change ? "change" : "read",
      copy: p.change ? copyName : null }));
  }
  const known = new Set((await plugins.catalog()).map((t) => t.id));
  for (const m of parseMentions(a.prompt)) {
    if (!known.has(m.id) || rows.some((r) => r.id === m.id)) continue;
    rows.push(await plugins.resolve({ plugin: m.id, version: m.version ?? undefined, mode: "read" }).catch(() => null));
  }
  const project = store.addProject({ path: path.dirname(workDir), name: "Plugin threads", kind: "plugin" });
  hub.emit("threads:threads", { kind: "projects" });
  const isNew = Boolean(main?.isNew);
  const prompt = isNew
    ? `${a.target.name ? `Name: ${a.target.name}\n\n` : ""}Please make this ${main.extension ? "Chrome extension (as a layr plugin)" : "layr plugin"} for me (id "${main.id}", folder ${main.folder}):\n\n${a.prompt}`
    : a.prompt;
  const thread = await engine.startThread({
    ...a,
    project: project.id,
    prompt,
    title: a.title || titleFromPrompt(a.prompt),
    permissionMode: a.permissionMode || (isNew ? "acceptEdits" : undefined),
    workspace: { path: workDir },
    branch: undefined,
    baseRef: undefined,
    kind: "plugin",
    plugins: rows.filter(Boolean),
    ...(copyName ? { copyName } : { pluginCopies: false }),
    extra: { target: "plugins", pluginId: main?.id ?? null, folder: workDir, place: main?.place ?? null, isNew },
  });
  return { thread, folder: main?.folder ?? workDir, pluginId: main?.id ?? null, place: main?.place ?? null, isNew,
    plugins: rows.filter(Boolean).map(publicRow) };
}

/**
 * thread_start in a project with a plugin list (0.11.0): the project is the thread's folder as always, and the plugins
 * installed in layr it may read and change come beside it (`plugins`, and the ones the prompt mentions, to read).
 */
async function startInProject(a) {
  const rows = [];
  // 0.12.1: own copies here too, named before the thread exists.
  const copyName = a.pluginCopies !== false ? copyNameOf({ id: newId("w") }) : null;
  for (const p of a.plugins) {
    if (rows.some((r) => r.id === p.plugin)) continue;
    rows.push(await plugins.resolve({ plugin: p.plugin, version: p.version, source: p.source, mode: p.change ? "change" : "read",
      copy: p.change ? copyName : null }));
  }
  const known = new Set((await plugins.catalog().catch(() => [])).map((t) => t.id));
  for (const m of parseMentions(a.prompt)) {
    if (!known.has(m.id) || rows.some((r) => r.id === m.id)) continue;
    const row = await plugins.resolve({ plugin: m.id, version: m.version ?? undefined, mode: "read" }).catch(() => null);
    if (row) rows.push(row);
  }
  const thread = await engine.startThread({ ...a, plugins: rows, ...(copyName ? { copyName } : { pluginCopies: false }) });
  return { thread, plugins: rows.map(publicRow) };
}

tool(
  "targets_list",
  "What threads can work on besides projects: every installed layr plugin, with `place` (made: yours, its own " +
    "repository; changed: a store plugin with your changes; store: as it came; inside: linked from a bigger " +
    "repository), `extension` (it brings a Chrome extension), its folder and how many threads it has.",
  {},
  async () => {
    const { targets, git, error } = await listTargets(hub);
    const counts = new Map();
    for (const t of Object.values(store.threads)) {
      if (t.kind !== "plugin" || t.archived) continue;
      const id = t.extra?.pluginId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return { targets: targets.map((t) => ({ ...t, threads: counts.get(t.id) ?? 0 })), git, error };
  },
);

tool(
  "thread_send",
  "Send a message to a thread. Idle: starts a turn. While a turn runs: mode queue (default) sends it after the turn, " +
    "mode steer puts it into the running turn now. With agent: to that subagent of the thread (its id), which the " +
    "thread's main agent passes on word for word (SendMessage), in the running turn or a turn of its own.",
  {
    thread: threadId,
    text: z.string(),
    mode: z.enum(["queue", "steer"]).optional(),
    images: images.optional(),
    agent: z.string().optional().describe("A subagent's id (thread_status subagents): the message goes to it"),
  },
  async (a) => {
    // 0.7.0: plugins mentioned in a thread with a plugin list (`@id`) go on it, to read.
    if (!a.agent) await plugins.mentioned(engine.requireThread(a.thread), a.text).catch(() => []);
    return engine.send(a.thread, { text: a.text, images: a.images, mode: a.mode, agent: a.agent });
  },
);

tool(
  "thread_subagent",
  "A subagent's conversation as Claude Code keeps it (for panels: one from before layr kept subagents' text): " +
    "{agent, entries}, entries as thread_transcript gives them, under the subagent's Agent call.",
  { thread: threadId, agent: z.string().describe("The subagent's id") },
  (a) => engine.subagentTranscript(a.thread, a.agent),
);

tool("thread_interrupt", "Stop the thread's running turn (the session stays; queued messages wait).", { thread: threadId }, (a) =>
  engine.interrupt(a.thread),
);

tool(
  "thread_retry",
  "Try again: send the thread's last message once more, in the same session (after a turn failed or was stopped).",
  { thread: threadId },
  (a) => engine.retry(a.thread),
);

tool(
  "thread_restore_workspace",
  "0.3.12: make a worktree thread's removed folder (folderGone in its summary) again now, in the same folder, as its " +
    "next turn would (from the newest base; its branch when that has work the base lacks); Claude is told with the " +
    "next message. Refused for a folder that isn't a worktree. Gives {restored, thread}.",
  { thread: threadId },
  (a) => engine.restoreNow(a.thread),
);

tool(
  "thread_go_back",
  "Go back to just before one of the user's messages (its transcript `seq`; one that started a turn): it and " +
    "everything after it leave the chat and Claude's memory (the session forks from the entry before it). Files are " +
    "not changed back. Not while the thread runs. Gives the message's text and images, to send again or change.",
  { thread: threadId, seq: z.number().int() },
  (a) => engine.goBack(a.thread, a.seq),
);

tool(
  "thread_list",
  "Threads, latest activity first, with status: running, waiting (for an approval or answer), done, failed, interrupted.",
  {
    project: z.string().optional(),
    plugin: z
      .string()
      .optional()
      .describe("Only threads on this installed plugin (its id): thread_start's target, or its folder in layr's home"),
    limit: z.number().int().min(1).max(500).optional(),
    archived: z.union([z.boolean(), z.literal("all")]).optional(),
    query: z.string().optional().describe("Words in the title, last message or branch"),
  },
  (a) => ({ threads: engine.list({ ...a, pluginOf: (t) => threadPlugins(t) }) }),
);

tool(
  "thread_read",
  "A thread's conversation, compact: user and assistant messages, tool calls in one line each. Oldest first.",
  {
    thread: threadId,
    limit: z.number().int().min(1).max(500).optional().describe("Messages at most (default 40, the newest)"),
    before: z.number().int().optional().describe("Only entries before this seq (to page back)"),
  },
  (a) => {
    const meta = engine.requireThread(a.thread);
    const page = store.readPage(a.thread, { limit: 5000, before: a.before });
    const messages = compact(page.entries);
    const limit = a.limit ?? 40;
    return {
      thread: engine.summary(meta),
      messages: messages.slice(-limit),
      more: page.more || messages.length > limit,
    };
  },
);

tool(
  "thread_transcript",
  "A thread's full transcript entries (for panels): the newest `limit`, or those before/after a seq.",
  {
    thread: threadId,
    limit: z.number().int().min(1).max(5000).optional(),
    before: z.number().int().optional(),
    after: z.number().int().optional(),
  },
  (a) => {
    const meta = engine.requireThread(a.thread);
    const page = store.readPage(a.thread, { limit: a.limit ?? 1500, before: a.before, after: a.after });
    const live = engine.lives.get(a.thread);
    const pending = live ? [...live.approvals.keys()] : [];
    return { thread: engine.summary(meta), entries: page.entries, more: page.more, pending };
  },
);

tool(
  "thread_wait",
  "Wait until the thread's turn ends or it needs the user (an approval or question), at most timeoutSec. " +
    "Gives its status and last reply.",
  { thread: threadId, timeoutSec: z.number().min(1).max(3600).optional() },
  (a) => engine.wait(a.thread, a.timeoutSec ?? 120),
);

tool("thread_status", "One thread's state: status, workspace and branch, model, pending approvals, queue, todos, cost, " +
  "background tasks still running (subagents, background shells, monitors).", { thread: threadId }, async (a) => {
  const meta = engine.requireThread(a.thread);
  const summary = engine.summary(meta);
  const live = engine.lives.get(a.thread);
  const approvals = live ? [...live.approvals.entries()].map(([requestId, p]) => ({ requestId, ...p.entry })) : [];
  let git = null;
  if (meta.workspace?.branch !== undefined && isDirectory(meta.cwd) && (await isGitRepo(meta.cwd))) {
    git = await worktreeStatus(meta.cwd, meta.workspace.base).catch(() => null);
  }
  return { thread: summary, approvals, git };
});

tool(
  "thread_changes",
  "What a thread changed where it works, against its base branch: lines added and removed, files (committed, " +
    "uncommitted, new), the branch's commits, how far the base moved on (behind) and files that would conflict. " +
    "Gives {changes}, null when its folder isn't a git checkout.",
  { thread: threadId },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    if (!isDirectory(meta.cwd)) return { changes: null };
    return { changes: await threadChanges(meta.cwd, { hint: meta.workspace?.base }) };
  },
);

tool(
  "thread_diff",
  "One file's changes in a thread's folder as a unified diff, from where its branch left the base (or the last " +
    "commit) to the file on disk. `file`: a path from thread_changes.",
  { thread: threadId, file: z.string() },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    return { file: a.file, diff: await fileDiff(meta.cwd, a.file, { hint: meta.workspace?.base }) };
  },
);

tool(
  "thread_commands",
  "Claude Code's slash commands in a thread's folder (send one as the message text, e.g. /compact), as Claude Code " +
    "last listed them: [{name, description, argumentHint}]; before its first turn only the built-in ones.",
  { thread: threadId },
  (a) => {
    const meta = engine.requireThread(a.thread);
    const known = engine.commandsFor(meta) ?? [];
    const names = new Set(known.map((c) => c.name));
    return { commands: [...known, ...BUILTIN_COMMANDS.filter((c) => !names.has(c.name))], known: known.length > 0 };
  },
);

tool(
  "run_in_terminal",
  "Open a new terminal window on this PC running a command, in the thread's folder (else the home folder): the ▶ " +
    "Run of a reply's command block. `at`: when it was clicked (ms); an older click than a minute doesn't run.",
  {
    thread: threadId.optional(),
    shell: z.enum(["powershell", "cmd", "bash"]),
    command: z.string().min(1).max(100_000),
    at: z.number(),
  },
  async (a) => {
    checkFresh(a.at);
    const meta = a.thread ? engine.requireThread(a.thread) : null;
    const cwd = meta && isDirectory(meta.cwd) ? meta.cwd : os.homedir();
    await openTerminal(cwd, a.shell, a.command);
    return { opened: true, cwd };
  },
);

tool(
  "open_folder",
  "Open a thread's folder on this PC in VS Code or the file manager (`explorer`: File Explorer, Finder, or what " +
    "xdg-open picks). `at`: when it was clicked (ms).",
  { thread: threadId, app: z.enum(["vscode", "explorer"]), at: z.number() },
  async (a) => {
    checkFresh(a.at);
    const meta = engine.requireThread(a.thread);
    await openFolder(meta.cwd, a.app);
    return { opened: true, folder: meta.cwd };
  },
);

tool(
  "thread_update",
  "Change a thread's title, model, effort, thinking, permission mode or skills (a running session switches model and mode at once).",
  {
    thread: threadId,
    title: z.string().optional(),
    model: z.string().nullable().optional(),
    effort: effort.nullable().optional(),
    thinking: z.boolean().optional(),
    permissionMode: permissionMode.optional(),
    skillsOff: z.array(z.string()).max(500).optional()
      .describe("0.13.0: layr skills (<plugin>/<skill>) switched off for this thread only; applies from its next turn"),
  },
  (a) => engine.update(a.thread, a).then((thread) => ({ thread })),
);

tool(
  "thread_skills",
  "0.13.0: the layr skills that are on (Settings > Skills), and whether this thread gets each: {skills: [{id, name, description, plugin, here}]}.",
  { thread: threadId },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    const off = new Set(meta.skillsOff ?? []);
    const skills = await engine.skills.list();
    return { skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description, plugin: s.plugin, here: !off.has(s.id) })) };
  },
);

tool("thread_archive", "Archive a thread (stops it), or bring it back with archived: false.", { thread: threadId, archived: z.boolean().optional() }, (a) => ({
  thread: engine.archive(a.thread, a.archived !== false),
}));

tool(
  "thread_queue",
  "Messages queued for after the running turn: remove one, steer one in now, or resume a queue paused by a stop.",
  { thread: threadId, action: z.enum(["remove", "steer", "resume"]), item: z.string().optional().describe("Queued message id") },
  (a) => engine.queueAction(a.thread, a).then((thread) => ({ thread })),
);

// ------------------------------------------------------------------ plugins in a thread (0.7.0)

const pluginId = z.string().describe("An installed plugin's id (targets_list)");

tool(
  "thread_plugins",
  "A thread's plugin list (threads that change plugins): {plugins: [{id, name, mode: read | change, version, source, " +
    "place, folder, extension, isNew, by, held}], allowAll}; null for other threads.",
  { thread: threadId },
  (a) => {
    const meta = engine.requireThread(a.thread);
    return { plugins: ThreadPlugins.has(meta) ? meta.plugins.map(publicRow) : null, allowAll: Boolean(meta.allowAllPlugins) };
  },
);

tool(
  "thread_plugin_add",
  "Put a plugin on a thread's list: mode read (default) or change (a store plugin gets your own copy first); version " +
    "(and source): read or build on that version; new: make a new plugin, allowed to change. Claude is told with the " +
    "next message.",
  {
    thread: threadId,
    plugin: pluginId.optional(),
    mode: z.enum(["read", "change"]).optional(),
    version: z.string().optional(),
    source: z.string().optional(),
    new: z.object({ name: z.string().optional(), extension: z.boolean().optional() }).optional(),
  },
  async (a) => {
    if (!a.plugin && !a.new) throw new Error("Which plugin? Give plugin, or new");
    const meta = engine.requireThread(a.thread);
    const row = await plugins.add(meta, { plugin: a.plugin, mode: a.new ? "change" : a.mode ?? "read", version: a.version,
      source: a.source, newPlugin: a.new ? { ...a.new } : null });
    return { plugin: row, thread: engine.summary(meta) };
  },
);

tool(
  "thread_plugin_set",
  "Change a plugin on a thread's list: mode read or change, or remove: true to take it off. allowAll: true lets Claude " +
    "change any plugin it asks for in this thread without asking (false asks again). held: false runs the plugin's " +
    "held-back changes (a thread in a project).",
  {
    thread: threadId,
    plugin: pluginId.optional(),
    mode: z.enum(["read", "change"]).optional(),
    remove: z.boolean().optional(),
    allowAll: z.boolean().optional(),
    held: z.literal(false).optional().describe("false: the app runs the plugin's held-back changes now (0.11.0)"),
  },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    if (a.plugin && a.held === false) await plugins.release(meta, a.plugin);
    if (a.allowAll !== undefined) {
      store.updateThread(meta.id, { allowAllPlugins: a.allowAll });
      engine.emitThread(meta);
    }
    if (a.plugin && a.remove) plugins.remove(meta, a.plugin);
    else if (a.plugin && a.mode) await plugins.setMode(meta, a.plugin, a.mode);
    return { thread: engine.summary(meta) };
  },
);

tool(
  "thread_plugin_copy",
  "A thread's own copies of plugins (0.12.0, plugin worktrees): land (its changes go into the plugin the app runs; a " +
    "clash leaves conflicts in the copy for Claude to resolve, then land again), drop (thrown away), try (the app runs " +
    "the copy until untry, land or drop), status (what each copy holds that isn't in the app: {plugin, ahead, dirty, " +
    "conflicts}). A copy with nothing new gives {nothing: true} on land. plugin: one (default: every copy; try needs one). reopen: false: no fresh copy " +
    "after land / drop (a task that ends). Gives {results}.",
  {
    thread: threadId,
    plugin: pluginId.optional(),
    action: z.enum(["land", "drop", "try", "untry", "status"]),
    reopen: z.boolean().optional(),
  },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    if ((a.action === "land" || a.action === "drop") && engine.isTurnActive(meta.id)) {
      throw new Error("Wait until the thread's turn ends");
    }
    let results;
    if (a.action === "status") {
      results = await plugins.copyStatus(plugins.copies(meta, a.plugin));
      return { results };
    }
    if (a.action === "try" || a.action === "untry") {
      if (!a.plugin) throw new Error("Which plugin to try? Give plugin");
      results = [await plugins.tryCopy(meta, a.plugin, a.action === "try")];
    } else {
      const reopen = a.reopen !== false;
      results = a.action === "land" ? await plugins.land(meta, a.plugin, { reopen }) : await plugins.drop(meta, a.plugin, { reopen });
      const said = results.map((r) => r.nothing
        ? `${r.plugin}: nothing new to land`
        : r.landed === false
        ? `${r.plugin}: clashes in ${r.conflicts.join(", ")} (Claude resolves them, then land again)`
        : `${r.plugin}: ${a.action === "land" ? "landed" : "thrown away"}`);
      const entry = store.append(meta.id, { type: "system", subtype: `copy-${a.action}`, text: said.join("; ") });
      hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
      for (const r of results) if (r.landed && r.extension) await reloadExtension(meta, r.plugin);
    }
    return { results, thread: engine.summary(engine.requireThread(meta.id)) };
  },
);

tool(
  "thread_take_back",
  "Take back what a thread changed in a plugin (or in every plugin it may change): its commits undone, newest first, " +
    "each as a new commit (other threads' changes in between stay). Stops at a commit later changes conflict with. " +
    "Gives {results: [{plugin, undone, of, error?}]}.",
  { thread: threadId, plugin: pluginId.optional() },
  async (a) => {
    const meta = engine.requireThread(a.thread);
    if (engine.isTurnActive(meta.id)) throw new Error("Wait until the thread's turn ends");
    const results = await plugins.takeBack(meta, a.plugin);
    const said = results.map((r) => `${r.plugin}: ${r.undone} of ${r.of ?? 0} taken back${r.error ? ` (stopped: ${r.error})` : ""}`);
    const entry = store.append(meta.id, { type: "system", subtype: "taken-back", text: `Took back this thread's changes: ${said.join("; ")}` });
    hub.emit(`threads:thread.${meta.id}`, { kind: "entry", entry });
    const note = `The person took back what this thread changed (${said.join("; ")}): the files are as they were before.`;
    store.updateThread(meta.id, { pluginsNote: meta.pluginsNote ? `${meta.pluginsNote}\n${note}` : note });
    for (const r of results) {
      const row = meta.plugins.find((x) => x.id === r.plugin);
      if (r.undone && row && readManifest(row.folder)?.extension) await reloadExtension(meta, row.id);
    }
    return { results };
  },
);

tool(
  "answer_approval",
  "Answer what a thread waits for: a permission request (allow, allow_always for this thread, deny with a message), " +
    "a question (answers: {question text: option label, or labels}), or a plan (allow to go ahead, deny with feedback).",
  {
    thread: threadId,
    requestId: z.string(),
    decision: z.enum(["allow", "allow_always", "deny"]),
    message: z.string().optional().describe("Why, for deny: Claude reads it"),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  },
  (a) => engine.answerApproval(a.thread, a),
);

tool("approvals_list", "Everything threads are waiting on the user for, across all threads.", {}, () => {
  const approvals = [];
  for (const [id, live] of engine.lives) {
    const meta = store.thread(id);
    for (const [requestId, p] of live.approvals) approvals.push({ thread: id, threadTitle: meta?.title, requestId, ...p.entry });
  }
  return { approvals };
});

tool("attachment_read", "An image pasted into a thread, as image content.", { thread: threadId, name: z.string() }, async (a) => {
  const data = store.readAttachment(a.thread, a.name);
  const ext = path.extname(a.name).slice(1);
  return { mediaType: `image/${ext === "jpg" ? "jpeg" : ext}`, data: data.toString("base64") };
});

// ------------------------------------------------------------------ account

tool("models_list", "The models Claude Code offers on this PC, with their effort levels.", {}, async () => ({
  models: await account.listModels(),
  error: account.error,
}));

tool("usage", "The Claude account's plan usage (5-hour and weekly windows) and who is signed in.", { refresh: z.boolean().optional() }, (a) =>
  account.usage({ refresh: a.refresh === true }),
);

tool(
  "ask",
  "One question, one answer: a single Claude turn with no tools, no saved thread and no project files (no CLAUDE.md), " +
    `for small background jobs (a brief, a summary, a classification). Model ${ASK_DEFAULT_MODEL} unless given. Gives {text}.`,
  {
    prompt: z.string().min(1),
    system: z.string().optional().describe("A system prompt (instead of Claude Code's)"),
    model: z.string().optional().describe(`opus, sonnet, haiku or an id (default ${ASK_DEFAULT_MODEL})`),
    effort: effort.optional(),
  },
  (a) => ask(a, { beforeRetry: () => engine.repairConfig() }),
);

// ------------------------------------------------------------------ plugin maker

tool(
  "plugin_make",
  "Make a layr plugin with AI from a plain-words description: starts a thread in a new folder of the plugin's own " +
    "(plugins_folder says where) that writes it and links it into layr. Gives the thread and the folder. " +
    "(thread_start with target {kind: plugin} does the same and more.)",
  {
    description: z.string().describe("What the plugin should do, in plain words"),
    name: z.string().optional(),
    id: z.string().optional(),
    model: z.string().optional(),
    permissionMode: permissionMode.optional().describe("Default acceptEdits: files without asking, commands ask"),
    images: images.optional(),
  },
  async (a) => {
    const r = await startOnTarget({
      target: { kind: "plugin", name: a.name, id: a.id },
      prompt: a.description,
      images: a.images,
      model: a.model,
      permissionMode: a.permissionMode,
      title: `Plugin: ${a.name || truncate(a.description, 40)}`,
    });
    return { thread: r.thread, folder: r.folder, pluginId: r.pluginId };
  },
);

tool(
  "plugins_folder",
  "Where new plugins made with AI go. On a layr with one folder for each plugin (`layout: 2`): `folder` is layr's " +
    "packages folder and a plugin's own folder is `<folder>/<id>/mine` (`plugin`, with <id> to fill in); " +
    "`oldFolder`: where they were before, and where unfinished ones may still be. On an older layr: {folder}, a " +
    "plugin is `<folder>/<id>`.",
  {},
  () => {
    const packages = packagesRoot();
    if (!packages) return { folder: ensureDir(oldPluginsRoot()) };
    return { folder: packages, layout: 2, plugin: path.join(packages, "<id>", "mine"), oldFolder: oldPluginsRoot() };
  },
);

// ------------------------------------------------------------------ build times

tool(
  "build_times",
  "How long the builds, tests and checks Claude threads ran took (cargo, flutter, npm test, tsc, build scripts...), " +
    "per project: each kind's runs, total, median and longest time, failures, timeouts, first runs in a folder " +
    "(cold builds) apart from later ones; time per day; the threads that waited longest; the latest runs.",
  {
    project: z.string().optional().describe("A project's id or name (default: every project)"),
    days: z.number().positive().optional().describe("Only the last so many days (default: all)"),
    kind: z.string().optional().describe('Only one kind, e.g. "cargo test"'),
  },
  (a) => buildTimes.summary(a),
);

tool(
  "build_times_import",
  "Read past build and check runs from Claude Code's transcripts on this PC (only files that changed since the " +
    "last time; all of them with all: true). Never changes the transcripts. Gives {files, added}.",
  { all: z.boolean().optional() },
  (a) => buildTimes.importTranscripts(undefined, { force: a.all === true }),
);

// ------------------------------------------------------------------ helpers

/** Transcript entries as short messages for agents. */
function compact(entries) {
  const out = [];
  const tools = new Map();
  for (const e of entries) {
    if (e.parent) continue;
    if (e.type === "user" && e.auto === "restart") {
      out.push({ seq: e.seq, role: "system", text: "layr picked the turn up again after the Claude engine restarted" });
    } else if (e.type === "user") {
      const to = e.relay ? `[to subagent ${e.relay.description || e.relay.agent}] ` : "";
      out.push({ seq: e.seq, role: "user", text: to + e.text + (e.images?.length ? ` [${e.images.length} image(s)]` : "") });
    }
    else if (e.type === "text") out.push({ seq: e.seq, role: "assistant", text: e.text });
    else if (e.type === "tool_use") {
      const m = { seq: e.seq, role: "tool", text: `${e.name} ${toolSummary(e.name, e.input)}`.trim() };
      tools.set(e.id, m);
      out.push(m);
    } else if (e.type === "tool_result") {
      const m = tools.get(e.id);
      if (m && e.isError) m.text += ` → error: ${truncate(e.content, 300)}`;
    } else if (e.type === "approval") out.push({ seq: e.seq, role: "approval", requestId: e.requestId, text: `${e.kind}: ${e.tool} ${toolSummary(e.tool, e.input)}` });
    else if (e.type === "approval_answer") out.push({ seq: e.seq, role: "approval", requestId: e.requestId, text: `answered: ${e.decision}${e.message ? ` (${e.message})` : ""}` });
    else if (e.type === "turn_end") out.push({ seq: e.seq, role: "system", text: `turn ${e.turn} ${e.status}${e.error ? `: ${e.error}` : ""}` });
    else if (e.type === "error") out.push({ seq: e.seq, role: "system", text: `error: ${e.message}` });
  }
  return out;
}

export function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  if (typeof v === "string") return truncate(v.replace(/\s+/g, " "), 160);
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return truncate(JSON.stringify(input), 160);
}

// ------------------------------------------------------------------ start

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`threads backend up (data ${dataDir}, hub ${hub.available ? "on" : "off"})`);
  // Learn the models in the background, so the first thread start doesn't wait for it.
  setTimeout(() => void account.listModels().catch(() => {}), 2000).unref?.();
  account.watch();
  // Turns the last backend was running when it stopped go on (Engine.recover): after a moment, so the hub is there
  // and a Claude Code process of the old backend still closing is gone.
  const delay = Number(process.env.LAYR_CLAUDE_RESUME_DELAY_MS ?? 3000);
  const resume = () => engine.resumeAfterRestart().catch((error) => log("picking turns up again:", errorMessage(error)));
  setTimeout(() => void resume(), delay);
  // Past threads' build times, once: from Claude Code's transcripts (the panel can read them again).
  if (!buildTimes.importState() && process.env.LAYR_CLAUDE_BUILD_IMPORT !== "0") {
    const started = () =>
      buildTimes.importTranscripts().then(
        (r) => log(`build times: ${r.added} past runs from ${r.files} transcripts`),
        (error) => log("build times import:", errorMessage(error)),
      );
    setTimeout(() => void started(), 30_000).unref?.();
  }
}

let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    await engine.shutdown();
    await hub.close();
  } finally {
    process.exit(code);
  }
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.stdin.on("end", () => void stop(0));
process.stdin.on("close", () => void stop(0));
process.on("uncaughtException", (error) => log("uncaught:", error));
process.on("unhandledRejection", (error) => log("unhandled rejection:", error));

main().catch((error) => {
  log("could not start:", error);
  process.exit(1);
});
