// Write a demo project and threads into a data dir, to look at the panels without spending Claude usage.
//   node dev/fixtures.js <dataDir>      then: node dev/devserver.js --data <dataDir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.argv[2] ?? path.join(here, "..", ".dev-data"));
const pluginDir = path.resolve(here, "..");
mkdirSync(path.join(dataDir, "threads"), { recursive: true });

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const project = { id: "p_demo", name: "layr_flutter", path: path.resolve(pluginDir, "..", ".."), defaultModel: "sonnet", defaultEffort: null, defaultPermissionMode: "default", createdAt: ago(600) };
const project2 = { id: "p_demo2", name: "recipes-app", path: pluginDir, defaultModel: null, defaultEffort: null, defaultPermissionMode: null, createdAt: ago(900) };
writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify([project, project2], null, 2));

function meta(id, o) {
  return {
    id, projectId: project.id, title: "Thread", kind: "thread", cwd: project.path,
    workspace: { kind: "project", path: project.path, branch: "main" }, model: "sonnet", effort: null, thinking: true,
    permissionMode: "default", sessionId: "00000000-0000-4000-8000-000000000000", sessionStarted: true, systemAppend: null,
    allowRules: [], queue: [], queuePaused: false, pendingApprovals: [], todos: [], status: "done", turns: 1, costUsd: 0.0412,
    contextTokens: 18234, preview: "", error: null, archived: false, createdAt: ago(60), updatedAt: ago(2), lastActivity: ago(2), extra: null, ...o,
  };
}

const todos = [
  { content: "Read the panel code", status: "completed", activeForm: "Reading the panel code" },
  { content: "Add the sort button", status: "completed", activeForm: "Adding the sort button" },
  { content: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
  { content: "Update the docs", status: "pending", activeForm: "Updating the docs" },
];

const demo = [
  { type: "created", title: "Add sorting to the notes list", workspace: { kind: "worktree", path: "C:\\code\\.layr-worktrees\\layr_flutter-notes-sorting", branch: "layr/notes-sorting" }, model: "sonnet" },
  { type: "user", text: "Add a sort button to the notes list: newest first by default, and alphabetical as the other option. Keep it small." },
  { type: "turn_start", turn: 1, model: "claude-sonnet-5-5" },
  { type: "thinking", id: "m1:0", text: "The user wants a **sort toggle** on the notes list. I should look at `plugins/notes/panels/main.js` first to see how the list renders, then add a small button in the toolbar." },
  { type: "text", id: "m1:1", text: "I'll look at how the notes list is built first." },
  { type: "tool_use", id: "tu1", name: "TodoWrite", input: { todos: todos.map((t, i) => ({ ...t, status: i === 0 ? "in_progress" : "pending" })) } },
  { type: "tool_result", id: "tu1", content: "Todos updated", isError: false },
  { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "C:\\code\\layr_flutter\\plugins\\notes\\panels\\main.js" } },
  { type: "tool_result", id: "tu2", content: "1\timport { h } from './ui.js';\n2\t\n3\texport function renderList(notes) {\n4\t  return notes.map(noteRow);\n5\t}", isError: false },
  { type: "tool_use", id: "tu3", name: "Grep", input: { pattern: "renderList", path: "plugins/notes" } },
  { type: "tool_result", id: "tu3", content: "plugins/notes/panels/main.js:3\nplugins/notes/panels/app.js:41", isError: false },
  { type: "tool_use", id: "tu4", name: "Edit", input: { file_path: "C:\\code\\layr_flutter\\plugins\\notes\\panels\\main.js", old_string: "export function renderList(notes) {\n  return notes.map(noteRow);\n}", new_string: "export function renderList(notes, sort = \"newest\") {\n  const sorted = [...notes].sort(sort === \"az\"\n    ? (a, b) => a.title.localeCompare(b.title)\n    : (a, b) => b.updatedAt - a.updatedAt);\n  return sorted.map(noteRow);\n}" } },
  { type: "approval", requestId: "r_demo1", kind: "permission", tool: "Edit", toolUseId: "tu4", input: {}, title: null, reason: null, canAlwaysAllow: true },
  { type: "approval_answer", requestId: "r_demo1", decision: "allow" },
  { type: "tool_result", id: "tu4", content: "The file main.js has been updated.", isError: false },
  { type: "tool_use", id: "tu5", name: "Bash", input: { command: "pnpm test --filter notes", description: "Run the notes tests" } },
  { type: "approval", requestId: "r_demo2", kind: "permission", tool: "Bash", toolUseId: "tu5", input: {}, canAlwaysAllow: true },
  { type: "approval_answer", requestId: "r_demo2", decision: "allow_always" },
  { type: "tool_result", id: "tu5", content: "FAIL  notes/sort.test.js\n  ✕ keeps pinned notes on top (4 ms)\n\nTests: 1 failed, 11 passed", isError: true },
  { type: "text", id: "m2:0", text: "One test failed: pinned notes should stay on top. I'll keep them first in both orders.\n\n```js\nconst sorted = [...notes].sort((a, b) => (b.pinned - a.pinned) || compare(a, b));\n```" },
  { type: "tool_use", id: "tu6", name: "TodoWrite", input: { todos } },
  { type: "tool_result", id: "tu6", content: "ok", isError: false },
  { type: "tool_use", id: "tu7", name: "mcp__layr__notes__list", input: { limit: 3 } },
  { type: "tool_result", id: "tu7", content: "[{\"title\":\"Groceries\"},{\"title\":\"Ideas\"}]", isError: false },
  { type: "text", id: "m3:0", text: "Done. The list now has a **Sort** button:\n\n| Order | What it does |\n| --- | --- |\n| Newest | most recently changed first (default) |\n| A–Z | alphabetical by title |\n\nPinned notes stay on top in both. All 12 tests pass." },
  { type: "turn_end", turn: 1, status: "done", costUsd: 0.0412, durationMs: 48200, usage: { inputTokens: 1200, outputTokens: 2300, cacheReadTokens: 15000, cacheWriteTokens: 2000 } },
  { type: "user", text: "Nice. Can you also ask me which icon to use?" },
  { type: "turn_start", turn: 2 },
  { type: "approval", requestId: "r_demo3", kind: "question", tool: "AskUserQuestion", toolUseId: "tu8", input: {}, questions: [{ question: "Which icon should the sort button use?", header: "Icon", multiSelect: false, options: [{ label: "Arrows", description: "Two arrows, up and down" }, { label: "Funnel", description: "Like a filter" }, { label: "Text only", description: "Just the word Sort" }] }] },
];

