// Unit tests without Claude: the reply box parser and its answer picks, folding turns, drafts, the terminal scripts,
// and the Changes drawer's git side (base branch detection) in temporary repositories. Run: node test/unit.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Account } from "../backend/account.js";
import { contextFill, contextWindowFor, reportedWindow } from "../backend/engine.js";
import { baseRef, parseNumstat, threadChanges, fileDiff } from "../backend/changes.js";
import { checkFresh, scriptFor, shellOf, terminalEnv } from "../backend/terminal.js";
import {
  AGREE_TEXT,
  NONE,
  answerPrefix,
  chosenOf,
  parseBoxes,
  pickIn,
  questionsOf,
  splitStatusLine,
  toggleAgree,
} from "../panels/boxes.js";
import { createDraftStore, isBlankDraft } from "../panels/drafts.js";
import { foldLabel, foldTurn, groupRuns, summarize, tokensLabel } from "../panels/folds.js";

const REPLY = `## Summary
- The answers you pick are sent first

## Changes
- Answers you pick are sent first
  The composer puts "1B, 3C" in front of what you type.
  - Example: you pick C for question 2 and type "go"
  - Why: fewer words

## Questions
1. 4 ⚪ Where should the rules live?
   - A. ⭐ Global CLAUDE.md (90%) **every project reads it**
   - B. The repo's CLAUDE.md (60%) **only this project**
2. ☑️ 🚩 9 🔴 Which panels should draw boxes?
   - A. ⭐ T3 threads (90%) **most replies are there**
   - B. ⭐ AI chats (80%) **same rules apply**
   - C. Pipeline inbox (50%) **short replies only**

Status: asks · Risk: database, ui · Try: ready`;

test("boxes: sections, items, extras, status line", () => {
  const sections = parseBoxes(REPLY);
  assert.ok(sections);
  assert.deepEqual(sections.map((s) => s.kind), ["summary", "changes", "questions", null]);
  const item = sections[1].parts[0].items[0];
  assert.equal(item.short, "Answers you pick are sent first");
  assert.match(item.long, /The composer puts/);
  assert.deepEqual(item.extras.map((e) => e.label), ["Example", "Why"]);
  assert.deepEqual(sections[3].parts[0], { type: "status", status: "asks", risks: ["database", "ui"], try: "ready" });
});

test("boxes: questions, options, stars, scores, multiple choice", () => {
  const qs = questionsOf(parseBoxes(REPLY));
  assert.equal(qs.length, 2);
  assert.equal(qs[0].number, 1);
  assert.equal(qs[0].multi, false);
  assert.equal(qs[0].text, "4 ⚪ Where should the rules live?");
  assert.deepEqual(qs[0].options[0], { letter: "A", text: "Global CLAUDE.md", why: "every project reads it", starred: true, score: 90 });
  assert.equal(qs[0].options[1].starred, false);
  assert.equal(qs[1].multi, true);
  assert.equal(qs[1].text, "🚩 9 🔴 Which panels should draw boxes?");
  assert.deepEqual(chosenOf(qs[1], undefined), ["A", "B"]);
});

test("boxes: a plain message is not boxed; the status line alone is split", () => {
  assert.equal(parseBoxes("Just a reply.\n\n- a list"), null);
  assert.equal(parseBoxes("## Something else\ntext"), null);
  assert.deepEqual(splitStatusLine("hi\nStatus: done · Risk: none · Try: none").status, { status: "done", risks: [], try: "none" });
  assert.equal(splitStatusLine("no status here").status, null);
});

