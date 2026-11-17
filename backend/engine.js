// The engine: Claude Code threads on the Agent SDK.
//
// One long-lived query per active thread, fed by a streaming input queue, so the user can send more messages
// (steer into the running turn, or queue for after it), interrupt, and switch model or permission mode while the
// session stays. A thread idle for a while has its query closed; the next message resumes it by session id, also
// after the backend restarts. A thread with background work (subagents, background shells, Monitor watches) is not
// idle: closing the query ends the Claude Code process and its background children with it, so it stays open until
// that work is done. Background work lost anyway (archive, a crash, the backend stopping) is said in the transcript,
// to the user, and to Claude on the next message.
//
// Everything a panel needs goes two ways: appended to the thread's transcript (threads/<id>.jsonl), and emitted
// as events on `claude:thread.<id>` through the hub. A panel opening later reads the transcript, then follows.
import { query } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { claudeEnv } from "./claudeEnv.js";
import { createWorktree, currentBranch, isGitRepo } from "./git.js";
import { threadSettings } from "./threadSettings.js";
import {
  AsyncQueue,
  errorMessage,
  isDirectory,
  log,
  newId,
  nowIso,
  randomUUID,
  titleFromPrompt,
  truncate,
} from "./util.js";

const IDLE_CLOSE_MS = Number(process.env.LAYR_CLAUDE_IDLE_MS || 10 * 60_000);
/** Turns cut off by the backend stopping are picked up again when it starts (LAYR_CLAUDE_RESUME=0: not). */
const RESUME_ON = process.env.LAYR_CLAUDE_RESUME !== "0";
/** At most this many times in a row without a turn ending: a turn that brings the engine down isn't run forever. */
const RESUME_MAX = 3;
/** Nor when it stopped longer ago than this (layr closed for days): it waits for the user as "interrupted". */
const RESUME_MAX_AGE_MS = Number(process.env.LAYR_CLAUDE_RESUME_MAX_AGE_H || 24) * 3_600_000;
const DELTA_FLUSH_MS = 60;
const TOOL_RESULT_MAX = 20_000;
const TOOL_INPUT_MAX = 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];

/** A model's context window when Claude Code hasn't said it: 1M for the `[1m]` ones, else 200k. */
export function contextWindowFor(model) {
  return /\[1m\]|-1m\b/i.test(String(model ?? "")) ? 1_000_000 : 200_000;
}

/**
 * How full a thread's context is: {tokens, window, percent} or null before its first answer. `window`: what Claude
 * Code reported for the model the thread runs on (a result's `modelUsage`), else by the model's name.
 */
export function contextFill(meta) {
  const tokens = meta.contextTokens;
  if (!tokens) return null;
  const model = meta.resolvedModel ?? meta.model;
  const said = meta.contextWindow && meta.contextWindow.model === model ? meta.contextWindow.tokens : null;
  const window = said || contextWindowFor(model);
  return { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 1000) / 10) };
}

/** The main model's context window from a result's `modelUsage` ({[model]: {contextWindow}}), or null. */
export function reportedWindow(modelUsage, model) {
  const entries = Object.entries(modelUsage ?? {}).filter(([, u]) => Number(u?.contextWindow) > 0);
  if (!entries.length || !model) return null;
  const exact = entries.find(([k]) => k === model);
  if (exact) return Number(exact[1].contextWindow);
  const base = String(model).replace(/\[1m\]$/i, "");
  const near = entries.filter(([k]) => k.replace(/\[1m\]$/i, "") === base);
  return near.length ? Math.max(...near.map(([, u]) => Number(u.contextWindow))) : null;
}

/** Allow rules a thread starts with (thread_start `allowedTools`): non-empty strings, at most 100. */
export function allowedToolsOf(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error("allowedTools is a list of tool names");
  return [...new Set(list.map((t) => String(t ?? "").trim()).filter(Boolean))].slice(0, 100);
}

const LAYR_INSTRUCTIONS = `

# layr
You are running inside layr, the user's workbench app, as one of its Claude Code threads. The MCP server named
"layr" (when connected) gives you the tools of every plugin installed in layr, named mcp__layr__<plugin>__<tool>,
and layr's own tools (mcp__layr__layr__*): use them when the user asks for something a plugin does.`;

export class Engine {
  constructor({ store, hub, account }) {
    this.store = store;
    this.hub = hub;
    this.account = account;
    /** @type {Map<string, Live>} live queries by thread id */
    this.lives = new Map();
    /** thread id → Set of functions called on every status change (thread_wait) */
    this.watchers = new Map();
    this.deltaBuffers = new Map();
    /** Folder → the slash commands Claude Code last said it has there. */
    this.commandsByCwd = new Map();
    this.notifySetting = null;
    /** The entry appended last (for emitEntry right after an append). */
    this.lastEntry = null;
    const append = store.append.bind(store);
    store.append = (id, entry) => (this.lastEntry = append(id, entry));
    this.recover();
  }

  // ---------------------------------------------------------------- startup

  /**
   * Turns that ran when the backend stopped (crashed, was killed, restarted, layr quit) died with their Claude Code
   * processes. Each is picked up again by itself (resumeAfterRestart, soon after the start): its thread waits as
   * "starting" (messages sent meanwhile queue) and its session is resumed with a note saying what happened. Not when
   * the thread is archived, the stop is older than RESUME_MAX_AGE_MS, it was picked up RESUME_MAX times in a row
   * without a turn ending (a turn that kills the engine), or LAYR_CLAUDE_RESUME=0: then it is "interrupted", as before.
   */
  recover() {
    this.toResume = [];
    for (const meta of Object.values(this.store.threads)) {
      if (meta.background?.length) this.backgroundLost(meta, meta.background, "the Claude engine restarted");
      const ran = meta.status === "running" || meta.status === "waiting" || meta.status === "starting";
      if (ran || meta.restartResume) {
        const stoppedAt = meta.restartResume?.at ?? meta.lastActivity ?? nowIso();
        const waiting = meta.restartResume?.waiting ?? meta.status === "waiting";
        const tries = meta.restartResumes ?? 0;
        const recent = Date.now() - (Date.parse(stoppedAt) || Date.now()) < RESUME_MAX_AGE_MS;
        if (RESUME_ON && !meta.archived && recent && tries < RESUME_MAX) {
          this.store.append(meta.id, {
            type: "system",
            subtype: "restart",
            text: "The Claude engine restarted while this turn ran; it goes on by itself.",
          });
          this.store.updateThread(meta.id, {
            status: "starting",
            pendingApprovals: [],
            restartResume: { at: stoppedAt, waiting },
          });
          this.toResume.push(meta.id);
        } else {
          const why = tries >= RESUME_MAX ? ` (picked up again ${tries} times in a row already, so not again)` : "";
          const text = `The Claude engine restarted while this turn ran; it stopped${why}.`;
          this.store.append(meta.id, { type: "system", text });
          this.store.updateThread(meta.id, {
            status: "interrupted",
            pendingApprovals: [],
            restartResume: null,
            restartResumes: 0,
          });
        }
      } else if (meta.pendingApprovals?.length) {
        this.store.updateThread(meta.id, { pendingApprovals: [] });
      }
    }
    this.store.saveIndexNow();
  }

