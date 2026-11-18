// End-to-end test of the backend with real Claude Code (small: haiku, low effort, tiny prompts).
// Starts the MCP server over stdio with a fake hub, as the core would, then: a thread in a temp git repo with an
// approval, a queued message, an image, a question, a worktree thread, an interrupt, and a resume after the backend
// restarts. Run: node test/backend.test.js   (LAYR_TEST_SKIP=question,image,... skips steps)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { startFakeHub } from "../dev/fakehub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const skip = new Set(String(process.env.LAYR_TEST_SKIP ?? "").split(",").filter(Boolean));
const MODEL = process.env.LAYR_TEST_MODEL || "haiku";
let failures = 0;

function step(name) {
  console.log(`\n=== ${name}`);
}
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
  return ok;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-test-"));
const repo = path.join(tmp, "repo");
const dataDir = path.join(tmp, "data");
execFileSync("git", ["init", "-q", repo]);
writeFileSync(path.join(repo, "README.md"), "# Test repo\n");
execFileSync("git", ["-C", repo, "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
console.log(`temp: ${tmp}`);

const hub = await startFakeHub();
const topicsSeen = new Map();
hub.events.on("event", (topic, data) => {
  const key = `${topic.replace(/thread\.t_\w+/, "thread.<id>")}:${data?.kind ?? ""}`;
  topicsSeen.set(key, (topicsSeen.get(key) ?? 0) + 1);
});

let transport = null;
async function startBackend() {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginDir, "backend", "server.js")],
    cwd: pluginDir,
    env: { ...process.env, LAYR_HUB_URL: hub.url, LAYR_HUB_TOKEN: hub.pluginToken, LAYR_DATA_DIR: dataDir, LAYR_PLUGIN_ID: "claude", LAYR_DEVICE: "test", LAYR_CLAUDE_WORKTREES: path.join(tmp, "worktrees"), LAYR_CLAUDE_PLUGINS_DIR: path.join(tmp, "plugins"), LAYR_CLAUDE_RESUME_DELAY_MS: "1500",
      // Not the PC's own Claude Code transcripts (build times' first import): the test's timing stays its own.
      LAYR_CLAUDE_BUILD_IMPORT: "0" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => {
    const s = String(d);
    if (process.env.LAYR_TEST_VERBOSE || /error|fail|uncaught/i.test(s)) process.stderr.write(`  [backend] ${s}`);
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  return client;
}

let client = await startBackend();
async function call(name, args = {}, { allowError = false } = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
  if (r.isError && !allowError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  if (r.isError) return { error: r.content?.[0]?.text };
  return r.structuredContent ?? JSON.parse(r.content[0].text);
}

/** Wait until the thread settles; answer approvals with `onApproval` (returns the answer args) on the way. */
async function runToEnd(thread, onApproval, timeoutSec = 240) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const w = await call("thread_wait", { thread, timeoutSec: Math.max(5, Math.round((deadline - Date.now()) / 1000)) });
    if (w.thread.status === "waiting") {
      const st = await call("thread_status", { thread });
      for (const a of st.approvals) {
        const answer = onApproval ? onApproval(a) : { decision: "allow" };
        console.log(`  approval ${a.kind} ${a.tool} → ${answer.decision}`);
        await call("answer_approval", { thread, requestId: a.requestId, ...answer });
      }
      continue;
    }
    if (w.timedOut || Date.now() > deadline) return { ...w, timedOut: true };
    return w;
  }
}

try {
  step("projects");
  const { project } = await call("project_add", { path: repo, defaultModel: MODEL, defaultEffort: "low" });
  check(project.git === true && project.defaultModel === MODEL, "project_add", project.name);
  const pl = await call("projects_list");
  check(pl.projects.length === 1, "projects_list has it");
  const ml = await call("models_list");
  check(ml.models.some((m) => m.id === "haiku" || m.id === "opus"), "models_list", ml.models.map((m) => m.id).slice(0, 6).join(","));

  step("thread with an approval");
  const approvalsSeen = [];
  hub.events.on("event", (topic, data) => topic === "claude:approval" && data.kind === "request" && approvalsSeen.push(data.approval));
  const { thread } = await call("thread_start", {
    project: project.id,
    prompt: "Create a file hello.txt containing exactly: hi\nUse the Write tool. Then reply with one word: done.",
  });
  check(thread.id.startsWith("t_") && thread.workspace.kind === "project", "thread_start", `${thread.id} ${thread.workspace.branch}`);
  const end1 = await runToEnd(thread.id, (a) => ({ decision: a.tool === "Write" ? "allow_always" : "allow" }));
  check(end1.thread.status === "done", "turn ended done", end1.thread.status + (end1.thread.error ? ` ${end1.thread.error}` : ""));
  const hello = path.join(repo, "hello.txt");
  check(existsSync(hello) && readFileSync(hello, "utf8").trim() === "hi", "hello.txt contains hi", existsSync(hello) ? readFileSync(hello, "utf8") : "missing");
  check(approvalsSeen.length >= 1 && approvalsSeen[0].tool === "Write", "claude:approval event for Write", approvalsSeen.map((a) => a.tool));
  const read1 = await call("thread_read", { thread: thread.id });
  check(read1.messages.some((m) => m.role === "tool" && /Write/.test(m.text)), "thread_read shows the Write call");
  const tr = await call("thread_transcript", { thread: thread.id });
  const types = new Set(tr.entries.map((e) => e.type));
  check(["created", "user", "turn_start", "tool_use", "tool_result", "approval", "approval_answer", "turn_end"].every((t) => types.has(t)), "transcript entry types", [...types]);
  check(tr.entries.at(-1).type === "turn_end" && typeof tr.entries.at(-1).costUsd === "number", "turn_end has cost", tr.entries.at(-1).costUsd);
  check((topicsSeen.get("claude:thread.<id>:delta") ?? 0) > 0, "text deltas streamed as events", topicsSeen.get("claude:thread.<id>:delta"));
  check(existsSync(path.join(dataDir, "threads", `${thread.id}.jsonl`)), "transcript file on disk");
  const tokenCalls = hub.calls.filter((c) => c.name === "layr__agent_token");
  const labels = tokenCalls.map((c) => c.args.label);
  check(labels.includes(thread.id), "the thread's agent token is labelled with its id", labels);
  const titled = tokenCalls.find((c) => c.args.label === thread.id);
  const title = titled?.args.title;
  check(typeof title === "string" && title.length > 0, "and titled with its title", titled?.args);

  step("queue while a turn runs");
  const s1 = await call("thread_send", { thread: thread.id, text: "Reply with just the word one." });
  const s2 = await call("thread_send", { thread: thread.id, text: "Reply with just the word two." });
  check(s1.sent === "turn" && s2.sent === "queued", "first starts a turn, second is queued", `${s1.sent}/${s2.sent}`);
  let end2 = await runToEnd(thread.id);
  // The first turn ended; the queued one starts right after it.
  for (let i = 0; i < 3 && (end2.thread.queue.length || end2.thread.status === "running"); i++) end2 = await runToEnd(thread.id);
  const read2 = await call("thread_read", { thread: thread.id, limit: 10 });
  const assistantTexts = read2.messages.filter((m) => m.role === "assistant").map((m) => m.text.toLowerCase());
  check(assistantTexts.some((t) => t.includes("one")) && assistantTexts.some((t) => t.includes("two")), "both messages answered", assistantTexts.slice(-3));

  step("notifications, slash commands, changes");
  check(hub.notifications.some((n) => /Claude finished/.test(n.text)), "a finished turn notifies", hub.notifications.map((n) => n.text));
  check(hub.notifications.some((n) => /needs your permission/.test(n.text)), "a permission request notifies");
  const cmds = await call("thread_commands", { thread: thread.id });
  check(cmds.known && cmds.commands.some((c) => c.name === "compact"), "thread_commands lists Claude Code's commands",
    cmds.commands.slice(0, 8).map((c) => c.name));
  check(cmds.commands.some((c) => c.description), "with descriptions");
  if (!skip.has("compact")) {
    await call("thread_send", { thread: thread.id, text: "/compact" });
    const endC = await runToEnd(thread.id);
    const trC = await call("thread_transcript", { thread: thread.id, limit: 20 });
    check(endC.thread.status === "done" && trC.entries.some((e) => e.type === "system" && /compacted/i.test(e.text ?? "")),
      "a typed /compact compacts", trC.entries.slice(-5).map((e) => `${e.type} ${e.text ?? e.status ?? ""}`.slice(0, 80)));
  }
  const ch = await call("thread_changes", { thread: thread.id });
  check(ch.changes && ch.changes.base === null && ch.changes.list.some((f) => f.path === "hello.txt" && f.state === "new"),
    "thread_changes: the new file in the project's own checkout", ch.changes);
  const df = await call("thread_diff", { thread: thread.id, file: "hello.txt" });
  check(/\+hi/.test(df.diff), "thread_diff of the new file");
  const stale = await call("run_in_terminal", { thread: thread.id, shell: "cmd", command: "echo hi", at: Date.now() - 120_000 }, { allowError: true });
  check(/more than a minute old/.test(stale.error ?? ""), "a stale ▶ Run click doesn't run");

  if (!skip.has("image")) {
    step("image attachment");
    const png = redPng(16);
    await call("thread_send", { thread: thread.id, text: "What color is this image? Answer with one word.", images: [{ mediaType: "image/png", data: png.toString("base64") }] });
    const end3 = await runToEnd(thread.id);
    check(/red/i.test(end3.last ?? ""), "Claude sees the image", end3.last);
    const tr3 = await call("thread_transcript", { thread: thread.id, limit: 30 });
    const withImage = tr3.entries.find((e) => e.type === "user" && e.images?.length);
    if (check(Boolean(withImage), "user entry lists the image")) {
      const att = await call("attachment_read", { thread: thread.id, name: withImage.images[0].name });
      check(att.mediaType === "image/png" && att.data.length > 10, "attachment_read gives it back");
    }
  }

  if (!skip.has("question")) {
    step("a question from Claude");
    await call("thread_send", {
      thread: thread.id,
      text:
        "This is an automated test of the app's question dialog, so for this one message I explicitly want you to call " +
        "the AskUserQuestion tool (an exception to any instruction against it): ask one question, tea or coffee, with " +
        "those two options. Then reply with only my answer.",
    });
    let asked = null;
    const end4 = await runToEnd(thread.id, (a) => {
      if (a.kind === "question") {
        asked = a;
        const q = a.questions[0];
        const coffee = q.options.find((o) => /coffee/i.test(o.label)) ?? q.options[0];
        return { decision: "allow", answers: { [q.question]: coffee.label } };
      }
      return { decision: "allow" };
    });
    if (!asked) console.log("SKIP question: Claude chose not to call AskUserQuestion (the user's CLAUDE.md forbids it)", end4.last);
    else {
      check(asked.questions?.[0]?.options?.length >= 2, "question approval with options", asked.questions?.[0]);
      check(/coffee/i.test(end4.last ?? ""), "Claude got the answer", end4.last);
    }
  }

  if (!skip.has("worktree")) {
    step("worktree thread");
    const wt = await call("thread_start", {
      project: project.id,
      prompt: "Reply with just the word ready.",
      workspace: "worktree",
      title: "Worktree check",
      permissionMode: "bypassPermissions",
    });
    const ws = wt.thread.workspace;
    check(ws.kind === "worktree" && ws.branch === "layr/worktree-check" && existsSync(ws.path), "worktree made", `${ws.branch} at ${ws.path}`);
    const trees = await call("worktrees_list", { project: project.id });
    check(trees.worktrees.some((t) => t.branch === ws.branch), "worktrees_list shows the branch");
    const endW = await runToEnd(wt.thread.id);
    check(endW.thread.status === "done" && /ready/i.test(endW.last ?? ""), "worktree thread answered", endW.last);
    const st = await call("thread_status", { thread: wt.thread.id });
    check(st.git && st.git.branch === ws.branch, "thread_status has git state", st.git);
    // An existing worktree
    const ex = await call("thread_start", { project: project.id, prompt: "Reply with just: ok", workspace: { worktreePath: ws.path }, permissionMode: "bypassPermissions" });
    check(ex.thread.workspace.path === ws.path && ex.thread.workspace.branch === ws.branch, "existing worktree workspace");
    await runToEnd(ex.thread.id);
  }

  if (!skip.has("steer")) {
    step("steer into a running turn");
    const { thread: ts } = await call("thread_start", {
      project: project.id,
      prompt: "Run the shell command: sleep 8 && echo finished  (wait for it), then reply with the word finished.",
      permissionMode: "bypassPermissions",
    });
    for (let i = 0; i < 60; i++) {
      const st = await call("thread_status", { thread: ts.id });
      if (st.thread.status === "running" && st.thread.live) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const sr = await call("thread_send", { thread: ts.id, text: "Also: end your final reply with the word pineapple.", mode: "steer" });
    check(sr.sent === "steer", "thread_send mode steer goes into the running turn", sr.sent);
    // Claude Code may answer a steer in the running turn, or in a turn right after it.
    let endS = await runToEnd(ts.id);
    await new Promise((r) => setTimeout(r, 4000));
    endS = await runToEnd(ts.id);
    const trS = await call("thread_transcript", { thread: ts.id });
    check(trS.entries.some((e) => e.type === "user" && e.steer), "steered message in the transcript");
    check(/pineapple/i.test(endS.last ?? ""), "Claude took the steer into account", endS.last);
  }

  if (!skip.has("plugin")) {
    step("make a plugin with AI");
    const pm = await call("plugin_make", {
      description: "A panel that just shows the text Hello from layr in big letters. Keep it to a layr.json and one HTML page, no backend.",
      name: "Hello big",
      model: MODEL,
      permissionMode: "bypassPermissions",
    });
    check(pm.pluginId === "hello-big" && existsSync(pm.folder), "plugin folder made", pm.folder);
    const endP = await runToEnd(pm.thread.id, undefined, 420);
    check(endP.thread.status === "done", "plugin thread done", endP.thread.status + (endP.thread.error ? ` ${endP.thread.error}` : ""));
    const manifestFile = path.join(pm.folder, "layr.json");
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch {}
    check(Boolean(manifest?.panels?.length), "layr.json with a panel", manifest ? `${manifest.id}: ${manifest.panels?.map((x) => x.page).join(",")}` : "missing");
    if (manifest?.panels?.[0]?.page) check(existsSync(path.join(pm.folder, manifest.panels[0].page)), "its page exists");
    await new Promise((r) => setTimeout(r, 1500));
    check(hub.linked.includes(pm.folder), "linked into layr (layr__packages_link)", hub.linked.join(", "));
  }

  if (!skip.has("interrupt")) {
    step("interrupt");
    const { thread: t2 } = await call("thread_start", {
      project: project.id,
      prompt: "Write the numbers from 1 to 400, one per line, as plain text. No tools.",
      permissionMode: "bypassPermissions",
    });
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      const tr2 = await call("thread_transcript", { thread: t2.id, limit: 5 });
      if (topicsSeen.get("claude:thread.<id>:delta") && tr2.thread.status === "running" && Date.now() - start > 4000) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const ir = await call("thread_interrupt", { thread: t2.id });
    check(ir.interrupted === true, "thread_interrupt accepted");
    const endI = await call("thread_wait", { thread: t2.id, timeoutSec: 60 });
    check(endI.thread.status === "interrupted", "status interrupted", endI.thread.status);
  }

  step("restart the backend and resume");
  await client.close();
  await new Promise((r) => setTimeout(r, 1500));
  client = await startBackend();
  const lst = await call("thread_list", { project: project.id });
  check(lst.threads.some((t) => t.id === thread.id), "thread_list after restart", lst.threads.map((t) => `${t.title}:${t.status}`));
  await call("thread_send", { thread: thread.id, text: "What is the name of the file you created at the start? Reply with only the file name." });
  const endR = await runToEnd(thread.id);
  check(endR.thread.status === "done" && /hello\.txt/i.test(endR.last ?? ""), "resumed session remembers", endR.last);

  if (!skip.has("kill")) {
    step("the backend is killed mid-turn; the turn goes on by itself");
    const marker = path.join(repo, "survived.txt");
    const { thread: tk } = await call("thread_start", {
      project: project.id,
      prompt:
        "Do these two steps in order. 1. Run this shell command and wait for it to finish: sleep 15 (with the Bash " +
        "tool; on PowerShell: Start-Sleep 15). 2. Then create the file survived.txt containing exactly: yes. " +
        "Reply with one word: done.",
      permissionMode: "bypassPermissions",
    });
    let sleeping = false;
    for (let i = 0; i < 120 && !sleeping; i++) {
      const tr = await call("thread_transcript", { thread: tk.id, limit: 50 });
      sleeping = tr.entries.some((e) => e.type === "tool_use" && /sleep/i.test(JSON.stringify(e.input ?? {})));
      if (!sleeping) await new Promise((r) => setTimeout(r, 500));
    }
    check(sleeping, "the turn runs its command");
    await new Promise((r) => setTimeout(r, 2000));
    const before = (await call("thread_status", { thread: tk.id })).thread;
    // As a crash would: no shutdown, nothing saved on the way out.
    process.kill(transport.pid, "SIGKILL");
    await client.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    check(!existsSync(marker), "nothing finished it while the backend was down");
    const leftovers = claudeProcessesOf(before.sessionId);
    if (leftovers !== null) {
      for (let i = 0; i < 20 && claudeProcessesOf(before.sessionId) > 0; i++) await new Promise((r) => setTimeout(r, 500));
      check(claudeProcessesOf(before.sessionId) === 0, "the old Claude Code process ended with the backend", leftovers);
    }
    client = await startBackend();
    const st = (await call("thread_status", { thread: tk.id })).thread;
    check(st.status === "starting" && st.resuming === true, "after the restart it waits to be picked up", st.status);
    const endK = await runToEnd(tk.id, undefined, 300);
    check(endK.thread.status === "done", "the turn was picked up and finished by itself", `${endK.thread.status} ${endK.last ?? ""}`);
    check(existsSync(marker) && /yes/.test(readFileSync(marker, "utf8")), "it did the rest of the work (survived.txt)");
    check(endK.thread.sessionId !== before.sessionId, "in a fork of the session", `${before.sessionId} → ${endK.thread.sessionId}`);
    const trK = await call("thread_transcript", { thread: tk.id });
    check(trK.entries.some((e) => e.type === "system" && e.subtype === "restart"), "the transcript says it restarted");
    check(trK.entries.some((e) => e.type === "user" && e.auto === "restart"), "and that layr picked it up again");
    const sleeps = trK.entries.filter((e) => e.type === "tool_use" && /sleep/i.test(JSON.stringify(e.input ?? {}))).length;
    console.log(`  the sleep ran ${sleeps} time(s); last reply: ${endK.last}`);
  }

  step("archive");
  const ar = await call("thread_archive", { thread: thread.id });
  check(ar.thread.archived === true, "archived");
  const visible = await call("thread_list", {});
  check(!visible.threads.some((t) => t.id === thread.id), "archived thread hidden from the list");

  step("usage");
  const u = await call("usage", {});
  check(u.account !== undefined, "usage answers", { account: u.account?.subscription ?? null, fiveHour: u.limits?.fiveHour?.utilization ?? null });

  console.log("\nevents seen:", Object.fromEntries(topicsSeen));
} catch (error) {
  failures++;
  console.error("ERROR", error);
} finally {
  await client.close().catch(() => {});
  await hub.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

/** How many processes have the session id in their command line (Windows only; null elsewhere or when unknown). */
function claudeProcessesOf(sessionId) {
  if (process.platform !== "win32" || !sessionId) return null;
  try {
    const script = `@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${sessionId}*' }).Count`;
    return Number(execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim());
  } catch {
    return null;
  }
}

/** A solid red PNG, size×size. */
function redPng(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
