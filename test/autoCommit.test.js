// Unit test of commits by themselves (backend/autoCommit.js), without Claude: plugin repositories get a commit
// after a turn, other repositories never do, conflicts are left alone. Run: node test/autoCommit.test.js
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { autoCommit, commitMessage, initPluginRepo, lastPrompt, trailerLines } from "../backend/autoCommit.js";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-autocommit-"));

// A new plugin folder: a repository with an empty first commit.
const plugin = path.join(tmp, "my-plugin");
mkdirSync(plugin);
check(await initPluginRepo(plugin, "my-plugin"), "initPluginRepo makes a repository");
check(git(plugin, "log", "--format=%s|%an") === "New plugin my-plugin|layr", "first commit", git(plugin, "log", "--format=%s|%an"));
check((await initPluginRepo(plugin, "my-plugin")) === false, "not twice");

// No layr.json yet: not a plugin's repository, nothing happens.
writeFileSync(path.join(plugin, "notes.txt"), "x");
check((await autoCommit(plugin, { prompt: "hi" })) === null, "no layr.json: no commit");

// A turn wrote the plugin: one commit by layr (Claude), message from the prompt, body from the reply.
writeFileSync(path.join(plugin, "layr.json"), '{"id":"my-plugin","name":"Mine","version":"0.1.0"}\n');
mkdirSync(path.join(plugin, "panels"));
writeFileSync(path.join(plugin, "panels", "main.html"), "<p>hi</p>\n");
const prompt = "Please make a counter plugin\nwith a big button";
const done = await autoCommit(path.join(plugin, "panels"), { prompt, reply: "I made a counter." });
check(Boolean(done?.commit), "commits after a turn", done);
check(git(plugin, "log", "-1", "--format=%s|%an <%ae>") === "Please make a counter plugin|layr (Claude) <claude@layr.invalid>",
  "subject and author", git(plugin, "log", "-1", "--format=%s|%an <%ae>"));
check(git(plugin, "log", "-1", "--format=%b") === "I made a counter.", "body is the reply");
check(git(plugin, "status", "--porcelain") === "", "nothing left over");
check((await autoCommit(plugin, { prompt: "again" })) === null, "no changes: no commit");

// 0.3.14: the thread and the turn go into the message as git trailers, and the answer has the short sha.
writeFileSync(path.join(plugin, "panels", "main.html"), "<p>hi there</p>\n");
const traced = await autoCommit(plugin, { prompt: "Say hi there", reply: "Done.", thread: "t_abc123", turn: 3 });
check(traced?.short === traced?.commit?.slice(0, 7), "short sha", traced);
const trailers = git(plugin, "log", "-1",
  "--format=%(trailers:key=Layr-Thread,valueonly)|%(trailers:key=Layr-Turn,valueonly)");
check(trailers.replace(/\s+/g, "") === "t_abc123|3", "Layr-Thread and Layr-Turn trailers", trailers);
check(git(plugin, "log", "-1", "--format=%s") === "Say hi there", "subject unchanged by the trailers");
check(trailerLines({}) === "" && trailerLines({ thread: "t_x" }) === "Layr-Thread: t_x", "no thread: no trailers");

// A repository that only holds plugins inside it (a monorepo): never committed by itself.
const mono = path.join(tmp, "mono");
mkdirSync(path.join(mono, "plugins", "x"), { recursive: true });
git(tmp, "init", "-q", mono);
writeFileSync(path.join(mono, "plugins", "x", "layr.json"), "{}");
check((await autoCommit(path.join(mono, "plugins", "x"), { prompt: "edit" })) === null, "monorepo: no commit");
check(git(mono, "status", "--porcelain") !== "", "monorepo changes stay uncommitted");

// Conflicts: left for the user (or the next turn) to resolve.
git(plugin, "checkout", "-q", "-b", "other");
writeFileSync(path.join(plugin, "panels", "main.html"), "<p>other</p>\n");
git(plugin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "other");
git(plugin, "checkout", "-q", "main");
writeFileSync(path.join(plugin, "panels", "main.html"), "<p>main</p>\n");
git(plugin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "main");
try {
  git(plugin, "merge", "other");
} catch {}
const conflicted = await autoCommit(plugin, { prompt: "merge" });
check(conflicted?.skipped === "conflicts", "conflicts: skipped", conflicted);
// Resolved (markers gone) but neither staged nor committed: the merge commit is made.
writeFileSync(path.join(plugin, "panels", "main.html"), "<p>both</p>\n");
const merged = await autoCommit(plugin, { prompt: "Resolve the merge" });
check(Boolean(merged?.commit) && git(plugin, "rev-list", "--parents", "-n1", "HEAD").split(" ").length === 3,
  "a resolved merge is committed as a merge", merged);

// Messages.
const long = commitMessage("word ".repeat(30), "");
check(long.subject.length <= 72 && long.subject.endsWith("…"), "long prompts are cut", long.subject);
check(commitMessage("", "").subject === "Changes by Claude", "empty prompt");
check(lastPrompt([{ type: "user", text: "a" }, { type: "text", text: "b" }, { type: "user", text: "c", parent: "x" }]) === "a",
  "last top-level prompt");

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
