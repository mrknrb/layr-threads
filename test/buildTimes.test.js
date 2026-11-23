// Build times (backend/buildTimes.js) without Claude: which commands are kept and as what kind, timing live tool calls
// (approvals, timeouts moved to the background, background runs), the import from Claude Code's transcripts, and the
// summary. Run: node test/buildTimes.test.js
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BuildTimes, commandKind, movedToBackground, parseTaskNotice, runKind } from "../backend/buildTimes.js";

const BACKSLASH = String.fromCharCode(92);
const win = (p) => p.replaceAll("/", BACKSLASH);

test("build times: commands and their kinds", () => {
  const cases = [
    ["cd core && cargo test 2>&1 | tail -20", "cargo test"],
    ["cargo test -q; cargo clippy --all-targets -- -D warnings", "cargo clippy + cargo test"],
    ["cargo nextest run", "cargo test"],
    [`& "${win("C:/src/flutter/bin/flutter.bat")}" analyze`, "flutter analyze"],
    ["Set-Location app; flutter test", "flutter test"],
    [win(".\\scripts/build.ps1"), "build.ps1"],
    [`powershell -NoProfile -File ${win("scripts/build.ps1")} -Apk`, "build.ps1"],
    ['powershell -NoProfile -Command "cargo build --release"', "cargo build"],
    ["pnpm --filter web test", "pnpm test"],
    ["pnpm build", "pnpm run build"],
    ["npm run build && npm ci)", "npm install + npm run build"],
    ["for p in a b; do (cd plugins/$p && npm test); done", "npm test"],
    ["FOO=1 npx tsc --noEmit", "tsc"],
    ["python -m pytest -q", "pytest"],
    ["node test/unit.test.js", "node tests"],
    ["node test/ui.e2e.js", "e2e tests"],
    ["node --test", "node tests"],
    ["node scripts/vendor-office.mjs", "node vendor-office.mjs"],
  ];
  for (const [command, kind] of cases) assert.equal(runKind(command, 1000), kind, command);
  // Not builds: reading a script, git, waits; long ones are "other" unless they only wait.
  assert.equal(runKind("cat scripts/build.ps1", 1000), null);
  assert.equal(runKind("git status", 1000), null);
  assert.equal(runKind("git fetch origin", 25_000), "other: git");
  assert.equal(runKind("until curl -s localhost; do sleep 2; done", 60_000), null);
  assert.equal(runKind("Start-Sleep 30", 30_000), null);
  assert.equal(runKind("$sp = Get-Item x; $sp.Length", 30_000), null);
  assert.equal(runKind(`Get-Content ${win("C:/x/b8fs.output")} -Wait`, 30_000), null);
  // Dev servers and watchers never; background runs only when they build, test or check.
  assert.equal(runKind("npm run dev", 600_000), null);
  assert.equal(runKind("flutter run -d windows", 600_000), null);
  assert.equal(runKind("cargo test", 90_000, { background: true }), "cargo test");
  assert.equal(runKind("cargo run -p layr_cli -- serve", 90_000, { background: true }), null);
  assert.equal(runKind("node server.js", 90_000, { background: true }), null);
  assert.equal(commandKind("echo hi").kind, null);
});

test("build times: what results say", () => {
  assert.ok(movedToBackground("Command did not complete within its 120s timeout and was moved to the background (ID: b1)."));
  assert.ok(!movedToBackground("ok   3 passed"));
  const notice = "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>";
  assert.deepEqual(parseTaskNotice(notice), { toolUseId: "toolu_9", status: "completed" });
  assert.equal(parseTaskNotice("<task-notification><task-id>b1</task-id>"), null);
});

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layr-claude-build-"));
  const home = path.join(dir, "code");
  const projects = [{ id: "p_app", name: "app", path: path.join(home, "app") }];
  const threads = {
    t_1: { id: "t_1", projectId: "p_app", title: "Task one", cwd: path.join(home, ".layr-worktrees", "app-1-one"), sessionId: "s1" },
  };
  const store = { projects, threads, findProject: (id) => projects.find((p) => p.id === id) ?? null };
  let now = Date.parse("2026-11-01T10:00:00Z");
  const clock = { tick: (ms) => (now += ms) };
  const bt = new BuildTimes({ dataDir: dir, store, now: () => now });
  return { dir, home, store, bt, clock, meta: threads.t_1 };
}

const call = (id, command, extra = {}) => ({ type: "tool_use", id, name: "Bash", input: { command, ...extra } });