test("boxes: picks make the prefix", () => {
  const qs = questionsOf(parseBoxes(REPLY));
  let picked = {};
  assert.equal(answerPrefix(qs, picked), "");
  picked = toggleAgree(picked);
  assert.equal(answerPrefix(qs, picked), AGREE_TEXT);
  picked = pickIn(picked, qs[0], "B");
  assert.equal(answerPrefix(qs, picked), "My answers: 1B. Everything else as recommended.");
  picked = pickIn(picked, qs[1], "C");
  picked = pickIn(picked, qs[1], "A");
  assert.equal(answerPrefix(qs, picked), "My answers: 1B, 2AC. Everything else as recommended.");
  picked = pickIn(picked, qs[1], NONE);
  assert.equal(answerPrefix(qs, picked), "My answers: 1B, 2 None of them. Everything else as recommended.");
  // Picking the starred answer itself says nothing of its own.
  picked = pickIn({}, qs[0], "A");
  assert.equal(answerPrefix(qs, picked), "");
  // Clicking a picked answer takes it back.
  picked = pickIn(pickIn({}, qs[0], "B"), qs[0], "B");
  assert.equal(answerPrefix(qs, picked), "");
  // None of them only for multiple choice.
  assert.equal(answerPrefix(qs, pickIn({}, qs[0], NONE)), "");
});

const work = (name) => ({ kind: "tool", name });
const end = (status, extra = {}) => ({ kind: "end", entry: { status, durationMs: 192_000, usage: { inputTokens: 1000,
  cacheReadTokens: 770_000, cacheWriteTokens: 6000, outputTokens: 2900 }, ...extra } });

test("folds: a finished turn folds its work, keeps the final reply and what must stay", () => {
  const items = [work("Read"), { kind: "thinking" }, { kind: "text" }, work("Bash"), { kind: "kept" }, { kind: "text" },
    end("done")];
  const fold = foldTurn(items);
  assert.deepEqual([...fold.hidden].sort(), [0, 1, 2, 3, 6]);
  assert.equal(fold.label, "Worked for 3m 12s · 777k tokens in · 2.9k out");
  // Not ended: nothing folds. Nothing but a reply: nothing to fold.
  assert.equal(foldTurn(items.slice(0, -1)), null);
  assert.equal(foldTurn([{ kind: "text" }, end("done")]), null);
  // A stopped turn keeps its end line.
  const stopped = foldTurn([work("Read"), { kind: "text" }, end("interrupted", { durationMs: 40_000, usage: null })]);
  assert.deepEqual([...stopped.hidden], [0]);
  assert.equal(stopped.label, "You stopped it after 40s");
  assert.equal(foldLabel({ status: "failed" }), "Failed");
  assert.equal(tokensLabel({ inputTokens: 0, outputTokens: 0 }), "");
});

test("folds: runs of tool calls group, with a summary", () => {
  const items = [work("Read"), work("Read"), work("Bash"), { kind: "text" }, work("Edit"), { kind: "text" }, work("Grep"),
    work("Glob")];
  const rows = groupRuns(items);
  assert.deepEqual(rows.map((r) => r.type), ["group", "item", "item", "item", "group"]);
  assert.equal(rows[0].label, "Read 2 files, ran 1 command");
  assert.equal(rows[4].label, "2 searches");
  // Live: the latest call stays out of its group.
  const live = groupRuns(items, { live: true });
  assert.deepEqual(live.slice(-2).map((r) => r.type), ["item", "item"]);
  assert.equal(summarize([{ kind: "thinking" }, { kind: "thinking" }]), "Thought ×2");
});

test("drafts: saved after a pause, in order, blank ones deleted", async () => {
  const db = new Map();
  const data = {
    get: async (k) => db.get(k) ?? null,
    set: async (k, v) => void db.set(k, v),
    delete: async (k) => void db.delete(k),
  };
  const store = createDraftStore(data, { delayMs: 10 });
  assert.equal(isBlankDraft({ text: "  ", picks: { replyId: "x", picked: {} } }), true);
  assert.equal(isBlankDraft({ text: "", answers: { r1: { 0: { picked: [], own: "mine" } } } }), false);
  store.save("t1", { text: "hel" });
  store.save("t1", { text: "hello", picks: { replyId: "r", picked: { 1: ["B"] } } });
  const loaded = await store.load("t1");
  assert.equal(loaded.text, "hello");
  assert.deepEqual(loaded.picks.picked, { 1: ["B"] });
  store.save("t1", { text: "" });
  await store.flush();
  assert.equal(await store.load("t1"), null);
  store.save("t2", { text: "x" });
  await store.clear("t2");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(db.has("drafts/t2"), false);
});