  /** The threads recover() set aside, picked up again: each resumes its session with a note (or its first prompt). */
  async resumeAfterRestart() {
    for (const id of (this.toResume ?? []).splice(0)) {
      const meta = this.store.thread(id);
      if (!meta?.restartResume || meta.status !== "starting" || this.lives.has(id)) continue;
      const { at, waiting } = meta.restartResume;
      this.store.updateThread(id, { restartResume: null, restartResumes: (meta.restartResumes ?? 0) + 1 });
      try {
        if (meta.sessionStarted) {
          await this.dispatch(meta, { text: restartNote(at, waiting), auto: "restart", fork: true });
        } else {
          // Claude Code never started the session: its first message again, as it was.
          const first = this.store.readTranscript(id).findLast((e) => e.type === "user" && !e.auto);
          await this.dispatch(meta, { text: first?.text ?? "", savedImages: first?.images ?? [], auto: "restart" });
        }
        log(`thread ${id} picked up again after the restart`);
      } catch (error) {
        this.fail(meta, error);
      }
    }
  }

  // ---------------------------------------------------------------- threads

  /**
   * Start a thread: make its workspace, record it, and send the first prompt.
   * `workspace`: "project" (the project folder), "worktree" (a new git worktree on a new branch), or
   * { worktreePath } / { path } (an existing worktree or folder).
   */
  async startThread(input) {
    const project = this.resolveProject(input.project);
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim() && !input.images?.length) throw new Error("The prompt is empty");
    const permissionMode = input.permissionMode || project.defaultPermissionMode || "default";
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error(`Unknown permission mode ${permissionMode}`);
    const title = (input.title && String(input.title).trim()) || titleFromPrompt(prompt);
    const id = newId("t");

    let workspace;
    const ws = input.workspace ?? "project";
    if (ws === "project") {
      workspace = { kind: "project", path: project.path, branch: await currentBranch(project.path) };
    } else if (ws === "worktree") {
      const tree = await createWorktree({
        projectPath: project.path,
        name: input.branch ? input.branch : title,
        branch: input.branch,
        baseRef: input.baseRef || undefined,
        worktreesRoot: process.env.LAYR_CLAUDE_WORKTREES || undefined,
      });
      workspace = { kind: "worktree", path: tree.path, branch: tree.branch, base: tree.base, created: true };
    } else if (typeof ws === "object" && (ws.worktreePath || ws.path)) {
      const dir = path.resolve(ws.worktreePath || ws.path);
      if (!isDirectory(dir)) throw new Error(`No such folder: ${dir}`);
      const git = await isGitRepo(dir);
      workspace = { kind: ws.worktreePath ? "worktree" : "folder", path: dir, branch: git ? await currentBranch(dir) : null };
    } else {
      throw new Error(`Unknown workspace ${JSON.stringify(ws)}: use "project", "worktree" or {worktreePath}`);
    }