const thread1 = meta("t_demo1", { title: "Add sorting to the notes list", workspace: { kind: "worktree", path: "C:\\code\\.layr-worktrees\\layr_flutter-notes-sorting", branch: "layr/notes-sorting" }, todos, status: "interrupted", turns: 2, preview: "Done. The list now has a Sort button" });
const thread2 = meta("t_demo2", { title: "Why does the relay drop messages on reconnect?", status: "failed", error: "Claude Code stopped", lastActivity: ago(80), preview: "Looking at relay.rs" });
const thread3 = meta("t_demo3", { title: "Plugin: Lab notebook", kind: "plugin", status: "done", lastActivity: ago(300), preview: "Your lab notebook is ready in the Tools menu." });
const thread4 = meta("t_demo4", { projectId: project2.id, title: "Import recipes from a URL", status: "waiting", pendingApprovals: ["r_x"], lastActivity: ago(1), preview: "Claude wants to run a command", workspace: { kind: "worktree", path: "C:\\x", branch: "layr/import-url" } });
const thread5 = meta("t_demo5", { projectId: project2.id, title: "Tidy the CSS", status: "running", lastActivity: ago(0.2), preview: "Reading styles.css", queue: [{ id: "q1", text: "also check dark mode", images: [], at: ago(0.1) }] });

const index = Object.fromEntries([thread1, thread2, thread3, thread4, thread5].map((t) => [t.id, t]));
writeFileSync(path.join(dataDir, "threads", "index.json"), JSON.stringify(index));
let seq = 0;
const lines = demo.map((e, i) => JSON.stringify({ seq: ++seq, ts: ago(60 - i), ...e }));
writeFileSync(path.join(dataDir, "threads", "t_demo1.jsonl"), `${lines.join("\n")}\n`);
for (const t of [thread2, thread3, thread4, thread5]) {
  writeFileSync(path.join(dataDir, "threads", `${t.id}.jsonl`), `${JSON.stringify({ seq: 1, ts: ago(90), type: "user", text: t.title })}\n`);
}
console.log(`fixtures written to ${dataDir}`);