test("terminal: shells, scripts, fresh clicks, clean environment", () => {
  assert.equal(shellOf("PowerShell"), "powershell");
  assert.equal(shellOf("sh"), "bash");
  assert.equal(shellOf("js"), null);
  assert.equal(shellOf("constructor"), null);
  const ps = scriptFor("powershell", "echo 'hi'\nnpm test");
  assert.match(ps, /Write-Host '> echo ''hi''' -ForegroundColor Cyan/);
  assert.match(ps, /\r\nnpm test\r\n/);
  assert.match(scriptFor("bash", "ls"), /exec bash --login -i/);
  assert.match(scriptFor("cmd", "dir"), /^@chcp 65001/);
  assert.throws(() => checkFresh(Date.now() - 61_000), /more than a minute old/);
  assert.doesNotThrow(() => checkFresh(Date.now() - 5_000));
  assert.throws(() => checkFresh(undefined));
  const env = terminalEnv({ X: "1" }, { PATH: "p", LAYR_HUB_TOKEN: "secret", npm_config_x: "y", NODE_ENV: "production" });
  assert.deepEqual(env, { PATH: "p", X: "1" });
});

test("changes: numstat with renames and binaries", () => {
  const out = "3\t1\ta.txt\0-\t-\timg.png\0" + "2\t0\t\0old.txt\0new.txt\0";
  assert.deepEqual(parseNumstat(out), [
    { path: "a.txt", added: 3, removed: 1 },
    { path: "img.png", added: 0, removed: 0 },
    { path: "new.txt", added: 2, removed: 0 },
  ]);
});

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

test("changes: base branch detection and a worktree's changes", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-unit-"));
  const repo = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  // A dev branch a commit ahead of main: work that left dev is measured against dev.
  git(repo, "branch", "dev");
  git(repo, "checkout", "-q", "dev");
  writeFileSync(path.join(repo, "d.txt"), "dev\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "dev work");
  git(repo, "checkout", "-q", "main");
  const tree = path.join(tmp, "wt");
  git(repo, "worktree", "add", "-q", "-b", "layr/x", tree, "dev");
  writeFileSync(path.join(tree, "a.txt"), "one\nTWO\nthree\n");
  git(tree, "commit", "-q", "-am", "change a");
  writeFileSync(path.join(tree, "d.txt"), "dev\nmore\n");
  writeFileSync(path.join(tree, "new.txt"), "n1\nn2\n");
  assert.equal(await baseRef(tree), "dev");
  const c = await threadChanges(tree);
  assert.equal(c.branch, "layr/x");
  assert.equal(c.base, "dev");
  assert.equal(c.commits, 1);
  assert.deepEqual({ files: c.files, added: c.added, removed: c.removed }, { files: 3, added: 5, removed: 1 });
  assert.deepEqual(c.uncommitted, { files: 2, added: 3, removed: 0 });
  assert.deepEqual(Object.fromEntries(c.list.map((f) => [f.path, f.state])), { "a.txt": "committed", "d.txt": "uncommitted", "new.txt": "new" });
  assert.equal(c.behind, 0);
  assert.deepEqual(c.conflicts, []);
  assert.match(await fileDiff(tree, "a.txt"), /\+TWO/);
  assert.match(await fileDiff(tree, "new.txt"), /\+n2/);
  await assert.rejects(fileDiff(tree, "../x"));
  // dev moves on with a conflicting change: behind 1, a.txt conflicts.
  git(repo, "checkout", "-q", "dev");
  writeFileSync(path.join(repo, "a.txt"), "one\nzwei\n");
  git(repo, "commit", "-q", "-am", "dev changes a");
  git(repo, "checkout", "-q", "main");
  const later = await threadChanges(tree);
  assert.equal(later.behind, 1);
  if (later.conflicts !== null) assert.deepEqual(later.conflicts, ["a.txt"]);
  // The project's own checkout: only what isn't committed.
  writeFileSync(path.join(repo, "a.txt"), "changed\n");
  const own = await threadChanges(repo);
  assert.equal(own.base, null);
  assert.equal(own.files, 1);
  assert.equal(await threadChanges(tmp), null);
});

