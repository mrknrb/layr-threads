#!/usr/bin/env node
// layr plugin "claude": layr's own Claude Code engine. An MCP server on stdio (the core is its client): its tools
// are what the panels, other plugins (a pipeline) and agents use to run Claude Code threads.
// Contract: docs/ARCHITECTURE.md > The MCP hub. Environment: LAYR_HUB_URL, LAYR_HUB_TOKEN, LAYR_DATA_DIR...
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Account } from "./account.js";
import { autoCommit, initPluginRepo, lastPrompt } from "./autoCommit.js";
import { Engine, PERMISSION_MODES } from "./engine.js";
import { isGitRepo, listWorktrees, worktreeStatus } from "./git.js";
import { Hub } from "./hub.js";
import { linkIfReady, newPluginFolder, pluginSystemPrompt, pluginsRoot } from "./pluginMaker.js";
import { Store } from "./store.js";
import { errorMessage, isDirectory, log, truncate } from "./util.js";

const dataDir = process.env.LAYR_DATA_DIR || path.join(os.homedir(), ".layr-claude-dev");
const store = new Store(dataDir);
const hub = new Hub({ url: process.env.LAYR_HUB_URL, token: process.env.LAYR_HUB_TOKEN });
const account = new Account();
const engine = new Engine({ store, hub, account });

// After each turn that ends well: what it changed in a plugin's own repository is committed (autoCommit.js), then
// plugin-maker threads link their folder into layr.
engine.onTurnEnded = (meta, status) => {
  if (status !== "done") return;
  void commitTurn(meta).finally(() => {
    if (meta.kind === "plugin") linkPluginFolder(meta);
  });
};

async function commitTurn(meta) {
  if (process.env.LAYR_CLAUDE_AUTOCOMMIT === "0" || !meta.cwd) return;
  try {
    const prompt = lastPrompt(store.readTranscript(meta.id));
    const done = await autoCommit(meta.cwd, { prompt, reply: engine.lastReply(meta.id) });
    if (!done?.commit) return;
    log(`saved ${done.files} file(s) in ${done.top}: ${done.subject}`);
    const entry = store.append(meta.id, { type: "system", text: `Saved as a version (My plugins > History): ${done.subject}` });
    hub.emit(`claude:thread.${meta.id}`, { kind: "entry", entry });
  } catch (error) {
    log(`saving the changes in ${meta.cwd} failed:`, errorMessage(error));
  }
}

function linkPluginFolder(meta) {
  linkIfReady(hub, meta.cwd)
    .then((info) => {
      if (!info) return;
      const first = !meta.extra?.linked;
      store.updateThread(meta.id, { extra: { ...(meta.extra ?? {}), linked: true, pluginId: info.id ?? meta.extra?.pluginId } });
      if (first) {
        const entry = store.append(meta.id, { type: "system", text: `The plugin is in layr now: ${info.name ?? info.id ?? meta.cwd}` });
        hub.emit(`claude:thread.${meta.id}`, { kind: "entry", entry });
        hub.notify(`New plugin: ${info.name ?? info.id}`, "success");
      }
    })
    .catch((error) => log(`linking ${meta.cwd} failed:`, errorMessage(error)));
}

const server = new McpServer({ name: "claude", version: "0.1.0" }, { capabilities: { tools: {} } });

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
  "default: ask before edits and commands; acceptEdits: edit files without asking; bypassPermissions: never ask; plan: plan first, no changes",
);
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const images = z
  .array(z.object({ mediaType: z.string().describe("image/png, image/jpeg, image/gif or image/webp"), data: z.string().describe("base64 (a data: URL is fine)") }))
  .describe("Images to send with the text");
const threadId = z.string().describe("Thread id (thread_list)");

// ------------------------------------------------------------------ projects