    const meta = this.store.createThread({
      id,
      projectId: project.id,
      title,
      kind: input.kind || "thread",
      cwd: workspace.path,
      workspace,
      model: input.model || project.defaultModel || null,
      effort: input.effort || project.defaultEffort || null,
      thinking: input.thinking !== false,
      permissionMode,
      sessionId: randomUUID(),
      sessionStarted: false,
      systemAppend: input.systemAppend || null,
      allowRules: allowedToolsOf(input.allowedTools),
      queue: [],
      queuePaused: false,
      pendingApprovals: [],
      todos: [],
      status: "starting",
      turns: 0,
      costUsd: 0,
      contextTokens: null,
      preview: "",
      error: null,
      archived: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastActivity: nowIso(),
      extra: input.extra || null,
    });
    this.store.append(id, {
      type: "created",
      title,
      workspace,
      model: meta.model,
      effort: meta.effort,
      permissionMode,
      project: { id: project.id, name: project.name, path: project.path },
    });
    this.emitThread(meta);
    try {
      await this.dispatch(meta, { text: prompt, images: input.images });
    } catch (error) {
      this.fail(meta, error);
      throw error;
    }
    return this.summary(meta);
  }

  resolveProject(ref) {
    if (!ref) throw new Error("Which project? Give a project id, name or folder (projects_list)");
    let project = this.store.findProject(ref);
    if (!project && isDirectory(String(ref))) project = this.store.addProject({ path: String(ref) });
    if (!project) throw new Error(`No project ${ref} (projects_list shows them; project_add adds a folder)`);
    if (!isDirectory(project.path)) throw new Error(`The project folder is gone: ${project.path}`);
    return project;
  }

  requireThread(id) {
    const meta = this.store.thread(id);
    if (!meta) throw new Error(`No thread ${id}`);
    return meta;
  }

  /** Send a message: a new turn when idle; while a turn runs, steer it ("steer") or wait for it to end ("queue"). */
  async send(id, { text, images, mode = "queue" }) {
    const meta = this.requireThread(id);
    if (!String(text ?? "").trim() && !images?.length) throw new Error("The message is empty");
    if (meta.archived) this.store.updateThread(id, { archived: false });
    const live = this.lives.get(id);
    const busy = live && live.turnActive;
    if (busy && mode === "steer") {
      const message = this.userMessage(meta, { text, images }, "now");
      this.store.append(id, { type: "user", text: message.text, images: message.images, steer: true });
      this.emitEntry(id, this.lastEntry);
      live.input.push(message.sdk);
      this.touch(meta, { preview: preview(text) });
      return { sent: "steer", thread: this.summary(meta) };
    }
    if (busy || meta.status === "starting") {
      const item = { id: newId("q"), text: String(text ?? ""), images: images ?? [], at: nowIso() };
      // Keep images on disk, not in the index.
      item.images = this.saveImages(meta, images);
      this.store.updateThread(id, { queue: [...meta.queue, item] });
      this.emitThread(meta);
      return { sent: "queued", queued: item.id, position: meta.queue.length, thread: this.summary(meta) };
    }
    const resumeQueue = meta.queuePaused;
    if (resumeQueue) this.store.updateThread(id, { queuePaused: false });
    await this.dispatch(meta, { text, images });
    return { sent: "turn", thread: this.summary(meta) };
  }

  /** Queued messages: remove one, send one now as a steer, or let a paused queue go on. */
  async queueAction(id, { action, item }) {
    const meta = this.requireThread(id);
    if (action === "resume") {
      this.store.updateThread(id, { queuePaused: false });
      if (!this.lives.get(id)?.turnActive) this.dispatchNextQueued(meta);
      return this.summary(meta);
    }
    const found = meta.queue.find((q) => q.id === item);
    if (!found) throw new Error(`No queued message ${item}`);
    this.store.updateThread(id, { queue: meta.queue.filter((q) => q.id !== item) });
    if (action === "steer") {
      const live = this.lives.get(id);
      if (live?.turnActive) {
        const message = this.userMessage(meta, { text: found.text, savedImages: found.images }, "now");
        this.store.append(id, { type: "user", text: message.text, images: message.images, steer: true });
        this.emitEntry(id, this.lastEntry);
        live.input.push(message.sdk);
      } else {
        await this.dispatch(meta, { text: found.text, savedImages: found.images });
      }
    }
    this.emitThread(meta);
    return this.summary(meta);
  }

  async interrupt(id) {
    const meta = this.requireThread(id);
    const live = this.lives.get(id);
    if (!live || !live.turnActive) return { interrupted: false, thread: this.summary(meta) };
    live.interruptRequested = true;
    if (meta.queue.length) this.store.updateThread(id, { queuePaused: true });
    for (const pending of live.approvals.values()) pending.resolve({ decision: "deny", message: "Stopped by the user", interrupt: true });
    try {
      await live.query.interrupt();
    } catch (error) {
      log(`interrupt ${id}:`, errorMessage(error));
      // The query is stuck: close it, the next message resumes the session.
      this.closeLive(id, "interrupt failed");
      this.endTurn(meta, live, { subtype: "interrupted", interrupted: true });
    }
    return { interrupted: true, thread: this.summary(meta) };
  }

  /** Change a thread's settings; a live query switches model and permission mode at once. */
  async update(id, patch) {
    const meta = this.requireThread(id);
    const live = this.lives.get(id);
    const changes = {};
    if (patch.title !== undefined && String(patch.title).trim()) changes.title = String(patch.title).trim();
    if (patch.model !== undefined && patch.model !== meta.model) {
      changes.model = patch.model || null;
      if (live) {
        try {
          await live.query.setModel(changes.model || undefined);
          live.model = changes.model;
        } catch (error) {
          log(`setModel ${id}:`, errorMessage(error));
          live.needsRestart = true;
        }
      }
    }
    if (patch.permissionMode !== undefined && patch.permissionMode !== meta.permissionMode) {
      if (!PERMISSION_MODES.includes(patch.permissionMode)) throw new Error(`Unknown permission mode ${patch.permissionMode}`);
      changes.permissionMode = patch.permissionMode;
      if (patch.permissionMode === "plan") changes.planReturnMode = meta.permissionMode;
      if (live) {
        try {
          await live.query.setPermissionMode(patch.permissionMode);
        } catch (error) {
          log(`setPermissionMode ${id}:`, errorMessage(error));
          live.needsRestart = true;
        }
      }
    }
    if (patch.effort !== undefined && (patch.effort || null) !== meta.effort) {
      changes.effort = patch.effort || null;
      if (live) live.needsRestart = true;
    }
    if (patch.thinking !== undefined && patch.thinking !== meta.thinking) {
      changes.thinking = Boolean(patch.thinking);
      if (live) live.needsRestart = true;
    }
    if (!Object.keys(changes).length) return this.summary(meta);
    this.store.updateThread(id, changes);
    // Renamed: the shell's questions about its tool calls say the new title.
    if (changes.title && this.hub.agentTokens?.has(id)) {
      this.hub.getAgentToken(id, changes.title).catch((error) => log(`renaming ${id}'s agent:`, errorMessage(error)));
    }
    const said = Object.entries(changes)
      .filter(([k]) => k !== "title")
      .map(([k, v]) => `${k}: ${v ?? "default"}`)
      .join(", ");
    if (said) {
      this.store.append(id, { type: "system", text: `Settings changed (${said})`, settings: changes });
      this.emitEntry(id, this.lastEntry);
    }
    // Effort and thinking need a new query: now when idle, after the turn and its background work otherwise.
    if (live?.needsRestart && this.canClose(live)) this.closeLive(id, "settings changed");
    this.emitThread(meta);
    return this.summary(meta);
  }

  archive(id, archived = true) {
    const meta = this.requireThread(id);
    if (archived) {
      const live = this.lives.get(id);
      if (live?.turnActive) void this.interrupt(id).catch(() => {});
      this.closeLive(id, "archived");
    }
    this.store.updateThread(id, { archived });
    this.emitThread(meta);
    return this.summary(meta);
  }

  /** Answer a permission request, a question, or a plan. */
  answerApproval(id, { requestId, decision, message, answers }) {
    const meta = this.requireThread(id);
    const live = this.lives.get(id);
    const pending = live?.approvals.get(requestId);
    if (!pending) {
      throw new Error(`Request ${requestId} is not waiting any more (answered, or its turn ended)`);
    }
    if (!["allow", "allow_always", "deny"].includes(decision)) throw new Error(`Unknown decision ${decision}`);
    if (pending.kind === "question" && decision !== "deny" && !answers) {
      throw new Error("A question needs `answers`: { [question text]: label or [labels] }");
    }
    pending.resolve({ decision, message, answers });
    return { answered: true, thread: this.summary(meta) };
  }

  // ---------------------------------------------------------------- reading

  summary(meta) {
    const live = this.lives.get(meta.id);
    return {
      id: meta.id,
      projectId: meta.projectId,
      title: meta.title,
      kind: meta.kind,
      // 0.3.2: what a plugin thread works on (thread_start's target), null for project threads.
      target:
        meta.kind === "plugin"
          ? { kind: meta.extra?.target ?? "plugin", plugin: meta.extra?.pluginId ?? null, place: meta.extra?.place ?? "made" }
          : null,
      status: meta.status,
      live: Boolean(live),
      cwd: meta.cwd,
      workspace: meta.workspace,
      model: meta.model,
      effort: meta.effort,
      thinking: meta.thinking,
      permissionMode: meta.permissionMode,
      sessionId: meta.sessionId,
      turns: meta.turns,
      costUsd: round(meta.costUsd, 4),
      contextTokens: meta.contextTokens,
      context: contextFill(meta),
      preview: meta.preview,
      error: meta.error,
      todos: meta.todos,
      background: meta.background ?? [],
      resuming: Boolean(meta.restartResume),
      queue: meta.queue.map((q) => ({ id: q.id, text: q.text, images: q.images?.length ?? 0, at: q.at })),
      queuePaused: meta.queuePaused,
      pendingApprovals: meta.pendingApprovals,
      archived: meta.archived,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastActivity: meta.lastActivity,
    };
  }

  list({ project, limit = 50, archived = false, query: text } = {}) {
    const p = project ? this.store.findProject(project) : null;
    if (project && !p) throw new Error(`No project ${project}`);
    let threads = Object.values(this.store.threads);
    if (p) threads = threads.filter((t) => t.projectId === p.id);
    if (archived !== "all") threads = threads.filter((t) => Boolean(t.archived) === Boolean(archived));
    if (text) {
      const needle = String(text).toLowerCase();
      threads = threads.filter((t) => `${t.title} ${t.preview} ${t.workspace?.branch ?? ""}`.toLowerCase().includes(needle));
    }
    threads.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
    return threads.slice(0, limit).map((t) => this.summary(t));
  }

  /** Wait until the turn ends or needs the user (an approval), at most `timeoutSec`. */
  wait(id, timeoutSec = 120) {
    const meta = this.requireThread(id);
    const settled = () => meta.status !== "running" && meta.status !== "starting";
    if (settled()) return Promise.resolve({ timedOut: false, thread: this.summary(meta), last: this.lastReply(id) });
    return new Promise((resolve) => {
      const set = this.watchers.get(id) ?? new Set();
      this.watchers.set(id, set);
      const done = (timedOut) => {
        clearTimeout(timer);
        set.delete(check);
        resolve({ timedOut, thread: this.summary(meta), last: this.lastReply(id) });
      };
      const check = () => settled() && done(false);
      const timer = setTimeout(() => done(true), Math.max(1, Math.min(Number(timeoutSec) || 120, 3600)) * 1000);
      set.add(check);
    });
  }

  lastReply(id) {
    const entries = this.store.readTranscript(id);
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === "text" && !entries[i].parent) return truncate(entries[i].text, 4000);
      if (entries[i].type === "user") break;
    }
    return null;
  }

  // ---------------------------------------------------------------- turns

  /**
   * Start a turn now: open the query when needed and push the message. `auto`: not the user's ("restart": the
   * engine picks a cut-off turn up again); `fork`: a new query resumes into a fork of the session (resumeAfterRestart).
   */
  async dispatch(meta, { text, images, savedImages, auto, fork = false }) {
    const message = this.userMessage(meta, { text, images, savedImages });
    let live = this.lives.get(meta.id);
    if (live?.needsRestart && this.canClose(live)) {
      this.closeLive(meta.id, "restart for new settings");
      live = null;
    }
    this.store.append(meta.id, { type: "user", text: message.text, images: message.images, ...(auto ? { auto } : {}) });
    this.emitEntry(meta.id, this.lastEntry);
    if (!meta.title || meta.title === "New thread") this.store.updateThread(meta.id, { title: titleFromPrompt(text) });
    if (!live) live = await this.openLive(meta, { fork });
    this.beginTurn(meta, live);
    this.tellLostBackground(meta, message.sdk);
    live.input.push(message.sdk);
    this.touch(meta, { preview: preview(text) });
  }

  dispatchNextQueued(meta) {
    if (meta.queuePaused || !meta.queue.length || meta.archived) return false;
    const [next, ...rest] = meta.queue;
    this.store.updateThread(meta.id, { queue: rest });
    void this.dispatch(meta, { text: next.text, savedImages: next.images }).catch((error) => this.fail(meta, error));
    return true;
  }

  beginTurn(meta, live) {
    if (live.turnActive) return;
    live.turnActive = true;
    live.interruptRequested = false;
    live.turnStartedAt = Date.now();
    clearTimeout(live.idleTimer);
    const turn = (meta.turns ?? 0) + 1;
    this.store.updateThread(meta.id, { turns: turn, status: "running", error: null });
    this.store.append(meta.id, { type: "turn_start", turn, model: live.model ?? meta.model });
    this.emitEntry(meta.id, this.lastEntry);
    this.emitThread(meta);
  }

  endTurn(meta, live, result) {
    if (!live.turnActive) return;
    live.turnActive = false;
    this.flushDeltas(meta.id);
    const interrupted = result.interrupted || (live.interruptRequested && result.subtype !== "success");
    const status = interrupted ? "interrupted" : result.isError || result.subtype !== "success" ? "failed" : "done";
    const error = status === "failed" ? result.error || result.subtype : null;
    this.store.append(meta.id, {
      type: "turn_end",
      turn: meta.turns,
      status,
      subtype: result.subtype,
      error,
      costUsd: result.costUsd ?? null,
      durationMs: result.durationMs ?? (live.turnStartedAt ? Date.now() - live.turnStartedAt : null),
      usage: result.usage ?? null,
      numTurns: result.numTurns ?? null,
    });
    this.emitEntry(meta.id, this.lastEntry);
    this.store.updateThread(meta.id, {
      status,
      error,
      costUsd: (meta.costUsd ?? 0) + (result.costUsd ?? 0),
      pendingApprovals: [],
      // A turn that ends at all didn't bring the engine down: a later restart may pick a turn up again.
      ...(meta.restartResumes ? { restartResumes: 0 } : {}),
    });
    this.touch(meta);
    if (status === "done") this.notifyUser(meta, `Claude finished: ${meta.title}`, "success");
    else if (status === "failed") this.notifyUser(meta, `Claude thread failed: ${meta.title}`, "error");
    for (const pending of live.approvals.values()) pending.resolve({ decision: "deny", message: "The turn ended" });
    live.approvals.clear();
    if (live.closed || (live.needsRestart && this.canClose(live))) this.closeLive(meta.id, "after turn");
    this.emitThread(meta);
    this.onTurnEnded?.(meta, status);
    if (!this.dispatchNextQueued(meta)) this.scheduleIdleClose(meta.id);
  }

  /** Close an idle query after a while; not while background work runs (it would die with the process). */
  scheduleIdleClose(id) {
    const live = this.lives.get(id);
    if (!live) return;
    clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (!this.canClose(live)) return;
    live.idleTimer = setTimeout(() => {
      if (this.canClose(live)) this.closeLive(id, "idle");
    }, IDLE_CLOSE_MS);
    live.idleTimer.unref?.();
  }

  /** No turn and no background work: closing the query loses nothing. */
  canClose(live) {
    return !live.turnActive && !live.background.size;
  }

  /**
   * Claude Code's full set of live background tasks (the SDK's `background_tasks_changed`, a level signal: replace,
   * don't pair edges). Ambient ones (housekeeping watchers) are not work and don't keep the query open.
   */
  setBackground(meta, live, tasks) {
    if (live.closed || this.lives.get(meta.id) !== live) return; // a query closed or replaced already
    const before = live.background;
    const next = new Map();
    for (const t of tasks ?? []) {
      if (!t?.task_id || t.ambient) continue;
      next.set(t.task_id, {
        id: t.task_id,
        type: t.task_type ?? null,
        ...(t.subagent_type ? { agent: t.subagent_type } : {}),
        description: String(t.description ?? ""),
        startedAt: before.get(t.task_id)?.startedAt ?? nowIso(),
      });
    }
    const same = next.size === before.size &&
      [...next.values()].every((t) => before.get(t.id)?.description === t.description);
    live.background = next;
    for (const t of next.values()) live.seenTasks.set(t.id, t);
    if (same) return;
    this.store.updateThread(meta.id, { background: [...next.values()] });
    if (next.size) {
      clearTimeout(live.idleTimer);
      live.idleTimer = null;
    } else if (!live.turnActive) {
      if (live.needsRestart) this.closeLive(meta.id, "settings changed");
      else this.scheduleIdleClose(meta.id);
    }
    this.emitThread(meta);
  }

  /** Background tasks died with the Claude Code process: say so now, and to Claude with the next message. */
  backgroundLost(meta, tasks, why) {
    if (!tasks?.length) return;
    const n = tasks.length;
    const names = tasks.map((t) => t.description || t.type || t.id);
    const text = `${n} background task${n > 1 ? "s" : ""} stopped unfinished (${why}): ${names.join("; ")}`;
    this.store.append(meta.id, { type: "system", subtype: "background_lost", text, tasks });
    this.emitEntry(meta.id, this.lastEntry);
    const lost = [...(meta.lostBackground ?? []), ...tasks.map((t) => ({ ...t, why, at: nowIso() }))].slice(-50);
    this.store.updateThread(meta.id, { background: [], lostBackground: lost });
    this.notifyUser(meta, `${n} background task${n > 1 ? "s" : ""} of "${meta.title}" stopped unfinished`, "error");
    this.emitThread(meta);
  }

  /** The next message tells Claude which of its background tasks were stopped, so it needn't guess. */
  tellLostBackground(meta, sdk) {
    const lost = meta.lostBackground;
    if (!lost?.length) return;
    this.store.updateThread(meta.id, { lostBackground: [] });
    const lines = lost.map((t) => `- ${t.description || t.id} (${t.type ?? "task"} ${t.id}; ${t.why}, ${t.at})`);
    const note =
      "[layr: these background tasks of yours were stopped before they finished, when the Claude Code process " +
      "closed; they will not report back. Check what they left (commits, files) before relying on their work.\n" +
      `${lines.join("\n")}]\n\n`;
    const content = sdk.message.content;
    if (typeof content === "string") sdk.message.content = note + content;
    else sdk.message.content = [{ type: "text", text: note.trim() }, ...content];
  }

  fail(meta, error) {
    const message = errorMessage(error);
    log(`thread ${meta.id} failed:`, message);
    const live = this.lives.get(meta.id);
    this.store.append(meta.id, { type: "error", message });
    this.emitEntry(meta.id, this.lastEntry);
    if (live?.turnActive) this.endTurn(meta, live, { subtype: "error", isError: true, error: message });
    else {
      this.store.updateThread(meta.id, { status: "failed", error: message });
      this.emitThread(meta);
    }
  }

  // ---------------------------------------------------------------- the query

  /**
   * A new query for the thread. `fresh`: a new session (the old one is gone); `fork`: resume into a fork of the
   * session, after a restart: a Claude Code process of the old backend still closing can't write into the same file.
   */
  async openLive(meta, { fresh = false, fork = false } = {}) {
    const mcpServers = {};
    try {
      if (this.hub.available) {
        const token = await this.hub.getAgentToken(meta.id, meta.title);
        mcpServers.layr = { type: "http", url: this.hub.url, headers: { Authorization: `Bearer ${token}` } };
      }
    } catch (error) {
      log("no agent token, threads run without layr's tools:", errorMessage(error));
      this.store.append(meta.id, { type: "system", text: `layr's plugin tools are not available: ${errorMessage(error)}` });
    }
    const models = await this.account.listModels().catch(() => []);
    const modelInfo = models.find((m) => m.id === meta.model) ?? null;
    const input = new AsyncQueue();
    const live = {
      threadId: meta.id,
      input,
      query: null,
      turnActive: false,
      interruptRequested: false,
      approvals: new Map(),
      streamBlocks: new Map(),
      streamKeyByIndex: new Map(),
      currentStreamMessage: null,
      lastTotalCost: 0,
      model: meta.model,
      needsRestart: false,
      closed: false,
      idleTimer: null,
      /** task id → the background task: a new process has none (the SDK's level is per process). */
      background: new Map(),
      /** every background task this process had, for naming the ones that finish */
      seenTasks: new Map(),
      sawInit: false,
      sawOutput: false,
      resumed: false,
    };
    const resume = meta.sessionStarted && !fresh;
    if (fresh) {
      meta.sessionId = randomUUID();
      meta.sessionStarted = false;
    }
    const effort = meta.effort && (!modelInfo || !modelInfo.efforts.length || modelInfo.efforts.includes(meta.effort))
      ? meta.effort
      : undefined;
    const settings = threadSettings();
    const options = {
      cwd: meta.cwd,
      ...(settings ? { settings } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(effort ? { effort } : {}),
      ...(meta.thinking === false
        ? { thinking: { type: "disabled" } }
        : !modelInfo || modelInfo.thinking
          ? { thinking: { type: "adaptive", display: "summarized" } }
          : {}),
      permissionMode: meta.permissionMode || "default",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      ...(meta.allowRules?.length ? { allowedTools: [...meta.allowRules] } : {}),
      additionalDirectories: [this.store.attachmentsDir(meta.id)],
      includePartialMessages: true,
      canUseTool: (toolName, toolInput, opts) => this.canUseTool(meta, live, toolName, toolInput, opts),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: LAYR_INSTRUCTIONS + (meta.systemAppend ? `\n\n${meta.systemAppend}` : ""),
      },
      env: claudeEnv(),
      stderr: (data) => log(`[${meta.id} stderr] ${String(data).trimEnd()}`),
      ...(resume ? { resume: meta.sessionId, ...(fork ? { forkSession: true } : {}) } : { sessionId: meta.sessionId }),
    };
    live.resumed = resume;
    live.query = query({ prompt: input, options });
    this.lives.set(meta.id, live);
    this.store.updateThread(meta.id, { sessionId: meta.sessionId });
    void this.pump(meta, live, resume);
    return live;
  }

  async pump(meta, live, resumed) {
    try {
      for await (const message of live.query) {
        try {
          this.handle(meta, live, message);
        } catch (error) {
          log(`handling a message of ${meta.id}:`, error);
        }
      }
      if (live.turnActive) this.endTurn(meta, live, { subtype: live.interruptRequested ? "interrupted" : "ended", interrupted: live.interruptRequested, isError: !live.interruptRequested, error: "Claude Code stopped" });
    } catch (error) {
      const text = errorMessage(error);
      if (resumed && isSessionGone(text) && !live.closed && !live.sawOutput) {
        await this.restartFresh(meta, live);
        return;
      }
      if (live.closed) return;
      log(`query of ${meta.id} ended with an error:`, text);
      if (live.turnActive) {
        this.store.append(meta.id, { type: "error", message: text });
        this.emitEntry(meta.id, this.lastEntry);
        this.endTurn(meta, live, {
          subtype: live.interruptRequested ? "interrupted" : "error",
          interrupted: live.interruptRequested,
          isError: true,
          error: text,
        });
      }
    } finally {
      if (this.lives.get(meta.id) === live) {
        this.lives.delete(meta.id);
        clearTimeout(live.idleTimer);
        this.backgroundLost(meta, [...live.background.values()], "Claude Code stopped");
        live.background.clear();
        this.emitThread(meta);
      }
    }
  }

  /** Claude Code prunes old transcripts: start a new session with the conversation so far in the prompt. */
  async restartFresh(meta, live) {
    log(`session of ${meta.id} is gone, starting over`);
    const wasActive = live.turnActive;
    live.turnActive = false;
    this.closeLive(meta.id, "session gone");
    this.store.append(meta.id, { type: "system", text: "The old Claude session was gone; started a new one with the conversation so far." });
    this.emitEntry(meta.id, this.lastEntry);
    try {
      const fresh = await this.openLive(meta, { fresh: true });
      fresh.turnActive = wasActive;
      fresh.turnStartedAt = live.turnStartedAt;
      fresh.input.push({ type: "user", message: { role: "user", content: this.historyPrompt(meta.id) }, parent_tool_use_id: null });
    } catch (error) {
      this.fail(meta, error);
    }
  }

  closeLive(id, why) {
    const live = this.lives.get(id);
    if (!live) return;
    log(`closing the query of ${id} (${why})`);
    live.closed = true;
    clearTimeout(live.idleTimer);
    this.lives.delete(id);
    const meta = this.store.thread(id);
    if (meta && live.background.size) {
      this.backgroundLost(meta, [...live.background.values()], `the session closed: ${why}`);
    }
    live.background.clear();
    live.input.close();
    try {
      live.query.close();
    } catch {
      // closed already
    }
    if (meta) this.emitThread(meta);
  }

  historyPrompt(id) {
    const lines = [];
    for (const e of this.store.readTranscript(id)) {
      if (e.type === "user") lines.push(`<user>\n${e.text}\n</user>`);
      else if (e.type === "text" && !e.parent) lines.push(`<assistant>\n${truncate(e.text, 4000)}\n</assistant>`);
    }
    const last = lines.pop() ?? "";
    const body = lines.slice(-30).join("\n");
    return `Earlier in this conversation (the old session could not be resumed):\n<conversation>\n${body}\n</conversation>\n\n${last.replace(/^<user>\n|\n<\/user>$/g, "")}`;
  }

  // ---------------------------------------------------------------- SDK messages

  handle(meta, live, msg) {
    const id = meta.id;
    if (msg.session_id && msg.session_id !== meta.sessionId) this.store.updateThread(id, { sessionId: msg.session_id });
    switch (msg.type) {
      case "system":
        return this.handleSystem(meta, live, msg);
      case "stream_event":
        live.sawOutput = true;
        return this.handleStream(meta, live, msg);
      case "assistant":
        live.sawOutput = true;
        return this.handleAssistant(meta, live, msg);
      case "user":
        return this.handleUser(meta, live, msg);
      case "result":
        return this.handleResult(meta, live, msg);
      case "rate_limit_event":
        this.account.setRateLimit(msg.rate_limit_info);
        this.hub.emit("claude:usage", { limits: this.account.limits });
        return;
      default:
        return;
    }
  }

  handleSystem(meta, live, msg) {
    if (msg.subtype === "init") {
      live.sawInit = true;
      live.model = msg.model;
      // Only real failures: servers waiting for a sign-in (claude.ai connectors) are the user's to fix in Claude.
      const failed = (msg.mcp_servers ?? []).filter((s) => s.status === "failed" || (s.name === "layr" && s.status !== "connected" && s.status !== "pending"));
      this.store.updateThread(meta.id, { sessionStarted: true, resolvedModel: msg.model });
      if (!live.loggedInit) {
        live.loggedInit = true;
        this.store.append(meta.id, {
          type: "system",
          subtype: "init",
          text: `Claude Code ${msg.claude_code_version ?? ""} · ${msg.model} · ${msg.permissionMode}`.trim(),
          model: msg.model,
          mcp: (msg.mcp_servers ?? []).map((s) => ({ name: s.name, status: s.status })),
          failedMcp: failed.map((s) => s.name),
        });
        this.emitEntry(meta.id, this.lastEntry);
      }
      void live.query
        .supportedModels?.()
        .then((models) => this.account.setModels(models))
        .catch(() => {});
      // Its slash commands: the names now, then with their descriptions.
      if (Array.isArray(msg.slash_commands) && !meta.slashCommands?.some((c) => c.description)) {
        const terminalOnly = new Set(msg.terminal_slash_commands ?? []);
        this.setCommands(meta, msg.slash_commands.filter((c) => !terminalOnly.has(c)));
      }
      void live.query
        .supportedCommands?.()
        .then((commands) => this.setCommands(meta, commands))
        .catch(() => {});
    } else if (msg.subtype === "commands_changed") {
      this.setCommands(meta, msg.commands);
    } else if (msg.subtype === "background_tasks_changed") {
      this.setBackground(meta, live, msg.tasks);
    } else if (msg.subtype === "task_notification" && !msg.ambient && !msg.skip_transcript &&
      live.seenTasks.has(msg.task_id)) {
      const task = live.seenTasks.get(msg.task_id);
      this.store.append(meta.id, {
        type: "system",
        subtype: "background_done",
        text: `Background task ${msg.status}: ${task.description || task.type || msg.task_id}`,
        task: { ...task, status: msg.status },
      });
      this.emitEntry(meta.id, this.lastEntry);
    } else if (msg.subtype === "compact_boundary") {
      const m = msg.compact_metadata ?? {};
      this.store.append(meta.id, {
        type: "system",
        text: `Conversation compacted (${m.trigger ?? "auto"}, ${m.pre_tokens ?? "?"} tokens before)`,
      });
      this.emitEntry(meta.id, this.lastEntry);
    } else if (msg.subtype === "api_retry") {
      this.store.append(meta.id, {
        type: "system",
        text: `The API had a problem${msg.error_status ? ` (${msg.error_status})` : ""}; retry ${msg.attempt} of ${msg.max_retries}`,
      });
      this.emitEntry(meta.id, this.lastEntry);
    } else if (msg.subtype === "status" && msg.permissionMode && msg.permissionMode !== meta.permissionMode) {
      this.store.updateThread(meta.id, { permissionMode: msg.permissionMode });
      this.emitThread(meta);
    }
  }

  handleStream(meta, live, msg) {
    if (msg.parent_tool_use_id) return; // subagents: shown from their whole messages
    const ev = msg.event;
    if (!live.turnActive) this.beginTurn(meta, live);
    if (ev.type === "message_start") {
      live.currentStreamMessage = ev.message?.id ?? msg.uuid;
    } else if (ev.type === "content_block_start") {
      const mid = live.currentStreamMessage ?? "m";
      const type = ev.content_block?.type;
      if (type !== "text" && type !== "thinking") return;
      const key = `${mid}:${ev.index}`;
      live.streamKeyByIndex.set(`${mid}:${ev.index}`, key);
      const list = live.streamBlocks.get(mid) ?? [];
      list.push({ key, type, used: false });
      live.streamBlocks.set(mid, list);
    } else if (ev.type === "content_block_delta") {
      const mid = live.currentStreamMessage ?? "m";
      const key = live.streamKeyByIndex.get(`${mid}:${ev.index}`);
      if (!key) return;
      if (ev.delta?.type === "text_delta") this.bufferDelta(meta.id, key, "text", ev.delta.text);
      else if (ev.delta?.type === "thinking_delta") this.bufferDelta(meta.id, key, "thinking", ev.delta.thinking);
    }
  }

  /** The stream key of a whole block, so the panel swaps its live text for the finished entry. */
  claimStreamKey(live, messageId, type, fallback) {
    const list = live.streamBlocks.get(messageId);
    const found = list?.find((b) => !b.used && b.type === type);
    if (found) {
      found.used = true;
      return found.key;
    }
    return fallback;
  }

  handleAssistant(meta, live, msg) {
    const parent = msg.parent_tool_use_id ?? null;
    if (!live.turnActive && !parent) this.beginTurn(meta, live);
    this.flushDeltas(meta.id);
    const m = msg.message ?? {};
    const content = Array.isArray(m.content) ? m.content : [];
    content.forEach((block, i) => {
      const fallback = `${msg.uuid ?? m.id}:${i}`;
      if (block.type === "text") {
        if (!block.text) return;
        const key = parent ? fallback : this.claimStreamKey(live, m.id, "text", fallback);
        this.addEntry(meta, { type: "text", id: key, text: block.text, ...(parent ? { parent } : {}) });
        if (!parent) this.touch(meta, { preview: preview(block.text) });
      } else if (block.type === "thinking") {
        const key = parent ? fallback : this.claimStreamKey(live, m.id, "thinking", fallback);
        if (!block.thinking) return;
        this.addEntry(meta, { type: "thinking", id: key, text: block.thinking, ...(parent ? { parent } : {}) });
      } else if (block.type === "tool_use") {
        const inputText = JSON.stringify(block.input ?? {});
        const input = inputText.length > TOOL_INPUT_MAX ? { _truncated: truncate(inputText, TOOL_INPUT_MAX) } : block.input;
        this.addEntry(meta, { type: "tool_use", id: block.id, name: block.name, input, ...(parent ? { parent } : {}) });
        if (block.name === "TodoWrite" && Array.isArray(block.input?.todos) && !parent) {
          const todos = block.input.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
          this.store.updateThread(meta.id, { todos });
          this.emitThread(meta);
        }
      }
    });
    if (msg.error) {
      this.addEntry(meta, { type: "error", message: `Claude's answer failed: ${typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)}` });
    }
    const u = m.usage;
    if (u && !parent) {
      const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (ctx > 0) this.store.updateThread(meta.id, { contextTokens: ctx });
    }
  }

  handleUser(meta, live, msg) {
    if (msg.isReplay) return;
    const parent = msg.parent_tool_use_id ?? null;
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      let text = "";
      let images = 0;
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content)) {
        for (const c of block.content) {
          if (c.type === "text") text += (text ? "\n" : "") + c.text;
          else if (c.type === "image") images++;
        }
      }
      this.addEntry(meta, {
        type: "tool_result",
        id: block.tool_use_id,
        content: truncate(text, TOOL_RESULT_MAX),
        isError: block.is_error === true,
        ...(images ? { images } : {}),
        ...(parent ? { parent } : {}),
      });
    }
  }

  handleResult(meta, live, msg) {
    if (live.resumed && !live.sawOutput && msg.subtype !== "success" && isSessionGone((msg.errors ?? []).join("\n"))) {
      void this.restartFresh(meta, live);
      return;
    }
    const total = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
    let cost = null;
    if (total != null) {
      cost = total >= live.lastTotalCost ? total - live.lastTotalCost : total;
      live.lastTotalCost = total;
    }
    const u = msg.usage ?? {};
    const model = meta.resolvedModel ?? live.model;
    const window = reportedWindow(msg.modelUsage, model);
    if (window) this.store.updateThread(meta.id, { contextWindow: { model, tokens: window } });
    this.endTurn(meta, live, {
      subtype: msg.subtype,
      isError: msg.is_error === true || msg.subtype !== "success",
      error: msg.subtype === "success" ? (msg.is_error ? String(msg.result ?? "error") : null) : (msg.errors ?? []).join("\n") || msg.subtype,
      costUsd: cost,
      durationMs: msg.duration_ms,
      numTurns: msg.num_turns,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    });
  }

  // ---------------------------------------------------------------- approvals

  canUseTool(meta, live, toolName, toolInput, opts) {
    const kind = toolName === "AskUserQuestion" ? "question" : toolName === "ExitPlanMode" ? "plan" : "permission";
    if (kind === "permission" && meta.permissionMode === "bypassPermissions") {
      return Promise.resolve({ behavior: "allow", updatedInput: toolInput, toolUseID: opts?.toolUseID });
    }
    // dontAsk (background jobs): nobody answers, so what allowedTools doesn't allow is denied at once.
    if (meta.permissionMode === "dontAsk") {
      const message = `Not allowed here: ${toolName} isn't among this thread's allowed tools, and nobody answers.`;
      return Promise.resolve({ behavior: "deny", message, toolUseID: opts?.toolUseID });
    }
    const requestId = newId("r");
    const inputText = JSON.stringify(toolInput ?? {});
    const entry = {
      type: "approval",
      requestId,
      kind,
      tool: toolName,
      toolUseId: opts?.toolUseID ?? null,
      input: inputText.length > TOOL_INPUT_MAX ? { _truncated: truncate(inputText, TOOL_INPUT_MAX) } : toolInput,
      title: opts?.title ?? null,
      reason: opts?.decisionReason ?? null,
      blockedPath: opts?.blockedPath ?? null,
      ...(kind === "question" ? { questions: normalizeQuestions(toolInput) } : {}),
      ...(kind === "plan" ? { plan: String(toolInput?.plan ?? "") } : {}),
      canAlwaysAllow: kind === "permission",
    };
    return new Promise((resolve) => {
      let finished = false;
      const finish = (answer) => {
        if (finished) return;
        finished = true;
        live.approvals.delete(requestId);
        opts?.signal?.removeEventListener?.("abort", onAbort);
        const result = this.permissionResult(meta, live, entry, toolInput, opts, answer);
        this.addEntry(meta, {
          type: "approval_answer",
          requestId,
          decision: answer.decision,
          ...(answer.message ? { message: answer.message } : {}),
          ...(answer.answers ? { answers: answer.answers } : {}),
          ...(answer.reason ? { reason: answer.reason } : {}),
        });
        const pending = (meta.pendingApprovals ?? []).filter((r) => r !== requestId);
        this.store.updateThread(meta.id, {
          pendingApprovals: pending,
          ...(live.turnActive && !pending.length && meta.status === "waiting" ? { status: "running" } : {}),
        });
        this.hub.emit("claude:approval", { kind: "resolved", thread: meta.id, requestId, decision: answer.decision });
        this.emitThread(meta);
        resolve(result);
      };
      const onAbort = () => finish({ decision: "deny", message: "Cancelled", reason: "cancelled" });
      if (opts?.signal?.aborted) return onAbort();
      opts?.signal?.addEventListener?.("abort", onAbort);
      live.approvals.set(requestId, { kind, resolve: finish, entry });
      this.addEntry(meta, entry);
      this.store.updateThread(meta.id, { status: "waiting", pendingApprovals: [...(meta.pendingApprovals ?? []), requestId] });
      this.hub.emit("claude:approval", { kind: "request", thread: meta.id, threadTitle: meta.title, projectId: meta.projectId, approval: entry });
      this.emitThread(meta);
      const asks = { question: "Claude asks you", plan: "Claude has a plan for you", permission: "Claude needs your permission" };
      this.notifyUser(meta, `${asks[kind]}: ${meta.title}`, "warning");
    });
  }

  permissionResult(meta, live, entry, toolInput, opts, answer) {
    const toolUseID = opts?.toolUseID;
    if (answer.decision === "deny") {
      return {
        behavior: "deny",
        message: answer.message?.trim() || (entry.kind === "plan" ? "The user wants changes to the plan." : "The user declined this."),
        ...(answer.interrupt ? { interrupt: true } : {}),
        toolUseID,
      };
    }
    if (entry.kind === "question") {
      const answers = {};
      for (const [q, a] of Object.entries(answer.answers ?? {})) answers[q] = Array.isArray(a) ? a.join(", ") : String(a);
      return { behavior: "allow", updatedInput: { ...toolInput, answers }, toolUseID };
    }
    if (entry.kind === "plan") {
      // Approving the plan leaves plan mode; Claude Code switches the session's mode itself.
      const next = meta.planReturnMode || "default";
      this.store.updateThread(meta.id, { permissionMode: next });
      void live.query.setPermissionMode(next).catch(() => {});
      return { behavior: "allow", updatedInput: toolInput, toolUseID };
    }
    if (answer.decision === "allow_always") {
      const updates = (opts?.suggestions ?? []).map((s) => ({ ...s, destination: "session" }));
      if (!updates.length) updates.push({ type: "addRules", rules: [{ toolName: entry.tool }], behavior: "allow", destination: "session" });
      const rules = new Set(meta.allowRules ?? []);
      for (const u of updates) {
        if (u.type === "addRules" && u.behavior === "allow") {
          for (const r of u.rules ?? []) rules.add(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
        }
      }
      this.store.updateThread(meta.id, { allowRules: [...rules] });
      return { behavior: "allow", updatedInput: toolInput, updatedPermissions: updates, toolUseID, decisionClassification: "user_permanent" };
    }
    return { behavior: "allow", updatedInput: toolInput, toolUseID, decisionClassification: "user_temporary" };
  }

  // ---------------------------------------------------------------- messages in

  saveImages(meta, images) {
    const saved = [];
    for (const img of images ?? []) {
      const mediaType = img.mediaType || img.media_type || "image/png";
      if (!IMAGE_TYPES.has(mediaType)) throw new Error(`Images must be PNG, JPEG, GIF or WebP, not ${mediaType}`);
      const data = String(img.data ?? "").replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(data, "base64");
      if (!buffer.length) throw new Error("An image is empty");
      if (buffer.length > IMAGE_MAX_BYTES) throw new Error("An image is larger than 5 MB");
      const ext = mediaType.split("/")[1].replace("jpeg", "jpg");
      const name = `${newId("img")}.${ext}`;
      this.store.saveAttachment(meta.id, name, buffer);
      saved.push({ name, mediaType });
    }
    return saved;
  }

  /** The SDK user message for text and images (new ones as base64, or ones saved before). */
  userMessage(meta, { text, images, savedImages }, priority) {
    const saved = savedImages ?? this.saveImages(meta, images);
    const body = String(text ?? "");
    const content = [];
    for (const img of saved) {
      const data = this.store.readAttachment(meta.id, img.name).toString("base64");
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data } });
    }
    const dir = saved.length ? this.store.attachmentsDir(meta.id) : null;
    const pathsNote = saved.length
      ? `\n\n(Attached image${saved.length > 1 ? "s" : ""} saved at: ${saved.map((i) => path.join(dir, i.name)).join(", ")})`
      : "";
    const fullText = body + pathsNote;
    const sdk = {
      type: "user",
      message: { role: "user", content: saved.length ? [...content, { type: "text", text: fullText.trim() || "(image)" }] : body },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    };
    return { sdk, text: body, images: saved };
  }

  // ---------------------------------------------------------------- notifications

  /**
   * A layr notification that a thread finished or waits for the user; not for archived threads, nor for background
   * ones (permission mode dontAsk: a pipeline's scouts, refiner, orchestrator), nor when the plugin's setting
   * `notifications` is off.
   */
  notifyUser(meta, text, kind) {
    if (meta.archived || meta.permissionMode === "dontAsk") return;
    void this.notificationsOn().then((on) => on && this.hub.notify(text, kind));
  }

  /** The setting `notifications` (default on), asked at most every 15 s. */
  async notificationsOn() {
    const now = Date.now();
    if (this.notifySetting && now - this.notifySetting.at < 15_000) return this.notifySetting.on;
    let on = true;
    try {
      if ((await this.hub.settingsGet("notifications")) === false) on = false;
    } catch {
      // a core without plugin settings: on
    }
    this.notifySetting = { on, at: now };
    return on;
  }

  // ---------------------------------------------------------------- slash commands

  /** Claude Code's slash commands for the thread's folder ([{name, description, argumentHint}]), or null. */
  commandsFor(meta) {
    return meta.slashCommands ?? this.commandsByCwd.get(meta.cwd) ?? null;
  }

  setCommands(meta, commands) {
    const list = (commands ?? [])
      .map((c) =>
        typeof c === "string"
          ? { name: c, description: "", argumentHint: "" }
          : { name: String(c?.name ?? ""), description: String(c?.description ?? ""), argumentHint: String(c?.argumentHint ?? "") },
      )
      .map((c) => ({ ...c, name: c.name.replace(/^\//, "") }))
      .filter((c) => c.name);
    if (!list.length) return;
    this.store.updateThread(meta.id, { slashCommands: list });
    this.commandsByCwd.set(meta.cwd, list);
  }

  // ---------------------------------------------------------------- events

  addEntry(meta, entry) {
    const full = this.store.append(meta.id, entry);
    this.hub.emit(`claude:thread.${meta.id}`, { kind: "entry", entry: full });
    return full;
  }

  emitEntry(id, entry) {
    if (!entry) return;
    this.hub.emit(`claude:thread.${id}`, { kind: "entry", entry });
  }

  emitThread(meta) {
    const summary = this.summary(meta);
    this.hub.emit(`claude:thread.${meta.id}`, { kind: "status", thread: summary });
    this.hub.emit("claude:threads", { kind: "thread", thread: summary });
    for (const check of this.watchers.get(meta.id) ?? []) check();
  }

  touch(meta, patch = {}) {
    this.store.updateThread(meta.id, { ...patch, lastActivity: nowIso() });
  }

  bufferDelta(id, key, block, text) {
    if (!text) return;
    let buf = this.deltaBuffers.get(id);
    if (!buf) {
      buf = { items: new Map(), timer: setTimeout(() => this.flushDeltas(id), DELTA_FLUSH_MS) };
      this.deltaBuffers.set(id, buf);
    }
    const item = buf.items.get(key);
    if (item) item.text += text;
    else buf.items.set(key, { key, block, text });
  }

  flushDeltas(id) {
    const buf = this.deltaBuffers.get(id);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.deltaBuffers.delete(id);
    if (buf.items.size) this.hub.emit(`claude:thread.${id}`, { kind: "delta", deltas: [...buf.items.values()] });
  }

  /** The backend stops: running turns are marked to be picked up again at the next start (recover). */
  async shutdown() {
    for (const id of [...this.lives.keys()]) {
      const meta = this.store.thread(id);
      const live = this.lives.get(id);
      if (meta && live?.turnActive) {
        this.store.updateThread(id, {
          status: "interrupted",
          pendingApprovals: [],
          restartResume: { at: nowIso(), waiting: meta.status === "waiting" },
        });
        // The query ending below isn't the turn failing.
        live.turnActive = false;
      }
      this.closeLive(id, "shutdown");
    }
    this.store.saveIndexNow();
  }
}

/** What a turn picked up again after a restart starts with (the lost background tasks' note goes in front of it). */
export function restartNote(at, waiting) {
  const when = Number.isNaN(Date.parse(at)) ? "" : ` at ${new Date(at).toLocaleString("en-GB", { hour12: false })}`;
  return (
    `[layr: the Claude engine restarted${when} while you were working on this, which cut your turn off: what you ` +
    "were running then (commands, tools, subagents) was stopped, and its results may be missing. Carry on where you " +
    "left off. First check what was already done (files, git status, the output of what you ran) instead of " +
    "assuming, and don't redo finished steps." +
    (waiting ? " You were waiting for the user's permission or answer then: ask again if you still need it." : "") +
    "]"
  );
}

function isSessionGone(text) {
  return /No conversation found|session .*not found|no such session/i.test(String(text ?? ""));
}

function normalizeQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.map((q) => ({
    question: String(q.question ?? ""),
    header: q.header ? String(q.header) : null,
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).map((o) =>
      typeof o === "string" ? { label: o, description: "" } : { label: String(o.label ?? ""), description: String(o.description ?? "") },
    ),
  }));
}

function preview(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

function round(n, digits) {
  if (typeof n !== "number") return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