// ------------------------------------------------------------------ context fill

test("context fill: used / window, the window as Claude Code reported it, else by the model", () => {
  assert.equal(contextFill({ contextTokens: null, model: "opus" }), null);
  assert.deepEqual(contextFill({ contextTokens: 50_000, model: "sonnet" }), { tokens: 50_000, window: 200_000, percent: 25 });
  assert.equal(contextFill({ contextTokens: 50_000, resolvedModel: "claude-opus-4-6[1m]" }).window, 1_000_000);
  assert.equal(contextFill({ contextTokens: 50_000, model: "opus[1m]" }).percent, 5);
  const reported = { contextTokens: 120_000, resolvedModel: "claude-x", contextWindow: { model: "claude-x", tokens: 400_000 } };
  assert.equal(contextFill(reported).percent, 30);
  // Reported for another model (switched since): by the name again.
  assert.equal(contextFill({ ...reported, resolvedModel: "claude-y" }).window, 200_000);
  assert.equal(contextFill({ contextTokens: 900_000, model: "haiku" }).percent, 100);
  const usage = { "claude-haiku-4-5": { contextWindow: 200_000 }, "claude-opus-4-6[1m]": { contextWindow: 1_000_000 } };
  assert.equal(reportedWindow(usage, "claude-opus-4-6[1m]"), 1_000_000);
  assert.equal(reportedWindow(usage, "claude-opus-4-6"), 1_000_000);
  assert.equal(reportedWindow(usage, "claude-sonnet-4-6"), null);
  assert.equal(reportedWindow({}, "x"), null);
  assert.equal(contextWindowFor("claude-sonnet-4-6"), 200_000);
});

// ------------------------------------------------------------------ the account: switching accounts

test("account: a switched login drops the old account's limits and refusal at once and reads fresh", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layr-claude-account-"));
  const config = path.join(dir, ".claude.json");
  const signIn = (email, at) => {
    writeFileSync(config, JSON.stringify({ oauthAccount: { emailAddress: email }, projects: {} }));
    utimesSync(config, at, at);
  };
  signIn("a@example.com", new Date(Date.now() - 60_000));
  const changes = [];
  const account = new Account({ configPath: config, onAccountChanged: (email) => changes.push(email) });
  let probes = 0;
  // Claude Code isn't started: a probe "measures" the account the config names.
  account.probe = async ({ withUsage } = {}) => {
    probes++;
    account.noteAccount(account.liveEmail());
    account.account = { email: account.liveEmail(), subscriptionType: "max" };
    if (withUsage) {
      account.usageCheckedAt = Date.now();
      account.setUsage({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: "x" } } });
    }
  };
  await account.usage();
  assert.equal(probes, 1);
  // Account A hits its limit: refused until its reset.
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  account.setRateLimit({ status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: reset });
  assert.ok(account.limits.rejectedUntil);
  assert.equal(account.limits.fiveHour.utilization, 100);
  const cached = await account.usage();
  assert.equal(probes, 1, "within 5 minutes the reading is kept");
  assert.ok(cached.limits.rejectedUntil);
  // The accounts plugin switches the live login to B.
  signIn("b@example.com", new Date());
  assert.equal(account.checkAccount(), true, "the switch is seen");
  assert.deepEqual(changes, ["b@example.com"]);
  assert.equal(account.limits.rejectedUntil, null, "A's refusal is gone at once");
  assert.equal(account.limits.fiveHour, null, "and A's windows");
  const fresh = await account.usage();
  assert.equal(probes, 2, "B is measured fresh, not after 5 minutes");
  assert.equal(fresh.account.email, "b@example.com");
  assert.equal(fresh.limits.rejectedUntil, null);
  assert.equal(fresh.limits.fiveHour.utilization, 12);
  // Seen by a rate limit event itself, without the watch: back to A, whose refusal is A's again.
  signIn("a@example.com", new Date(Date.now() + 1000));
  account.setRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: reset });
  assert.equal(account.limitsAccount, "a@example.com");
  assert.ok(account.limits.rejectedUntil);
  assert.equal(account.limits.fiveHour.utilization, null, "B's 12% isn't carried over");
  // An unreadable or half-written config keeps the last account (no false switch).
  writeFileSync(config, "{ half");
  utimesSync(config, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  assert.equal(account.checkAccount(), false);
  assert.ok(account.limits.rejectedUntil);
});

