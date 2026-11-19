// Build times: how long the builds, tests and checks that Claude runs take, per project.
//
// Every Bash or PowerShell command a thread runs is timed from when Claude Code gets it to when its result comes
// back (or, after an approval, from the approval). The ones that build, test or check (cargo, flutter, npm test,
// tsc, pytest, a build script...) are kept, sorted into kinds by commandKind(); any other command only when it took
// BUILD_OTHER_MIN_MS or more. A command that ran past its timeout is moved to the background by Claude Code: it is
// kept as timed out, and its real end comes later with the background task's notice, like a run_in_background one.
//
// Kept in <data>/build-times.jsonl, one run per line; a later line with the same id replaces the earlier one. Past
// runs come from Claude Code's own transcripts (<config>/projects/**/*.jsonl): importTranscripts() reads them, once
// on the first start and again on request, only files that grew since, and never changes them. A run's id is its
// tool call's id, so a run both recorded live and imported is kept once.
import { appendFileSync, createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { normalizePath } from "./store.js";
import { errorMessage, log, readJson, writeFileAtomic } from "./util.js";

export const BUILD_OTHER_MIN_MS = 20_000;
const COMMAND_MAX = 300;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Claude Code's folder of session transcripts. */
export function transcriptsRoot(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// ------------------------------------------------------------------ what kind of command

/** Programs that only wait (or poll in a loop), never kept as "other". */
const WAITS = new Set(["sleep", "start-sleep", "timeout", "wait-process", "wait", "read", "read-host", "until", "while",
  "tail", "get-content", "cat", "type"]);
/** Words put before the real command: `time cargo test`, `npx tsc`, `& flutter.bat analyze`, a loop's `do`. */
const PREFIXES = new Set(["time", "npx", "nice", "call", "&", "exec", "command", "measure-command", "do", "then",
  "else", "{", "("]);
/** Loop and branch heads: not a program, the next part names it. */
const CONTROL = new Set(["for", "foreach", "if", "elif", "done", "fi", "}", ")", "esac", "try", "catch", "finally", "[",
  "[[", "test", "echo", "write-host", "write-output", "printf", "ls", "dir", "pwd", "mkdir", "new-item", "export", "set"]);
/** Options that take a value, skipped when looking for the subcommand: `pnpm --filter app test`. */
const VALUED = new Set(["--filter", "-f", "-c", "--dir", "--prefix", "-w", "--workspace", "--manifest-path",
  "--target-dir", "--cwd"]);
/** What runs until it is stopped (dev servers, watchers): not a build, never kept. */
const SERVES = /^(\w+ run (dev|start|serve|server|watch|preview|storybook|emulator)\b.*|flutter run|vite)$/;
/** What a background run may be kept as: a build, test or check, not a server it started. */
const BUILDS = /(test|check|clippy|analyze|build|tsc|lint|install|e2e|compile|vitest|jest|pytest|bundle)/;
/** Longer than this, a run is a lost notice or a stuck session, not a build. */
const RUN_MAX_MS = 2 * 3_600_000;
const CHANGE_DIR = new Set(["cd", "set-location", "sl", "pushd", "push-location", "popd", "pop-location", "chdir"]);
/** pnpm, yarn and bun subcommands that are not a package script. */
const NOT_SCRIPTS = new Set(["exec", "dlx", "x", "create", "why", "list", "ls", "remove", "rm", "outdated", "audit",
  "config", "store", "link", "info", "view", "version", "-v", "--version", "help"]);
const SCRIPT_WORDS =/(build|test|check|lint|release|vendor|bundle|compile|package)/;

/** Split a command line into words, quotes taken off. */
function words(text) {
  return (text.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? []).map((w) => w.replace(/^["']+|["'()]+$/g, "")).filter(Boolean);
}

/** A program's name without its folder and extension: C:\src\flutter\bin\flutter.bat → flutter. */
function programName(word) {
  return word.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/** The kind of one simple command (no `&&`, `;` or `|` in it), or null. */
function segmentKind(segment) {
  let w = words(segment.trim().replace(/^[({]+/, ""));
  // Leading environment settings and wrappers: FOO=1, $env:FOO = 'x', time, npx, timeout 600.
  for (;;) {
    if (!w.length) return { kind: null, program: null };
    const first = w[0].toLowerCase();
    if (/^[a-z_][\w]*=/i.test(w[0])) w = w.slice(1);
    else if (first.startsWith("$") || CONTROL.has(first)) return { kind: null, program: null };
    else if (first === "timeout" && /^\d+$/.test(w[1] ?? "")) w = w.slice(2);
    else if (PREFIXES.has(first)) w = w.slice(1);
    else break;
  }
  const raw = w[0];
  const program = programName(raw);
  // A data file or a path, not a program (`b8fs4f7aj.output`): nothing to name it by.
  if (program.startsWith("-") || (/\.\w+$/.test(program) && !/\.(ps1|sh|js|mjs|py)$/.test(program))) {
    return { kind: null, program: null };
  }
  const args = w.slice(1).map((a) => a.toLowerCase());
  const subAt = args.findIndex((a, i) => !a.startsWith("-") && !a.startsWith("+") && !VALUED.has(args[i - 1]));
  const sub = subAt >= 0 ? args[subAt] : "";
  const pick = (name, allowed) => (allowed.includes(sub) ? `${name} ${sub}` : null);
  let kind = null;
  if (CHANGE_DIR.has(program)) return { kind: null, program: null };
  if (program === "cargo") {
    kind = sub === "nextest" ? "cargo test" : pick("cargo", ["test", "clippy", "check", "build", "run", "bench", "doc"]);
  } else if (program === "flutter") {
    kind = pick("flutter", ["test", "analyze", "build", "run"]) ?? (sub === "pub" ? "flutter pub" : null);
  } else if (program === "dart") {
    kind = sub === "run" && args.includes("build_runner") ? "dart build_runner" : pick("dart", ["test", "analyze", "compile"]);
  } else if (["npm", "pnpm", "yarn", "bun"].includes(program)) {
    if (["test", "t"].includes(sub)) kind = `${program} test`;
    else if (["ci", "install", "i", "add"].includes(sub)) kind = `${program} install`;
    else if (sub === "run" || sub === "run-script") {
      const script = args.slice(subAt + 1).find((a) => !a.startsWith("-"));
      kind = script ? `${program} run ${script}` : null;
    } else if (program !== "npm" && /^[\w:.-]+$/.test(sub) && !NOT_SCRIPTS.has(sub)) {
      kind = `${program} run ${sub}`; // pnpm build, yarn lint: a package script
    }
  } else if (program === "node") {
    const file = args.find((a) => !a.startsWith("-")) ?? "";
    if (args.includes("--test")) kind = "node tests";
    else if (/(e2e|playwright)/.test(file)) kind = "e2e tests";
    else if (/(^|[\\/._-])tests?([\\/._-]|$)/.test(file)) kind = "node tests";
    else if (SCRIPT_WORDS.test(programName(file))) kind = `node ${programName(file)}`;
  } else if (["tsc", "vitest", "jest", "playwright", "eslint", "pytest", "mypy", "ruff", "webpack", "vite"].includes(program)) {
    kind = program === "vite" ? (sub === "build" ? "vite build" : null) : program;
  } else if (["python", "python3", "py"].includes(program)) {
    const m = args.indexOf("-m");
    if (m >= 0 && ["pytest", "mypy", "unittest"].includes(args[m + 1])) kind = args[m + 1];
  } else if (program === "go") {
    kind = pick("go", ["test", "build", "vet"]);
  } else if (["gradle", "gradlew"].includes(program)) {
    kind = "gradle";
  } else if (program === "dotnet") {
    kind = pick("dotnet", ["build", "test", "publish"]);
  } else if (["make", "cmake", "msbuild", "ninja", "mvn"].includes(program)) {
    kind = program;
  } else if (["powershell", "pwsh", "bash", "sh", "cmd"].includes(program)) {
    const inner = args.findIndex((a) => ["-command", "-c", "/c"].includes(a));
    if (inner >= 0) return { ...commandKind(w.slice(inner + 2).join(" ")) };
    const file = args.findIndex((a) => a === "-file" || a === "-f");
    const script = file >= 0 ? w[file + 2] : w.slice(1).find((a) => /\.(ps1|sh)$/i.test(a));
    if (script && SCRIPT_WORDS.test(programName(script))) kind = programName(script);
  } else if (/\.(ps1|sh)$/i.test(raw) && SCRIPT_WORDS.test(program)) {
    kind = program;
  } else if (program === "layr" && sub === "manifest") {
    kind = "layr manifest check";
  }
  return { kind, program };
}

/**
 * The kind of a whole command line, e.g. "cargo test", or "cargo clippy + cargo test" when it runs several; null
 * when it is none of the known builds, tests and checks. `program`: the first real program it runs, for "other".
 */
export function commandKind(command) {
  const kinds = [];
  let program = null;
  for (const segment of String(command ?? "").split(/&&|\|\||[;\n|]/)) {
    const found = segmentKind(segment);
    if (!program && found.program) program = found.program;
    for (const k of String(found.kind ?? "").split(" + ")) if (k && !kinds.includes(k)) kinds.push(k);
  }
  // In one order, so "cargo test; cargo clippy" and "cargo clippy; cargo test" are one kind.
  return { kind: kinds.length ? kinds.sort().join(" + ") : null, program };
}

/**
 * The kind a run is kept as, or null when it isn't kept: dev servers and watchers never; a command started in the
 * background only when it builds, tests or checks; anything else only when it took BUILD_OTHER_MIN_MS or more.
 */
export function runKind(command, ms, { background = false } = {}) {
  const { kind, program } = commandKind(command);
  if (kind) {
    const kept = kind.split(" + ").filter((k) => !SERVES.test(k)).join(" + ");
    if (!kept || (background && !BUILDS.test(kept))) return null;
    return kept;
  }
  if (background) return null;
  if (ms >= BUILD_OTHER_MIN_MS && program && !WAITS.has(program)) return `other: ${program}`;
  return null;
}

// ------------------------------------------------------------------ what a result says

/** Claude Code moved a command that ran past its timeout to the background (it goes on there). */
export function movedToBackground(text) {
  return /did not complete within its .{0,20}timeout and was moved to the background/i.test(String(text ?? ""));
}

/** The session ended before the command's result was recorded: its time is unknown. */
export function interruptedCall(text) {
  return /^\s*\[Tool call interrupted/i.test(String(text ?? ""));
}

/** A background task's notice: the tool call it belongs to and how it ended. */
export function parseTaskNotice(text) {
  const s = String(text ?? "");
  const id = s.match(/<tool-use-id>\s*([\w-]+)\s*<\/tool-use-id>/)?.[1];
  const status = s.match(/<status>\s*(\w+)\s*<\/status>/)?.[1];
  return id && status ? { toolUseId: id, status } : null;
}

function noticeStatus(status) {
  if (status === "completed") return "ok";
  if (status === "failed") return "failed";
  return "stopped";
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ the record

export class BuildTimes {
  /** `store`: the thread store (projects and threads); `now`: the clock, for tests. */
  constructor({ dataDir, store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
    this.file = path.join(dataDir, "build-times.jsonl");
    this.importFile = path.join(dataDir, "build-times-import.json");
    /** @type {Map<string, any>} run id → run */
    this.runs = new Map();
    /** tool call id → { start, meta, command, background } while it runs */
    this.pending = new Map();
    /** tool call id → { run, start, meta, command } for commands now running in the background */
    this.inBackground = new Map();
    this.importing = null;
    // The engine calls these in the middle of a thread's stream: a failure here is logged, never the thread's.
    for (const name of ["toolStarted", "toolApproved", "toolFinished", "backgroundDone"]) {
      const fn = this[name].bind(this);
      this[name] = (...args) => {
        try {
          fn(...args);
        } catch (error) {
          log(`build times (${name}):`, errorMessage(error));
        }
      };
    }
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line);
        if (run?.id) this.runs.set(run.id, run);
      } catch {
        // a torn last line: skipped
      }
    }
  }

  save(run) {
    this.runs.set(run.id, run);
    try {
      appendFileSync(this.file, `${JSON.stringify(run)}\n`);
    } catch (error) {
      log("build times: could not save a run:", errorMessage(error));
    }
  }

  /** Where a folder's runs count: the layr project it is, or whose worktree it is; else a name from the folder. */
  projectOf(cwd, projectId) {
    const byId = projectId ? this.store.findProject(projectId) : null;
    if (byId) return { projectId: byId.id, project: byId.name };
    const dir = normalizePath(cwd || ".");
    for (const p of this.store.projects ?? []) {
      const root = normalizePath(p.path);
      const trees = normalizePath(path.join(path.dirname(p.path), ".layr-worktrees", path.basename(p.path)));
      if (dir === root || dir.startsWith(root + path.sep) || dir.startsWith(`${trees}-`)) {
        return { projectId: p.id, project: p.name };
      }
    }
    const parts = path.resolve(cwd || ".").split(/[\\/]/);
    const trees = parts.findIndex((s) => s === ".layr-worktrees" || s === "worktrees");
    // <project>/.claude/worktrees/agent-…: a subagent's own worktree of that project.
    if (trees > 1 && parts[trees - 1] === ".claude") return this.projectOf(parts.slice(0, trees - 1).join(path.sep));
    const name = trees >= 0 && parts[trees + 1] ? parts[trees + 1].replace(/-\d+-.*$/, "") : parts.at(-1);
    // A one-off scratch folder (2026-10-11-what-it-was-about): all of them under one name.
    if (/(^|-)\d{4}-\d{2}-\d{2}-/.test(name ?? "")) return { projectId: null, project: "scratch" };
    return { projectId: null, project: name || "?" };
  }

  makeRun({ id, start, end, command, cwd, projectId, thread, title, status, timedOut, background, source }) {
    const ms = Math.max(0, end - start);
    // A server or watcher started in the background and stopped later is no build; nor a notice lost for hours.
    if (ms > RUN_MAX_MS || (background && status === "stopped")) return null;
    const kind = runKind(command, ms, { background });
    if (!kind) return null;
    return {
      id,
      at: new Date(start).toISOString(),
      ms,
      kind,
      command: String(command).slice(0, COMMAND_MAX),
      cwd: cwd ? path.resolve(cwd) : null,
      ...this.projectOf(cwd, projectId),
      thread: thread ?? null,
      title: title ?? null,
      status,
      ...(timedOut ? { timedOut: true } : {}),
      ...(background ? { background: true } : {}),
      source,
    };
  }

  // Live, from the engine

  /** A tool call Claude Code got: a shell command starts now. */
  toolStarted(meta, block) {
    if (!SHELL_TOOLS.has(block?.name) || !block.id || typeof block.input?.command !== "string") return;
    this.pending.set(block.id, {
      start: this.now(),
      meta,
      command: block.input.command,
      background: block.input.run_in_background === true,
    });
  }

  /** It waited for the user's approval: it runs from now. */
  toolApproved(toolUseId) {
    const p = this.pending.get(toolUseId);
    if (p) p.start = this.now();
  }

  /** Its result came back. */
  toolFinished(toolUseId, text, isError) {
    const p = this.pending.get(toolUseId);
    if (!p) return;
    this.pending.delete(toolUseId);
    if (interruptedCall(text)) return;
    const end = this.now();
    const meta = p.meta;
    const base = {
      id: toolUseId, start: p.start, command: p.command, cwd: meta.cwd, projectId: meta.projectId, thread: meta.id,
      title: meta.title, source: "live",
    };
    if (p.background && !isError) {
      this.inBackground.set(toolUseId, { base: { ...base, background: true }, run: null });
      return;
    }
    const timedOut = movedToBackground(text);
    const run = this.makeRun({ ...base, end, status: timedOut ? "timeout" : isError ? "failed" : "ok", timedOut });
    if (timedOut) this.inBackground.set(toolUseId, { base: { ...base, timedOut: true }, run });
    if (run) this.save(run);
  }

  /** A background task ended: a command moved there (or started there) is done now. */
  backgroundDone(toolUseId, status) {
    const bg = this.inBackground.get(toolUseId);
    if (!bg) return;
    this.inBackground.delete(toolUseId);
    const run = this.makeRun({ ...bg.base, end: this.now(), status: noticeStatus(status) });
    if (run) this.save(run);
  }

  // Past runs, from Claude Code's transcripts

  /** Read the transcripts' runs not kept yet. Runs one at a time; a second call meanwhile gets the first's. */
  importTranscripts(root = transcriptsRoot(), { force = false } = {}) {
    if (!this.importing) {
      this.importing = this.doImport(root, force).finally(() => (this.importing = null));
    }
    return this.importing;
  }

  async doImport(root, force) {
    const state = force ? { files: {} } : readJson(this.importFile, { files: {} });
    const seen = state.files ?? {};
    const bySession = new Map(Object.values(this.store.threads ?? {}).map((t) => [t.sessionId, t]));
    let files = 0;
    let added = 0;
    for (const file of transcriptFiles(root)) {
      let size;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (seen[file] === size) continue;
      try {
        added += await this.importFile1(file, bySession);
      } catch (error) {
        log("build times: could not read", file, errorMessage(error));
      }
      seen[file] = size;
      files++;
      await new Promise((r) => setImmediate(r));
    }
    const result = { at: new Date(this.now()).toISOString(), files, added };
    writeFileAtomic(this.importFile, JSON.stringify({ ...result, files: seen, read: files }));
    return result;
  }

  /** One transcript's runs; the number added. Read line by line, so the backend goes on answering meanwhile. */
  async importFile1(file, bySession) {
    const calls = new Map();
    const background = new Map();
    let firstPrompt = null;
    // Where the session started: later lines follow its `cd`s into subfolders, which are no projects.
    let startCwd = null;
    let added = 0;
    const keep = (run) => {
      if (!run || this.runs.has(run.id)) return;
      this.save(run);
      added++;
    };
    let count = 0;
    for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
      if (++count % 500 === 0) await new Promise((r) => setImmediate(r));
      if (!line.trim()) continue;
      if (line.includes("<task-notification>")) {
        const notice = parseTaskNotice(line.replace(/\\n/g, "\n"));
        const bg = notice && background.get(notice.toolUseId);
        const at = Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1] ?? "");
        if (bg && Number.isFinite(at)) {
          background.delete(notice.toolUseId);
          const run = this.makeRun({ ...bg, end: at, status: noticeStatus(notice.status) });
          if (run && !this.runs.has(run.id)) keep(run);
          else if (run && this.runs.get(run.id)?.status === "timeout") this.save(run);
        }
        if (!line.includes('"tool_use')) continue;
      }
      // Only lines with tool calls or results matter (and the first prompt, for a title): the rest isn't parsed.
      if (!line.includes('"tool_use') && !line.includes('"tool_result"') && (firstPrompt || !line.includes('"user"'))) {
        continue;
      }
      if (line.startsWith('{"type":"api-request-shape"')) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      startCwd ??= m.cwd ?? null;
      const at = Date.parse(m.timestamp);
      const content = m.message?.content;
      if (m.type === "user" && typeof content === "string" && !firstPrompt && !content.startsWith("<")) {
        firstPrompt = content.trim().split("\n")[0].slice(0, 80);
      }
      if (!Array.isArray(content) || !Number.isFinite(at)) continue;
      for (const c of content) {
        if (c.type === "text" && m.type === "user" && !firstPrompt && c.text && !c.text.startsWith("<")) {
          firstPrompt = c.text.trim().split("\n")[0].slice(0, 80);
        }
        if (c.type === "tool_use" && SHELL_TOOLS.has(c.name) && typeof c.input?.command === "string") {
          calls.set(c.id, { at, input: c.input, cwd: startCwd, sessionId: m.sessionId });
        } else if (c.type === "tool_result" && calls.has(c.tool_use_id)) {
          const call = calls.get(c.tool_use_id);
          calls.delete(c.tool_use_id);
          const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n");
          if (interruptedCall(text)) continue;
          const thread = bySession.get(call.sessionId);
          const base = {
            id: c.tool_use_id, start: call.at, command: call.input.command, cwd: thread?.cwd ?? call.cwd,
            projectId: thread?.projectId, thread: thread?.id, title: thread?.title ?? firstPrompt, source: "import",
          };
          if (call.input.run_in_background === true && c.is_error !== true) {
            background.set(c.tool_use_id, { ...base, background: true });
            continue;
          }
          const timedOut = movedToBackground(text);
          if (timedOut) background.set(c.tool_use_id, { ...base, timedOut: true });
          keep(this.makeRun({ ...base, end: at, status: timedOut ? "timeout" : c.is_error ? "failed" : "ok", timedOut }));
        }
      }
    }
    return added;
  }

  importState() {
    const s = readJson(this.importFile, null);
    return s ? { at: s.at, read: s.read ?? 0, added: s.added ?? 0, files: Object.keys(s.files ?? {}).length } : null;
  }

  // What the panel and the tool show

  /**
   * Per project (or one: `project` is its id or name): each kind's runs, total, median and longest time, failures,
   * timeouts, and its first runs in a folder (cold builds) apart from the later ones; time per day; the threads that
   * waited longest; the latest runs. `days`: only runs that started in the last so many days (default all).
   */
  summary({ project, days, kind } = {}) {
    const since = days ? this.now() - days * 86_400_000 : 0;
    const all = [...this.runs.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    // A run is a folder's first of its kind when no earlier run of that kind ran there (a cold build, as a rule).
    const firsts = new Set();
    const seen = new Set();
    for (const r of all) {
      const key = `${normalizePath(r.cwd || ".")}\n${r.kind}`;
      if (!seen.has(key)) firsts.add(r.id);
      seen.add(key);
    }
    const want = project ? String(project).toLowerCase() : null;
    const groups = new Map();
    for (const r of all) {
      if (Date.parse(r.at) < since) continue;
      if (kind && r.kind !== kind) continue;
      const key = r.projectId || `name:${r.project}`;
      if (want && key.toLowerCase() !== want && String(r.project).toLowerCase() !== want) continue;
      if (!groups.has(key)) groups.set(key, { id: r.projectId, name: r.project, runs: [] });
      groups.get(key).runs.push(r);
    }
    const projects = [...groups.values()].map((g) => summarizeProject(g, firsts));
    projects.sort((a, b) => b.totalMs - a.totalMs);
    return { since: since ? new Date(since).toISOString() : null, projects, imported: this.importState() };
  }
}

function summarizeProject(g, firsts) {
  const kinds = new Map();
  const days = new Map();
  const threads = new Map();
  let totalMs = 0;
  for (const r of g.runs) {
    totalMs += r.ms;
    if (!kinds.has(r.kind)) kinds.set(r.kind, []);
    kinds.get(r.kind).push(r);
    const day = localDay(Date.parse(r.at));
    days.set(day, (days.get(day) ?? 0) + r.ms);
    const tk = r.thread || r.title || "?";
    if (!threads.has(tk)) threads.set(tk, { thread: r.thread, title: r.title, ms: 0, runs: 0 });
    const t = threads.get(tk);
    t.ms += r.ms;
    t.runs++;
  }
  const kindRows = [...kinds.entries()].map(([name, runs]) => {
    const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
    const first = runs.filter((r) => firsts.has(r.id)).map((r) => r.ms).sort((a, b) => a - b);
    const later = runs.filter((r) => !firsts.has(r.id)).map((r) => r.ms).sort((a, b) => a - b);
    return {
      kind: name,
      runs: runs.length,
      totalMs: ms.reduce((s, x) => s + x, 0),
      medianMs: median(ms),
      maxMs: ms.at(-1),
      failed: runs.filter((r) => r.status === "failed").length,
      timedOut: runs.filter((r) => r.timedOut).length,
      firstRuns: first.length,
      firstMedianMs: median(first),
      laterMedianMs: median(later),
    };
  });
  kindRows.sort((a, b) => b.totalMs - a.totalMs);
  return {
    id: g.id,
    name: g.name,
    runs: g.runs.length,
    totalMs,
    timedOut: g.runs.filter((r) => r.timedOut).length,
    kinds: kindRows,
    days: [...days.entries()].map(([day, ms]) => ({ day, ms })).sort((a, b) => a.day.localeCompare(b.day)),
    threads: [...threads.values()].sort((a, b) => b.ms - a.ms).slice(0, 10),
    recent: g.runs.slice(-15).reverse().map((r) => ({
      at: r.at, ms: r.ms, kind: r.kind, command: r.command, status: r.status, timedOut: r.timedOut === true,
      background: r.background === true, first: firsts.has(r.id), title: r.title, thread: r.thread,
    })),
  };
}

/** Every transcript under the root: <project folder>/*.jsonl and their subagents' <session>/subagents/*.jsonl. */
function transcriptFiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}
