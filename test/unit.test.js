// Unit tests without Claude: the reply box parser and its answer picks, folding turns, drafts, the terminal scripts,
// and the Changes drawer's git side (base branch detection) in temporary repositories. Run: node test/unit.test.js
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