test("account: the watch sees a switch by itself", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layr-claude-account-"));
  const config = path.join(dir, ".claude.json");
  writeFileSync(config, JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } }));
  utimesSync(config, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const changes = [];
  const account = new Account({ configPath: config, onAccountChanged: (email) => changes.push(email) });
  account.probe = async () => {};
  account.limits.rejectedUntil = new Date(Date.now() + 3_600_000).toISOString();
  account.watch(20);
  assert.ok(account.limits.rejectedUntil, "the first look only learns the account");
  writeFileSync(config, JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } }));
  await new Promise((r) => setTimeout(r, 100));
  account.stopWatching();
  assert.equal(account.limits.rejectedUntil, null);
  assert.equal(changes[0], "b@example.com");
});

test("restoreWorktree and restoreWorkspace: a removed worktree comes back in its folder, from the newest base", async () => {
  const { restoreWorktree } = await import("../backend/git.js");
  const { Engine } = await import("../backend/engine.js");
  const { Store } = await import("../backend/store.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-restore-"));
  const repo = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const folder = path.join(tmp, "trees", "repo-x");
  git(repo, "worktree", "add", "-q", "-b", "layr/x", folder, "main");
  writeFileSync(path.join(folder, "b.txt"), "b\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "work");
  git(repo, "merge", "-q", "--ff-only", "layr/x");
  writeFileSync(path.join(repo, "c.txt"), "c\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "later on main");
  const newest = git(repo, "rev-parse", "main").trim();
  // Merged, removed, branch kept: it moves up to the newest main.
  git(repo, "worktree", "remove", "--force", folder);
  const kept = await restoreWorktree({ projectPath: repo, folder, branch: "layr/x", baseRef: "main" });
  assert.deepEqual([kept.branch, kept.base, kept.from], ["layr/x", newest, "main"]);
  assert.equal(git(folder, "rev-parse", "--abbrev-ref", "HEAD").trim(), "layr/x");
  // Removed with its branch: made again from main.
  git(repo, "worktree", "remove", "--force", folder);
  git(repo, "branch", "-D", "layr/x");
  const made = await restoreWorktree({ projectPath: repo, folder, branch: "layr/x", baseRef: "main" });
  assert.equal(made.base, newest);
  // A branch with work main lacks keeps it.
  writeFileSync(path.join(folder, "d.txt"), "d\n");
  git(folder, "add", ".");
  git(folder, "commit", "-q", "-m", "unmerged");
  const own = git(folder, "rev-parse", "HEAD").trim();
  git(repo, "worktree", "remove", "--force", folder);
  assert.equal((await restoreWorktree({ projectPath: repo, folder, branch: "layr/x", baseRef: "main" })).base, own);

  // The engine: a worktree thread whose folder is gone gets it back before its turn, and says so.
  git(repo, "worktree", "remove", "--force", folder);
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), "layr-claude-restore-store-")));
  const project = store.addProject({ path: repo });
  const engine = new Engine({ store, hub: { available: false, emit() {}, notify() {} }, account: { listModels: async () => [] } });
  const meta = store.createThread({
    id: "t_r", projectId: project.id, title: "T", kind: "thread", cwd: folder,
    workspace: { kind: "worktree", path: folder, branch: "layr/x", baseRef: "main" }, permissionMode: "default",
    sessionId: "s", sessionStarted: true, queue: [], queuePaused: false, pendingApprovals: [], todos: [], status: "done", turns: 1,
  });
  const note = await engine.restoreWorkspace(meta);
  assert.match(note, /made again in the same folder on layr\/x, from the newest main/);
  assert.equal(git(folder, "rev-parse", "HEAD").trim(), own);
  assert.ok(store.thread("t_r").workspace.restoredAt);
  assert.equal(await engine.restoreWorkspace(store.thread("t_r")), null, "nothing missing: nothing to do");
});
