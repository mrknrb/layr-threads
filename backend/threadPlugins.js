// Plugins in a thread (0.7.0; docs/ARCHITECTURE.md › The claude plugin › Plugins in a thread). A thread that changes
// layr plugins starts in an empty folder of its own and keeps a list: the plugins it may read, and the ones it may
// change. You add one by mentioning it (`@youtube`, `@pipeline@0.10.2`): Claude may read it. Claude adds one to read
// by itself (`plugin_add`), and asks before changing one (`plugin_change`: a card you answer, Allow or Refuse).
// - Only plugins allowed to change can be written: a PreToolUse hook refuses Claude's file edits anywhere else in
//   layr's home and in other plugins' folders, in every permission mode, and shell commands that name such a folder
//   or a plugin's history (read as text, like the kill guard: the careless cases, not a determined workaround).
// - One thread writes a plugin at a time: the first write in a turn holds it until that turn ends.
// - After every turn each changed plugin gets its commit (autoCommit.js, with the thread's trailers); "take back"
//   undoes this thread's commits in a plugin, newest first, leaving other threads' changes in between.
import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { autoCommit, initPluginRepo } from "./autoCommit.js";
import { newPluginFolder, packagesRoot } from "./pluginMaker.js";
import { listTargets, readManifest, scaffoldExtension, targetSystemPrompt } from "./targets.js";
import { errorMessage, log, newId, nowIso, truncate } from "./util.js";

export const PLUGIN_MODES = ["read", "change"];
/** The in-thread tools' server name: Claude sees them as mcp__thread__<tool>. */
export const THREAD_SERVER = "thread";
const FILE_TOOLS = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const READ_TOOLS = { Read: "file_path", Glob: "path", Grep: "path", LS: "path" };
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const GUARDED = "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell";

// ------------------------------------------------------------------ pure helpers

/**
 * The plugins a message mentions: `@id` and `@id@1.2.3` ({id, version}). Not e-mail addresses (a word character
 * right before the @), not a trailing full stop.
 */
export function parseMentions(text) {
  const out = [];
  const re = /(^|[^\w@./\\-])@([a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*)(?:@(\d+\.\d+\.\d+(?:-[0-9a-z.-]*[0-9a-z])?))?/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const id = m[2].toLowerCase();
    if (!out.some((x) => x.id === id && x.version === (m[3] ?? null))) out.push({ id, version: m[3] ?? null });
  }
  return out;
}

