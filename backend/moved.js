// Plugin folders layr moved (0.6.0). A core with one folder for each plugin takes in the plugins made before it when
// it starts: each folder of `~/layr-plugins` with a layr.json becomes `<home>/packages/<id>/mine`, and the core lists
// what it moved in `<home>/moved-plugins.json`: `[{id, from, to, at}]`, newest last. This plugin keeps folders of its
// own: a project's `path`, and a thread's `cwd` (in its workspace, its target and its system prompt too). When the
// backend starts, every move it hasn't applied yet is applied to them, once (`<data>/moved-applied.json` keeps which):
// - Projects and threads in `from`, or inside it, are in `to` from then on. A thread of the old place's one project
//   for every plugin (`~/layr-plugins` itself) joins the plugin's own project.
// - Claude Code keeps a session's transcript by the folder it ran in: `<config>/projects/<the folder as a name>/
//   <session>.jsonl`, with `<session>/` next to it (its subagents' conversations). A moved thread's sessions are
//   copied under the new folder's name, so the thread resumes its session there, and going back and its subagents'
//   conversations find it. Only copies: nothing of Claude Code's is changed or removed, and what is there already
//   stays. (Claude Code 2.1 also finds a session by its id under another folder's name, and writes on in that old
//   file; with the copy nothing depends on that.) A session that isn't on disk any more is what a pruned one always
//   was: the next message starts a new one with the conversation so far (Engine.restartFresh), and says so.
// - The thread says it in one system entry (`subtype: "folder_moved"`), and Claude is told the new folder with the
//   next message (`movedNote`): the paths it remembers are the old ones.
// - Worktree threads of a moved repository: git's links between it and its worktrees are repaired.
import { constants, copyFileSync, cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sessionFile } from "./engine.js";
import { git } from "./git.js";
import { normalizePath } from "./store.js";
import { readManifest } from "./targets.js";
import { ensureDir, errorMessage, isDirectory, log, nowIso, readJson, writeFileAtomic } from "./util.js";

export const MOVED_FILE = "moved-plugins.json";
export const APPLIED_FILE = "moved-applied.json";

/** layr's home, as the core tells this backend (LAYR_HOME; else the folder LAYR_PACKAGES is in); null without one. */
export function layrHome(env = process.env) {
  if (env.LAYR_HOME) return path.resolve(env.LAYR_HOME);
  return env.LAYR_PACKAGES ? path.dirname(path.resolve(env.LAYR_PACKAGES)) : null;
}

/** The moves the core listed in its home, oldest first; [] when there is no list (an older core, nothing moved). */
export function readMoves(home) {
  const file = path.join(home, MOVED_FILE);
  if (!existsSync(file)) return [];
  let list;
  try {
    list = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log(`could not read ${file}:`, errorMessage(error));
    return [];
  }
  const ok = (m) => m && typeof m.from === "string" && m.from && typeof m.to === "string" && m.to;
  return (Array.isArray(list) ? list : [])
    .filter(ok)
    .map((m) => ({ id: String(m.id ?? ""), from: m.from, to: m.to, at: Number(m.at) || 0 }));
}

/** `p` after `from` became `to`: `to` itself, or the same place inside it; null when `p` isn't in `from`. */
export function movedPath(p, from, to) {
  if (!p || !from || !to) return null;
  const fold = (s) => (process.platform === "win32" ? s.toLowerCase() : s);
  const full = path.resolve(String(p));
  const base = path.resolve(String(from));
  if (fold(full) === fold(base)) return path.resolve(String(to));
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!fold(full).startsWith(fold(prefix))) return null;
  return path.join(path.resolve(String(to)), full.slice(prefix.length));
}

/** Is `p` the folder `dir`, or inside it? */
const isIn = (p, dir) => movedPath(p, dir, dir) !== null;

const moveKey = (m) => `${m.at}|${normalizePath(m.from)}|${normalizePath(m.to)}`;

/**
 * Applies the core's moves that weren't applied yet to the store's projects and threads, before the engine reads
 * them. Gives one `{id, from, to, at, projects, threads, sessions}` per move applied (`sessions`: how many threads'
 * Claude Code sessions are under the new folder's name now; `repair`, when the moved repository has worktree threads:
 * a promise that ends when git's links to them are repaired). A move whose new folder isn't there waits for a later
 * start.
 */