tool("projects_list", "The project folders Claude threads work in, with their default model, effort and permission mode.", {}, () => ({
  projects: store.projects.map((p) => ({
    ...p,
    exists: isDirectory(p.path),
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
    hub.emit("claude:threads", { kind: "projects" });
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
    hub.emit("claude:threads", { kind: "projects" });
    return { project };
  },
);

tool("project_remove", "Take a project off the list (its folder and threads stay).", { project: z.string() }, (a) => {
  const project = store.removeProject(a.project);
  hub.emit("claude:threads", { kind: "projects" });
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
    "The turn runs on; follow it with thread_wait or the claude:thread.<id> events.",
  {
    project: z.string().describe("Project id, name or folder (a folder that isn't a project yet is added)"),
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
    title: z.string().optional(),
    images: images.optional(),
  },
  (a) => engine.startThread(a).then((thread) => ({ thread })),
);

tool(
  "thread_send",
  "Send a message to a thread. Idle: starts a turn. While a turn runs: mode queue (default) sends it after the turn, " +
    "mode steer puts it into the running turn now.",
  { thread: threadId, text: z.string(), mode: z.enum(["queue", "steer"]).optional(), images: images.optional() },
  (a) => engine.send(a.thread, { text: a.text, images: a.images, mode: a.mode }),
);

tool("thread_interrupt", "Stop the thread's running turn (the session stays; queued messages wait).", { thread: threadId }, (a) =>
  engine.interrupt(a.thread),
);

tool(
  "thread_list",
  "Threads, latest activity first, with status: running, waiting (for an approval or answer), done, failed, interrupted.",
  {
    project: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    archived: z.union([z.boolean(), z.literal("all")]).optional(),
    query: z.string().optional().describe("Words in the title, last message or branch"),
  },
  (a) => ({ threads: engine.list(a) }),
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

tool("thread_status", "One thread's state: status, workspace and branch, model, pending approvals, queue, todos, cost.", { thread: threadId }, async (a) => {
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
  "thread_update",
  "Change a thread's title, model, effort, thinking or permission mode (a running session switches model and mode at once).",
  {
    thread: threadId,
    title: z.string().optional(),
    model: z.string().nullable().optional(),
    effort: effort.nullable().optional(),
    thinking: z.boolean().optional(),
    permissionMode: permissionMode.optional(),
  },
  (a) => engine.update(a.thread, a).then((thread) => ({ thread })),
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

// ------------------------------------------------------------------ plugin maker

tool(
  "plugin_make",
  "Make a layr plugin with AI from a plain-words description: starts a thread in a new folder under " +
    "~/layr-plugins that writes it and links it into layr. Gives the thread and the folder.",
  {
    description: z.string().describe("What the plugin should do, in plain words"),
    name: z.string().optional(),
    id: z.string().optional(),
    model: z.string().optional(),
    permissionMode: permissionMode.optional().describe("Default acceptEdits: files without asking, commands ask"),
    images: images.optional(),
  },
  async (a) => {
    const { id, folder, root } = newPluginFolder(a);
    // Its history starts now (a repository with an empty first commit); Claude's turns are saved into it.
    await initPluginRepo(folder, id).catch((error) => log(`git init in ${folder} failed:`, errorMessage(error)));
    const project = store.addProject({ path: root, name: "My layr plugins" });
    const prompt = `${a.name ? `Name: ${a.name}\n\n` : ""}Please make this layr plugin for me:\n\n${a.description}`;
    const thread = await engine.startThread({
      project: project.id,
      prompt,
      images: a.images,
      model: a.model,
      permissionMode: a.permissionMode || "acceptEdits",
      workspace: { path: folder },
      title: `Plugin: ${a.name || truncate(a.description, 40)}`,
      kind: "plugin",
      systemAppend: pluginSystemPrompt({ id, folder }),
      extra: { pluginId: id, folder },
    });
    return { thread, folder, pluginId: id };
  },
);

tool("plugins_folder", "Where new plugins made with AI go.", {}, () => ({ folder: pluginsRoot() }));

// ------------------------------------------------------------------ helpers

/** Transcript entries as short messages for agents. */
function compact(entries) {
  const out = [];
  const tools = new Map();
  for (const e of entries) {
    if (e.parent) continue;
    if (e.type === "user") out.push({ seq: e.seq, role: "user", text: e.text + (e.images?.length ? ` [${e.images.length} image(s)]` : "") });
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
  log(`claude backend up (data ${dataDir}, hub ${hub.available ? "on" : "off"})`);
  // Learn the models in the background, so the first thread start doesn't wait for it.
  setTimeout(() => void account.listModels().catch(() => {}), 2000).unref?.();
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