test("build times: live runs, approvals, timeouts and background runs", () => {
  const { dir, store, bt, clock, meta } = setup();
  bt.toolStarted(meta, call("a", "cargo test"));
  clock.tick(90_000);
  bt.toolFinished("a", "test result: ok", false);
  bt.toolStarted(meta, call("b", "flutter analyze"));
  clock.tick(5 * 60_000); // waits for the user's approval: not counted
  bt.toolApproved("b");
  clock.tick(40_000);
  bt.toolFinished("b", "1 issue found", true);
  bt.toolStarted(meta, call("c", "git status"));
  clock.tick(500);
  bt.toolFinished("c", "clean", false);
  bt.toolStarted(meta, { type: "tool_use", id: "d", name: "Read", input: { file_path: "x" } });
  bt.toolFinished("d", "text", false);
  // Past its timeout: kept as timed out at once, its real end comes with the background notice.
  bt.toolStarted(meta, call("e", "cargo clippy"));
  clock.tick(120_000);
  bt.toolFinished("e", "Command did not complete within its 120s timeout and was moved to the background (ID: b2).", false);
  assert.equal(bt.runs.get("e").status, "timeout");
  clock.tick(60_000);
  bt.backgroundDone("e", "completed");
  // Started in the background: kept when its notice comes; a dev server never.
  bt.toolStarted(meta, call("f", "npm test", { run_in_background: true }));
  clock.tick(100);
  bt.toolFinished("f", "Command running in background with ID: b3", false);
  assert.ok(!bt.runs.has("f"));
  clock.tick(30_000);
  bt.backgroundDone("f", "failed");
  bt.toolStarted(meta, call("g", "npm run dev", { run_in_background: true }));
  bt.toolFinished("g", "Command running in background with ID: b4", false);
  clock.tick(3_600_000);
  bt.backgroundDone("g", "stopped");
  // The session ended before the result: its time is unknown.
  bt.toolStarted(meta, call("h", "cargo build"));
  clock.tick(10_000);
  bt.toolFinished("h", "[Tool call interrupted: the session ended before this call's result was recorded]", true);

  const runs = Object.fromEntries([...bt.runs.values()].map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(runs).sort(), ["a", "b", "e", "f"]);
  assert.equal(runs.a.ms, 90_000);
  assert.equal(runs.a.status, "ok");
  assert.equal(runs.a.projectId, "p_app");
  assert.equal(runs.a.thread, "t_1");
  assert.equal(runs.b.ms, 40_000);
  assert.equal(runs.b.status, "failed");
  assert.equal(runs.e.ms, 180_000);
  assert.equal(runs.e.status, "ok");
  assert.equal(runs.e.timedOut, true);
  assert.equal(runs.f.background, true);
  assert.equal(runs.f.status, "failed");

  // Saved: a new start reads them back, the later line of "e" in place of its first.
  const again = new BuildTimes({ dataDir: dir, store });
  assert.equal(again.runs.size, 4);
  assert.equal(again.runs.get("e").ms, 180_000);
});

test("build times: the summary per project, cold first runs apart", () => {
  const { bt, clock, meta } = setup();
  const run = (id, command, ms, cwd = meta.cwd) => {
    bt.toolStarted({ ...meta, cwd }, call(id, command));
    clock.tick(ms);
    bt.toolFinished(id, "ok", false);
  };
  run("1", "cargo test", 300_000);
  run("2", "cargo test", 60_000);
  run("3", "cargo test", 80_000);
  run("4", "cargo test", 200_000, path.join(path.dirname(meta.cwd), "app-2-two"));
  run("5", "flutter test", 30_000);
  const s = bt.summary();
  assert.equal(s.projects.length, 1);
  const p = s.projects[0];
  assert.equal(p.name, "app");
  assert.equal(p.runs, 5);
  assert.equal(p.totalMs, 670_000);
  const cargo = p.kinds.find((k) => k.kind === "cargo test");
  assert.equal(cargo.runs, 4);
  assert.equal(cargo.medianMs, 140_000);
  assert.equal(cargo.maxMs, 300_000);
  assert.equal(cargo.firstRuns, 2, "the first in each worktree");
  assert.equal(cargo.firstMedianMs, 250_000);
  assert.equal(cargo.laterMedianMs, 70_000);
  assert.equal(p.kinds[0].kind, "cargo test", "the most time first");
  assert.equal(p.threads[0].title, "Task one");
  assert.equal(p.recent[0].kind, "flutter test");
  assert.equal(bt.summary({ project: "nope" }).projects.length, 0);
  assert.equal(bt.summary({ project: "APP" }).projects.length, 1);
  assert.equal(bt.summary({ kind: "flutter test" }).projects[0].runs, 1);
  clock.tick(10 * 86_400_000);
  assert.equal(bt.summary({ days: 1 }).projects.length, 0);
});