export function applyMoves({ store, home = layrHome(), env = process.env } = {}) {
  if (!home) return [];
  const moves = readMoves(home);
  if (!moves.length) return [];
  const appliedFile = path.join(store.dataDir, APPLIED_FILE);
  const applied = readJson(appliedFile, []);
  const done = new Set((Array.isArray(applied) ? applied : []).map(moveKey));
  const out = [];
  const newly = [];
  const entries = [];
  for (const move of moves) {
    if (done.has(moveKey(move))) continue;
    if (!isDirectory(move.to)) {
      log(`${move.id}: moved to ${move.to}, which isn't there: its projects and threads stay as they are for now`);
      continue;
    }
    const r = applyMove(store, move, env);
    done.add(moveKey(move));
    const item = { ...move, projects: r.projects, threads: r.threads.length, sessions: r.sessions };
    newly.push({ ...item, appliedAt: nowIso() });
    entries.push(...r.threads);
    log(`${move.id}: its folder moved to ${move.to}: ${r.projects} project(s), ${r.threads.length} thread(s) follow, ` +
      `${r.sessions} with Claude's session`);
    if (r.repair) {
      item.repair = git(move.to, ["worktree", "repair"], { timeoutMs: 30_000 }).then(
        () => true,
        (error) => (log(`${move.id}: repairing its worktrees:`, errorMessage(error)), false),
      );
    }
    out.push(item);
  }
  if (!out.length) return out;
  store.saveProjects();
  store.saveIndexNow();
  writeFileAtomic(appliedFile, JSON.stringify([...(Array.isArray(applied) ? applied : []), ...newly], null, 2));
  for (const e of entries) {
    store.append(e.thread, {
      type: "system",
      subtype: "folder_moved",
      text: "layr keeps each plugin in a folder of its own now, so this plugin's folder moved. The thread goes on " +
        "in the new folder.",
      from: e.from,
      to: e.to,
      session: e.session,
    });
  }
  return out;
}

function applyMove(store, { id, from, to }, env) {
  let projects = 0;
  for (const p of [...store.projects]) {
    const next = movedPath(p.path, from, to);
    if (!next) continue;
    projects++;
    const twin = store.projects.find((o) => o !== p && normalizePath(o.path) === normalizePath(next));
    if (!twin) {
      p.path = next;
      continue;
    }
    // The new folder is a project already: this one's threads join it.
    for (const t of Object.values(store.threads)) if (t.projectId === p.id) t.projectId = twin.id;
    store.projects = store.projects.filter((o) => o !== p);
  }
  const threads = [];
  let sessions = 0;
  let repair = false;
  for (const meta of Object.values(store.threads)) {
    const project = store.projects.find((p) => p.id === meta.projectId);
    const cwd = movedPath(meta.cwd, from, to);
    if (!cwd) {
      // A worktree of the moved repository: git's links between the two name the old folder.
      if (meta.workspace?.kind === "worktree" && project && isIn(project.path, to)) repair = true;
      continue;
    }
    const old = meta.cwd;
    // The old place's one project for every plugin (`~/layr-plugins`): the thread joins the plugin's own project.
    if (project && isIn(old, project.path) && !isIn(cwd, project.path)) {
      const name = readManifest(to)?.name || id || path.basename(from);
      const own = store.projects.find((p) => normalizePath(p.path) === normalizePath(to)) ??
        store.addProject({ path: to, name, kind: "plugin", pluginId: id || path.basename(from) });
      meta.projectId = own.id;
    }
    const session = meta.sessionStarted ? carrySessions(meta, old, cwd, env) : "none";
    if (session === "carried") sessions++;
    meta.cwd = cwd;
    const ws = movedPath(meta.workspace?.path, from, to);
    if (ws) meta.workspace = { ...meta.workspace, path: ws };
    const folder = movedPath(meta.extra?.folder, from, to);
    if (folder) meta.extra = { ...meta.extra, folder };
    // Its system prompt names the folder (also as JSON text, in the packages_link call it shows).
    if (meta.systemAppend) {
      const json = (s) => JSON.stringify(s).slice(1, -1);
      meta.systemAppend = meta.systemAppend.split(json(old)).join(json(cwd)).split(old).join(cwd);
    }
    if (meta.sessionStarted) {
      meta.movedNote =
        `[layr: this plugin's folder moved since your last turn, from ${old} to ${cwd} (layr keeps each plugin in ` +
        "a folder of its own now). You work in the new folder: every path you used under the old one is under the " +
        "new one now, and the old folder is gone.]\n\n";
    }
    threads.push({ thread: meta.id, from: old, to: cwd, session });
  }
  return { projects, threads, sessions, repair };
}

/**
 * Copies a thread's Claude Code sessions (the one it resumes, the one a go-back forks from, its earlier ones) from
 * under the old folder's name to under the new one's. Gives what became of the one it resumes: "carried" (it is
 * under the new name), "missing" (not on disk any more) or "failed" (it couldn't be copied).
 */
export function carrySessions(meta, oldCwd, newCwd, env = process.env) {
  const ids = [...new Set([meta.sessionId, meta.goBack?.from, ...(meta.earlierSessions ?? [])].filter(Boolean))];
  let main = "missing";
  for (const id of ids) {
    const r = carrySession(oldCwd, newCwd, id, env);
    if (id === meta.sessionId) main = r;
  }
  return main;
}

function carrySession(oldCwd, newCwd, id, env) {
  const from = sessionFile(oldCwd, id, env);
  const to = sessionFile(newCwd, id, env);
  try {
    if (!existsSync(from)) return existsSync(to) ? "carried" : "missing";
    if (!existsSync(to)) {
      ensureDir(path.dirname(to));
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    }
    // `<session>/`: its subagents' conversations and what else Claude Code keeps beside the transcript.
    const side = from.slice(0, -".jsonl".length);
    if (isDirectory(side)) cpSync(side, to.slice(0, -".jsonl".length), { recursive: true, force: false });
    return "carried";
  } catch (error) {
    log(`copying Claude's session ${id} to the moved folder failed:`, errorMessage(error));
    return existsSync(to) ? "carried" : "failed";
  }
}