/** Is `child` the folder `parent` or inside it (case-insensitive on Windows)? */
export function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(String(parent)), path.resolve(String(child)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A path as text to look for in a shell command: forward slashes, lower case, no trailing slash. */
function pathText(p) {
  return path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Does the path go into a plugin's history (a `.git` folder or file, `history.git`, `repo.git`)? */
function intoHistory(target) {
  return path.resolve(target).split(/[\\/]+/).some((seg) => /\.git$/i.test(seg));
}

/** The row of the thread's list whose folder holds `target` (the deepest one). */
function rowFor(rows, target) {
  let best = null;
  for (const r of rows ?? []) {
    if (r.folder && isInside(target, r.folder) && (!best || r.folder.length > best.folder.length)) best = r;
  }
  return best;
}

/**
 * Why a tool call may not run in a thread with a plugin list, or null when it may. `ctx`: {cwd, rows, home,
 * packages, installed: [{id, path}], allowed: [folders of the thread's own], claim(row): reason or null}.
 */
export function guardDecision(toolName, input, ctx) {
  const rows = ctx.rows ?? [];
  if (FILE_TOOLS[toolName]) {
    const p = input?.[FILE_TOOLS[toolName]];
    if (!p) return null;
    const target = path.resolve(ctx.cwd ?? ".", String(p));
    if (intoHistory(target) && (rowFor(rows, target) || (ctx.packages && isInside(target, ctx.packages)))) {
      return "layr keeps the plugins' history itself (a commit after every turn): don't change it.";
    }
    if ((ctx.allowed ?? []).some((d) => isInside(target, d))) return null;
    const row = rowFor(rows, target);
    if (row) {
      if (row.mode === "change") return ctx.claim?.(row) ?? null;
      return `You may only read ${row.name} (${row.id}) in this thread. To change it, ask with ` +
        `mcp__${THREAD_SERVER}__plugin_change { "plugin": "${row.id}", "why": "..." }: the person decides.`;
    }
    const owner = (ctx.installed ?? []).find((i) => i.path && isInside(target, i.path));
    const inPackages = ctx.packages && isInside(target, ctx.packages);
    if (owner || inPackages) {
      const id = owner?.id ?? path.relative(ctx.packages, target).split(/[\\/]/)[0];
      return `${id} isn't among this thread's plugins. Add it with mcp__${THREAD_SERVER}__plugin_add (to read it) ` +
        `or ask to change it with mcp__${THREAD_SERVER}__plugin_change.`;
    }
    if (ctx.home && isInside(target, ctx.home)) {
      return "That is layr's own data (its home): a thread only changes the plugins allowed in it.";
    }
    return null;
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = String(input?.command ?? "");
    const text = command.replace(/\\\\/g, "/").replace(/\\/g, "/").toLowerCase();
    // A thread in a project (0.11.0) runs git in its own repository: there only git aimed at layr's home is refused.
    const aimsAtPlugins = !ctx.project || (ctx.packages && text.includes(pathText(ctx.packages))) ||
      rows.some((r) => r.folder && text.includes(pathText(r.folder)));
    if (/history\.git|repo\.git/.test(text) ||
      (aimsAtPlugins && /\bgit_dir\b|\bgit_work_tree\b|--git-dir|--work-tree/.test(text))) {
      return "layr keeps the plugins' history itself (a commit after every turn): don't run git on it.";
    }
    const writable = rows.filter((r) => r.mode === "change");
    const mayTouch = (folder) => writable.some((r) => isInside(folder, r.folder));
    if (ctx.packages) {
      const root = pathText(ctx.packages);
      let at = text.indexOf(root);
      while (at >= 0) {
        const id = text.slice(at + root.length).match(/^\/([^/\s"'`;|&)]+)/)?.[1];
        if (id && !mayTouch(path.join(ctx.packages, id, "mine")) && !mayTouch(path.join(ctx.packages, id, "merge"))) {
          return `That command names ${id}'s folder, which this thread may not change. Read plugins with Read, ` +
            `Glob and Grep; to change one, ask with mcp__${THREAD_SERVER}__plugin_change.`;
        }
        at = text.indexOf(root, at + root.length);
      }
    }
    for (const i of ctx.installed ?? []) {
      if (!i.path || (ctx.packages && isInside(i.path, ctx.packages)) || mayTouch(i.path)) continue;
      if (text.includes(pathText(i.path))) {
        return `That command names ${i.id}'s folder, which this thread may not change. Read it with Read, Glob and ` +
          `Grep; to change it, ask with mcp__${THREAD_SERVER}__plugin_change.`;
      }
    }
    return null;
  }
  return null;
}

/** A row as threads and panels see it. */
export function publicRow(r) {
  return {
    id: r.id, name: r.name, mode: r.mode, version: r.version ?? null, source: r.source ?? null, place: r.place ?? null,
    folder: r.folder ?? null, extension: Boolean(r.extension), isNew: Boolean(r.isNew), by: r.by ?? "you",
    at: r.at ?? null,
    // 0.11.0: a change held back until the app has the core it needs (Plugins in a project thread).
    held: r.held ? { version: r.held.version ?? null, why: r.held.why ?? null, at: r.held.at ?? null } : null,
  };
}

/** The part of the system prompt that says how a thread with a plugin list works. */
export function pluginsPrompt({ rows, workDir, hubUrl, project = false }) {
  const list = rows.length
    ? rows.map((r) => `- ${r.name} (id "${r.id}"${r.version ? `, version ${r.version}` : ""}): ` +
      `${r.mode === "change" ? "you may change it" : "read only"}${r.held ? `, held back (the app runs ${r.held.version})` : ""}` +
      `; folder ${r.folder}`).join("\n")
    : "- (none yet)";
  if (project) return projectPluginsPrompt({ list, workDir });
  return `# Changing layr plugins
layr is an app that is an empty frame of panels where every feature is a plugin. In this thread you change the
person's layr plugins. The person you are helping may not program at all: talk in plain words, make decisions
yourself, and only ask about what they want, not how to build it.

## Which plugins: the thread's list
This thread works in an empty folder of its own (${workDir}); the plugins are elsewhere, and you work on them through
the thread's list. Right now:
${list}

- The person adds a plugin by mentioning it (\`@id\`, or \`@id@1.2.3\` for a version): you may read it.
- To read one that isn't on the list: \`mcp__${THREAD_SERVER}__plugin_add\` { "plugin": "<id>" } (no need to ask). Not
  sure which plugin they mean (two similar ones)? \`mcp__${THREAD_SERVER}__plugin_find\` { "query": "..." } lists the
  installed plugins that match: if more than one could be meant, ask the person which.
- To change one: \`mcp__${THREAD_SERVER}__plugin_change\` { "plugin": "<id>", "why": "<what you want to change, in
  plain words>" }. The person decides; wait for the answer and only then change it. "version" (and "source") builds
  on that version instead of the one that runs. A new plugin: { "new": { "name": "...", "extension"?: true } }.
- \`mcp__${THREAD_SERVER}__plugins_in_thread\` gives the list as it is now (the person can change it at any time).
- You can only change files in the folders of plugins you may change. Everything else in layr's home and in other
  plugins' folders is refused.

## History: layr's, not yours
Each plugin's folder holds only its files: its git history is kept by layr, out of your reach (git in a plugin's
folder says "not a git repository"). Don't run git on plugins and don't try to find their history. After each of
your turns layr saves what changed in each plugin as a version, and the person can undo any of it, or everything
this thread changed. To see what you changed, or a plugin's earlier versions: \`mcp__layr__layr__plugin_diff\` and
\`mcp__layr__layr__plugin_history\` { "plugin": "<id>" }.

## Plugins
${targetSystemPrompt({ id: "<id>", extension: rows.some((r) => r.extension), hubUrl, guideOnly: true })}

## When you are done
Say in two or three plain sentences what changed in which plugin and how to see it (panels show changes when opened
again). A new plugin is linked into layr by itself when your turn ends.`;
}

/**
 * The prompt of a thread in a project that also changes installed plugins (0.11.0): the project is its folder (a
 * worktree of layr's source, as a rule), the plugins live in the app (layr's home) and run there.
 */
function projectPluginsPrompt({ list, workDir }) {
  return `# Installed layr plugins in this thread
Besides this project (${workDir}), this thread can change the layr plugins installed in the layr app the person runs.
Their source is not in this folder: each plugin's files are its folder in layr's home, which the app runs from, so a
plugin change goes live in the person's app when your turn ends. The project's own files work as always.

## Which plugins: the thread's list
${list}

- The person adds a plugin by mentioning it (\`@id\`): you may read it. Read one that isn't on the list with
  \`mcp__${THREAD_SERVER}__plugin_add\` { "plugin": "<id>" }; \`mcp__${THREAD_SERVER}__plugin_find\` finds the one meant.
- To change one: \`mcp__${THREAD_SERVER}__plugin_change\` { "plugin": "<id>", "why": "<in plain words>" }, and wait for the
  answer. A new plugin: { "new": { "name": "..." } }. Write plugins only in their folders on the list, never into this
  project's \`plugins/\` folder (a plugin there that has moved to its own repository is gone from it).
- A plugin's history is layr's: don't run git in a plugin's folder. After each turn layr saves each changed plugin as
  a version (the person can take back everything this thread changed), and restarts the ones with a backend (the
  claude and pipeline plugins only once no thread is running, as they run the threads).

## A plugin change that needs this project's core
The app runs the published layr core, not this worktree's. When a plugin change calls something only this project's
unpublished core has (a new JSON-RPC method, hub tool, manifest field or panel SDK function), the person's app would
break. Then, right after changing it, call \`mcp__${THREAD_SERVER}__plugin_hold\` { "plugin": "<id>", "why": "<what it
needs>" }: the app goes on running the plugin's released version, your changes stay saved in its folder, and the
person switches them on once the app version with the new core is installed. A change that works with the published
core (or checks for the new ability first) needs no hold.

## When you are done
Say what changed in this project and in which plugins, and which plugin changes are held back.`;
}

// ------------------------------------------------------------------ the thread's list, its tools and its guard

/** Which thread holds which plugin for writing: the first write in a turn, until that turn ends. */
export class WriteLocks {
  constructor() {
    this.holders = new Map();
  }

  /** Null when `thread` may write `plugin` now (it holds it from now on), else the thread that holds it. */
  claim(plugin, thread, isActive) {
    const holder = this.holders.get(plugin);
    if (holder && holder !== thread && isActive(holder)) return holder;
    this.holders.set(plugin, thread);
    return null;
  }

  release(thread) {
    for (const [plugin, holder] of this.holders) if (holder === thread) this.holders.delete(plugin);
  }
}

/** Plugins that run the threads themselves: restarting them cuts off running turns, so they wait (0.11.0). */
export const RUN_THREADS = ["claude", "pipeline"];

/**
 * Restarts of the plugins a turn changed (their panels show changes when opened again; a backend needs a restart, a
 * plugin of your own is linked again). The plugins that run threads (RUN_THREADS) are restarted only once no thread
 * has a turn running, claude last (it is this backend: its restart ends this process, and the threads go on after it
 * as after any restart).
 */
export class PluginRestarts {
  /** `busy()`: is any thread's turn running? */
  constructor({ busy, everyMs = 30_000 }) {
    this.busy = busy;
    this.pending = new Map();
    this.everyMs = everyMs;
    this.timer = null;
  }

  /** `jobs`: [{id, run}]: run now, or as soon as no turn runs (RUN_THREADS). Gives {now: [ids], later: [ids]}. */
  async request(jobs) {
    const now = [];
    for (const job of jobs) {
      if (RUN_THREADS.includes(job.id)) this.pending.set(job.id, job.run);
      else now.push(job);
    }
    for (const job of now) await runJob(job);
    if (this.pending.size) {
      await this.tick();
      this.arm();
    }
    return { now: now.map((j) => j.id), later: jobs.map((j) => j.id).filter((id) => this.pending.has(id)) };
  }

  /** The waiting restarts, when no turn runs. Gives whether they ran. */
  async tick() {
    if (!this.pending.size || this.busy()) return false;
    const jobs = [...this.pending].map(([id, run]) => ({ id, run })).sort((a, b) => (a.id === "claude") - (b.id === "claude"));
    this.pending.clear();
    for (const job of jobs) await runJob(job);
    return true;
  }

  arm() {
    if (this.timer || !this.pending.size) return;
    this.timer = setInterval(() => {
      void this.tick().then(() => {
        if (!this.pending.size) this.stop();
      });
    }, this.everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

async function runJob({ id, run }) {
  try {
    await run();
  } catch (error) {
    log(`restarting ${id} failed:`, errorMessage(error));
  }
}

/** A plugin's newest released version on this PC (its sources' versions, newest first), or null. */
export function releasedVersion(target) {
  for (const s of target?.sources ?? []) if (s.versions?.length) return s.versions[0];
  return null;
}

export class ThreadPlugins {
  /** `engine`: the threads; `hub`: layr's tools; `dataDir`: where each thread's empty folder is made. */
  constructor({ engine, hub, store, dataDir }) {
    this.engine = engine;
    this.hub = hub;
    this.store = store;
    this.dataDir = dataDir;
    this.locks = new WriteLocks();
    this.catalogCache = null;
    this.gitOutside = null;
  }

  /** A thread with a plugin list (0.7.0), as opposed to a thread in a project or in one plugin's folder. */
  static has(meta) {
    return Array.isArray(meta?.plugins);
  }

  /** A thread in a project (a worktree of layr's source) that also has a plugin list (0.11.0). */
  static inProject(meta) {
    return ThreadPlugins.has(meta) && meta.kind !== "plugin";
  }

  /** The folder a new thread with a plugin list works in (empty, its own). */
  workDir() {
    return path.join(this.dataDir, "work", newId("w"));
  }

  /** The installed plugins (targets_list's), at most 5 s old. */
  async catalog(fresh = false) {
    if (!fresh && this.catalogCache && Date.now() - this.catalogCache.at < 5_000) return this.catalogCache.targets;
    const r = await listTargets(this.hub);
    this.catalogCache = { at: Date.now(), targets: r.targets };
    return r.targets;
  }

  /** Does the core keep plugins' histories beside their folders (`plugin_repos` says gitOutside)? */
  async coreKeepsGitOutside() {
    if (this.gitOutside !== null) return this.gitOutside;
    if (!this.hub.available) return false;
    try {
      const r = await this.hub.call("layr__plugin_repos", {});
      this.gitOutside = r?.gitOutside === true;
    } catch {
      return false;
    }
    return this.gitOutside;
  }

  /** Installed plugins matching words (id, name, description), with their versions: for references. */
  async find(query) {
    const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = await this.catalog();
    const score = (t) => {
      const hay = `${t.id} ${t.name} ${t.description}`.toLowerCase();
      return words.reduce((n, w) => n + (t.id === w ? 5 : hay.includes(w) ? 1 : 0), 0);
    };
    return all
      .map((t) => ({ t, s: words.length ? score(t) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
      .slice(0, 20)
      .map(({ t }) => ({ id: t.id, name: t.name, version: t.version, description: t.description, place: t.place,
        extension: t.extension, sources: t.sources ?? [] }));
  }

  /**
   * A row for `plugin` in `mode`: its folder (a store plugin to change gets your copy first, `layr__plugin_edit`;
   * `version` / `source`: building on that version), or a new plugin's folder (`newPlugin: {name, extension}`).
   */
  async resolve({ plugin, version = null, source = null, mode = "read", newPlugin = null, by = "you" }) {
    if (newPlugin) {
      const extension = Boolean(newPlugin.extension);
      const { id, folder } = newPluginFolder({ id: newPlugin.id, name: newPlugin.name, description: newPlugin.description });
      const name = String(newPlugin.name ?? "").trim() || id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
      if (extension) await scaffoldExtension(this.hub, { id, name, folder, description: newPlugin.description });
      const outside = await this.coreKeepsGitOutside();
      await initPluginRepo(folder, id, { outside }).catch((e) => log(`git init in ${folder} failed:`, errorMessage(e)));
      this.catalogCache = null;
      return { id, name, mode: "change", folder, place: "made", isNew: true, extension, version: null, source: null,
        by, at: nowIso() };
    }
    const all = await this.catalog();
    const t = all.find((x) => x.id === plugin);
    if (!t) throw new Error(`No installed plugin ${plugin} (plugin_find lists them)`);
    const other = (version && version !== t.version) || source;
    let folder = t.path;
    let place = t.place;
    if (mode === "change" && (place === "store" || other)) {
      if (other && !(await this.coreKeepsGitOutside())) {
        throw new Error("Building on another version needs a newer layr: update the app first");
      }
      const r = await this.hub.call("layr__plugin_edit", { plugin: t.id, ...(version ? { version } : {}),
        ...(source ? { source } : {}) });
      folder = r?.path ?? folder;
      place = !r?.branch || r.branch === "mine" ? "changed" : "made";
      this.catalogCache = null;
    } else if (mode === "read" && other) {
      const packages = packagesRoot();
      const sources = (t.sources ?? []).filter((s) => !source || s.source === source);
      const from = sources.find((s) => s.versions?.includes(version)) ?? sources[0];
      const dir = packages && from ? path.join(packages, t.id, from.source, version ?? t.version) : null;
      if (!dir || !existsSync(path.join(dir, "layr.json"))) {
        throw new Error(`${t.name} ${version ?? ""} isn't unpacked on this PC: ask to build on it (plugin_change) instead`);
      }
      folder = dir;
    }
    if (!folder || !existsSync(folder)) throw new Error(`The folder of ${t.name} is gone: ${folder}`);
    const manifest = readManifest(folder);
    // `base`: the released version the app falls back to when a change is held back (plugin_hold, 0.11.0).
    const base = t.place === "store" ? t.version : releasedVersion(t);
    return { id: t.id, name: t.name, mode, folder, place, isNew: false, extension: Boolean(manifest?.extension ?? t.extension),
      version: manifest?.version ?? version ?? t.version, source, by, at: nowIso(), linked: t.linked !== false,
      ...(base ? { base } : {}) };
  }

  /**
   * Holds back a plugin's changes (0.11.0, a thread in a project): they need a core the app doesn't have yet, so the
   * app runs the plugin's released version again (`layr__plugin_switch`); the changes stay in its folder.
   */
  async hold(meta, plugin, why) {
    const row = (meta.plugins ?? []).find((r) => r.id === plugin);
    if (!row || row.mode !== "change") throw new Error(`${plugin} isn't a plugin this thread may change`);
    if (row.held) return publicRow(row);
    const t = (await this.catalog(true)).find((x) => x.id === plugin);
    const version = row.base ?? releasedVersion(t);
    if (!version) throw new Error(`${row.name} has no released version on this PC to run instead: it can't be held back`);
    await this.hub.call("layr__plugin_switch", { plugin, version });
    this.catalogCache = null;
    const held = { version, why: why ? String(why) : null, at: nowIso() };
    const rows = (meta.plugins ?? []).map((r) => (r.id === plugin ? { ...r, held } : r));
    this.store.updateThread(meta.id, { plugins: rows });
    this.engine.emitThread(meta);
    return publicRow({ ...row, held });
  }

  /** The app runs the held-back changes again (the person, once the app has the core they need). */
  async release(meta, plugin) {
    const row = (meta.plugins ?? []).find((r) => r.id === plugin);
    if (!row?.held) throw new Error(`${plugin} isn't held back in this thread`);
    if (row.place === "made") await this.hub.call("layr__packages_link", { path: row.folder });
    else await this.hub.call("layr__plugin_switch", { plugin, mine: true });
    this.catalogCache = null;
    const rows = (meta.plugins ?? []).map((r) => (r.id === plugin ? { ...r, held: null } : r));
    this.store.updateThread(meta.id, {
      plugins: rows,
      pluginsNote: addNote(meta.pluginsNote, `The person switched on the held-back changes of ${row.name} (${row.id}): ` +
        "the app runs them now."),
    });
    this.engine.emitThread(meta);
    return publicRow({ ...row, held: null });
  }

  /** Puts a row into the thread's list (replacing the plugin's row) and says so to Claude with the next message. */
  put(meta, row, note) {
    const rows = (meta.plugins ?? []).filter((r) => r.id !== row.id);
    rows.push(row);
    this.store.updateThread(meta.id, { plugins: rows, ...(note ? { pluginsNote: addNote(meta.pluginsNote, note) } : {}) });
    this.engine.markRestart(meta.id);
    this.engine.emitThread(meta);
    return publicRow(row);
  }

  /** You add a plugin (the panel, a mention, thread_start): read, or change when you say so. */
  async add(meta, { plugin, version, source, mode = "read", newPlugin, by = "you" }) {
    if (!ThreadPlugins.has(meta)) throw new Error("This thread works in one folder: start a new thread to use a plugin list");
    if (!PLUGIN_MODES.includes(mode)) throw new Error(`mode is read or change, not ${mode}`);
    const had = (meta.plugins ?? []).find((r) => r.id === plugin);
    if (had && !newPlugin && !version && !source && (had.mode === mode || (mode === "read" && had.mode === "change"))) {
      return publicRow(had);
    }
    const row = await this.resolve({ plugin, version, source, mode, newPlugin, by });
    const note = by === "you"
      ? `The person ${had ? "changed" : "added"} ${row.name} (${row.id}) ${row.mode === "change" ? "for you to change" : "for you to read"}` +
        `${row.version ? `, version ${row.version}` : ""}: its folder is ${row.folder}.`
      : null;
    return this.put(meta, row, note);
  }

  /** Read only, or allowed to change (the panel's buttons). */
  async setMode(meta, plugin, mode) {
    const row = (meta.plugins ?? []).find((r) => r.id === plugin);
    if (!row) throw new Error(`${plugin} isn't in this thread's list`);
    if (row.mode === mode) return publicRow(row);
    if (mode === "change") {
      return this.add(meta, { plugin, version: row.version ?? undefined, source: row.source ?? undefined, mode });
    }
    return this.put(meta, { ...row, mode: "read" }, `The person made ${row.name} (${row.id}) read only: don't change it any more.`);
  }

  remove(meta, plugin) {
    const row = (meta.plugins ?? []).find((r) => r.id === plugin);
    if (!row) return { removed: false };
    this.store.updateThread(meta.id, {
      plugins: meta.plugins.filter((r) => r.id !== plugin),
      pluginsNote: addNote(meta.pluginsNote, `The person took ${row.name} (${row.id}) off this thread's list: leave it alone.`),
    });
    this.engine.markRestart(meta.id);
    this.engine.emitThread(meta);
    return { removed: true };
  }

  /** Every @mention in a message the person sends: added to read (unknown ids are left alone). */
  async mentioned(meta, text) {
    if (!ThreadPlugins.has(meta)) return [];
    const mentions = parseMentions(text);
    if (!mentions.length) return [];
    const ids = new Set((await this.catalog()).map((t) => t.id));
    const added = [];
    for (const m of mentions.filter((x) => ids.has(x.id))) {
      try {
        added.push(await this.add(meta, { plugin: m.id, version: m.version ?? undefined, mode: "read" }));
      } catch (error) {
        log(`adding @${m.id} to ${meta.id} failed:`, errorMessage(error));
      }
    }
    return added;
  }

  /** Claude asks to change a plugin: the person answers on a card (allow, allow every plugin in this thread, refuse). */
  async requestChange(meta, { plugin, version, source, why, newPlugin }, signal) {
    if (newPlugin) {
      const row = await this.resolve({ newPlugin, mode: "change", by: "claude" });
      this.put(meta, row, null);
      return { allowed: true, plugin: publicRow(row) };
    }
    const all = await this.catalog();
    const t = all.find((x) => x.id === plugin);
    if (!t) throw new Error(`No installed plugin ${plugin} (plugin_find lists them)`);
    const had = (meta.plugins ?? []).find((r) => r.id === plugin);
    const sameVersion = !version || version === had?.version;
    if (had?.mode === "change" && sameVersion && !source) return { allowed: true, plugin: publicRow(had) };
    if (!meta.allowAllPlugins) {
      const answer = await this.engine.askUser(meta, {
        kind: "plugin",
        tool: "plugin_change",
        title: `Claude wants to change ${t.name}${version ? ` (building on version ${version})` : ""}`,
        reason: why ? String(why) : null,
        input: { plugin, ...(version ? { version } : {}), ...(source ? { source } : {}) },
        plugin,
        canAlwaysAllow: true,
      }, signal);
      if (answer.decision === "deny") {
        return { allowed: false, message: answer.message?.trim() || `The person didn't allow changing ${t.name}.` };
      }
      if (answer.decision === "allow_always") this.store.updateThread(meta.id, { allowAllPlugins: true });
    }
    const row = await this.resolve({ plugin, version, source, mode: "change", by: "claude" });
    this.put(meta, row, null);
    return { allowed: true, plugin: publicRow(row) };
  }

  /** The tools Claude has in a thread with a plugin list (an in-process MCP server). */
  server(meta) {
    const id = meta.id;
    const current = () => this.engine.requireThread(id);
    const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    const fail = (error) => ({ content: [{ type: "text", text: errorMessage(error) }], isError: true });
    const run = (fn) => async (args, extra) => {
      try {
        return ok(await fn(args ?? {}, extra));
      } catch (error) {
        return fail(error);
      }
    };
    return createSdkMcpServer({
      name: THREAD_SERVER,
      version: "0.7.0",
      alwaysLoad: true,
      tools: [
        sdkTool("plugins_in_thread", "The plugins in this thread's list: what you may read and what you may change, " +
          "with their folders.", {}, run(() => ({ plugins: (current().plugins ?? []).map(publicRow) }))),
        sdkTool("plugin_find", "Installed layr plugins matching words (id, name, description), with their versions " +
          "and sources: to know which plugin the person means.", { query: z.string() },
          run(async (a) => ({ plugins: await this.find(a.query) }))),
        sdkTool("plugin_add", "Add an installed plugin to this thread's list, to read it (no need to ask). version: " +
          "read that version (when it is on this PC).", {
          plugin: z.string().describe("The plugin's id"),
          version: z.string().optional(),
          source: z.string().optional(),
        }, run(async (a) => ({ plugin: await this.add(current(), { ...a, mode: "read", by: "claude" }) }))),
        sdkTool("plugin_change", "Ask the person to let you change a plugin (it waits for their answer), or make a new " +
          "one (new: no need to ask). version / source: build on that version instead of the one that runs.", {
          plugin: z.string().optional().describe("An installed plugin's id"),
          why: z.string().optional().describe("What you want to change, in plain words, for the person"),
          version: z.string().optional(),
          source: z.string().optional(),
          new: z.object({ name: z.string(), extension: z.boolean().optional(), description: z.string().optional() })
            .optional().describe("Make a new plugin instead"),
        }, run(async (a, extra) => {
          if (!a.plugin && !a.new) throw new Error("Which plugin? Give plugin, or new");
          return this.requestChange(current(), { plugin: a.plugin, version: a.version, source: a.source, why: a.why,
            newPlugin: a.new }, extra?.signal);
        })),
        ...(ThreadPlugins.inProject(meta) ? [
          sdkTool("plugin_hold", "Hold back your changes to a plugin because they need this project's unpublished " +
            "core: the person's app runs the plugin's released version again, the changes stay in its folder until " +
            "the person switches them on.", {
            plugin: z.string().describe("The plugin's id"),
            why: z.string().describe("What it needs from the new core, in plain words"),
          }, run(async (a) => ({ plugin: await this.hold(current(), a.plugin, a.why) }))),
        ] : []),
      ],
    });
  }

  /** What a thread with a plugin list adds to its Claude Code session: tools, folders, the guard, its prompt. */
  async sessionExtras(meta) {
    const rows = meta.plugins ?? [];
    const installed = (await this.catalog().catch(() => [])).map((t) => ({ id: t.id, path: t.path }));
    const packages = packagesRoot();
    const home = packages ? path.dirname(packages) : null;
    const guard = async (input) => {
      const now = this.engine.requireThread(meta.id);
      const reason = guardDecision(input.tool_name, input.tool_input, {
        project: ThreadPlugins.inProject(now),
        cwd: input.cwd ?? now.cwd,
        rows: now.plugins ?? [],
        home,
        packages,
        installed,
        allowed: [now.cwd, this.store.attachmentsDir(now.id)],
        claim: (row) => {
          const holder = this.locks.claim(row.id, now.id, (t) => this.engine.isTurnActive(t));
          if (!holder) return null;
          const title = this.store.thread(holder)?.title ?? holder;
          return `${row.name} is being changed by the thread "${truncate(title, 60)}" right now: wait until its ` +
            "turn ends, then try again.";
        },
      });
      if (!reason) return { continue: true };
      log(`plugin guard: refused in ${meta.id}: ${input.tool_name}`);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    };
    return {
      mcpServer: this.server(meta),
      directories: rows.map((r) => r.folder).filter((f) => f && existsSync(f)),
      hooks: { PreToolUse: [{ matcher: GUARDED, hooks: [guard] }] },
      systemAppend: pluginsPrompt({ rows, workDir: meta.cwd, hubUrl: this.hub.url, project: ThreadPlugins.inProject(meta) }),
    };
  }

  /**
   * Allowed without asking in a thread with a plugin list: its own tools; reading a plugin on the list (its folder
   * may not be among the session's folders yet: added mid-turn); with acceptEdits, editing one it may change.
   */
  autoAllow(meta, toolName, input) {
    if (!ThreadPlugins.has(meta)) return false;
    if (toolName.startsWith(`mcp__${THREAD_SERVER}__`)) return true;
    const key = READ_TOOLS[toolName] ?? (meta.permissionMode === "acceptEdits" ? FILE_TOOLS[toolName] : null);
    const p = key ? input?.[key] : null;
    if (!p) return false;
    const row = rowFor(meta.plugins, path.resolve(meta.cwd ?? ".", String(p)));
    return Boolean(row && (READ_TOOLS[toolName] || row.mode === "change"));
  }

  /** After a turn: one commit per plugin it may change that has changes. Gives [{row, done}]. */
  async commit(meta, { prompt, reply, turn }) {
    const out = [];
    for (const row of (meta.plugins ?? []).filter((r) => r.mode === "change" && r.folder && existsSync(r.folder))) {
      try {
        const done = await autoCommit(row.folder, { prompt, reply, thread: meta.id, turn });
        if (done) out.push({ row, done });
      } catch (error) {
        log(`saving ${row.id} after ${meta.id}'s turn failed:`, errorMessage(error));
      }
    }
    return out;
  }

  /** Undoes this thread's commits in one plugin (or every plugin on its list), newest first. */
  async takeBack(meta, plugin) {
    const rows = (meta.plugins ?? []).filter((r) => r.mode === "change" && (!plugin || r.id === plugin));
    if (plugin && !rows.length) throw new Error(`${plugin} isn't a plugin this thread may change`);
    const results = [];
    for (const row of rows) {
      const ours = [];
      try {
        for (let skip = 0; skip < 1000; skip += 100) {
          const page = await this.hub.call("layr__plugin_history", { plugin: row.id, limit: 100, skip });
          ours.push(...(page?.commits ?? []).filter((c) => c.thread === meta.id));
          if (!page?.more) break;
        }
      } catch (error) {
        results.push({ plugin: row.id, undone: 0, error: errorMessage(error) });
        continue;
      }
      let undone = 0;
      let error = null;
      for (const c of ours) {
        try {
          await this.hub.call("layr__plugin_undo", { plugin: row.id, commit: c.sha });
          undone++;
        } catch (e) {
          error = `${truncate(c.subject, 60)}: ${errorMessage(e)}`;
          break;
        }
      }
      results.push({ plugin: row.id, undone, of: ours.length, ...(error ? { error } : {}) });
    }
    return results;
  }
}

function addNote(old, note) {
  return old ? `${old}\n${note}` : note;
}