test("build times: past runs from Claude Code's transcripts, each once", async () => {
  const { dir, bt } = setup();
  const root = path.join(dir, "projects");
  const folder = path.join(root, "C--code--layr-worktrees-app-1-one");
  mkdirSync(path.join(folder, "s1", "subagents"), { recursive: true });
  const t = (s) => new Date(Date.parse("2026-10-01T08:00:00Z") + s * 1000).toISOString();
  const line = (o) => JSON.stringify(o);
  const use = (id, s, command, extra = {}) =>
    line({ type: "assistant", timestamp: t(s), sessionId: "s1", cwd: "x",
      message: { content: [{ type: "tool_use", id, name: "PowerShell", input: { command, ...extra } }] } });
  const result = (id, s, text, isError = false) =>
    line({ type: "user", timestamp: t(s), sessionId: "s1",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
  const lines = [
    line({ type: "user", timestamp: t(0), sessionId: "s1", message: { content: "Fix the build" } }),
    use("u1", 1, "cargo test"),
    result("u1", 91, "ok"),
    use("u2", 100, "flutter analyze"),
    result("u2", 220, "Command did not complete within its 120s timeout and was moved to the background (ID: b9)."),
    line({ type: "queue-operation", timestamp: t(280), content: "<task-notification>\n<task-id>b9</task-id>\n" +
      "<tool-use-id>u2</tool-use-id>\n<status>completed</status>" }),
    use("u3", 300, "cargo build"),
    result("u3", 320, "[Tool call interrupted: the session ended before this call's result was recorded]", true),
  ];
  writeFileSync(path.join(folder, "s1.jsonl"), lines.join("\n") + "\n");
  writeFileSync(path.join(folder, "s1", "subagents", "agent-1.jsonl"),
    [use("u4", 10, "npm test"), result("u4", 40, "fail", true)].join("\n") + "\n");

  const r = await bt.importTranscripts(root);
  assert.deepEqual({ files: r.files, added: r.added }, { files: 2, added: 3 });
  const runs = Object.fromEntries([...bt.runs.values()].map((x) => [x.id, x]));
  assert.equal(runs.u1.ms, 90_000);
  assert.equal(runs.u1.source, "import");
  assert.equal(runs.u1.thread, "t_1", "the layr thread with that session");
  assert.equal(runs.u1.projectId, "p_app");
  assert.equal(runs.u2.ms, 180_000);
  assert.equal(runs.u2.timedOut, true);
  assert.equal(runs.u2.status, "ok");
  assert.equal(runs.u4.status, "failed");
  assert.ok(!runs.u3);
  // Unchanged files aren't read again; reading all of them again adds nothing twice.
  assert.equal((await bt.importTranscripts(root)).files, 0);
  assert.equal((await bt.importTranscripts(root, { force: true })).added, 0);
  assert.equal(bt.runs.size, 3);
  assert.equal(bt.importState().files, 2);
});

test("build times: a folder that is no layr project is named from its path", () => {
  const { bt } = setup();
  assert.equal(bt.projectOf(path.join(os.tmpdir(), ".layr-worktrees", "shop-12-cart")).project, "shop");
  assert.equal(bt.projectOf(path.join(os.tmpdir(), "notes")).project, "notes");
  assert.equal(bt.projectOf(path.join(os.tmpdir(), "notes", ".claude", "worktrees", "agent-a4e9")).project, "notes");
});

test("build times: an imported run counts where its session started, not in the subfolder it went to", async () => {
  const { dir, bt } = setup();
  const root = path.join(dir, "projects");
  const start = path.join(os.tmpdir(), "shop");
  mkdirSync(path.join(root, "shop"), { recursive: true });
  const at = (s) => new Date(Date.parse("2026-10-02T08:00:00Z") + s * 1000).toISOString();
  writeFileSync(path.join(root, "shop", "s9.jsonl"), [
    { type: "user", timestamp: at(0), sessionId: "s9", cwd: start, message: { content: "Build it" } },
    { type: "assistant", timestamp: at(1), sessionId: "s9", cwd: path.join(start, "src-tauri"),
      message: { content: [{ type: "tool_use", id: "v1", name: "Bash", input: { command: "cargo build" } }] } },
    { type: "user", timestamp: at(61), sessionId: "s9", cwd: path.join(start, "src-tauri"),
      message: { content: [{ type: "tool_result", tool_use_id: "v1", content: "Finished" }] } },
  ].map((o) => JSON.stringify(o)).join("\n"));
  await bt.importTranscripts(root);
  const run = bt.runs.get("v1");
  assert.equal(run.project, "shop");
  assert.equal(run.cwd, start);
  assert.equal(run.title, "Build it");
  assert.equal(bt.projectOf(path.join(os.tmpdir(), ".t3", "scratch", "2026-10-11-try-a-thing-1a2b")).project, "scratch");
});
