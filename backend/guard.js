// The kill guard: a PreToolUse hook on every thread's shell commands (Bash, PowerShell, Monitor) that refuses to
// end programs by name, and to end layr itself by process id. It holds in every permission mode (bypassPermissions
// too) and in subagents.
//
// Why: the user's app is layr.exe, and so is the `layr serve` a worker starts for a test; the app hosts the core,
// which hosts this engine. A worker's `taskkill /F /IM layr.exe` to stop its test core closed the app with every
// thread in it, twice (pipeline tasks #3 and #6, 2026-11-16 and 17). `taskkill /IM node.exe` ends this engine.
//
// The same on macOS and Linux, where the app is `layr` and the engine `node`: pkill, killall, `ps | grep | xargs
// kill`, and `kill 0` / `kill -1` (its own process group, or every process), which end layr too.
//
// The guard reads the command as text: it catches the careless cases, not a determined workaround. Settings
// (layr.json): killByName "all" (default) refuses every kill by name, "listed" only of the programs in
// protectedPrograms, "off" none. Kills of the app's or the engine's process id are refused whatever it says.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_PROTECTED = "layr.exe, node.exe, claude.exe";

/** Tools whose `command` is run by a shell. */
export const GUARDED_TOOLS = "Bash|PowerShell|Monitor";

const INSTEAD =
  "Stop only processes you started, by their id: keep the id when you start one (PowerShell: `$p = Start-Process " +
  "... -PassThru`, then `Stop-Process -Id $p.Id`; bash or zsh: `cmd & pid=$!`, then `kill $pid`). A throwaway " +
  "layr core: `scripts/test-core.ps1 start` / `stop` in the layr repository. If the command only mentions such a " +
  "kill (a commit message, a search), write it differently.";

/** "layr.exe" → "layr": names compare without case, quotes or `.exe`. */
export function programName(name) {
  return String(name)
    .trim()
    .replace(/^["']+|["',;]+$/g, "")
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/** The protected programs of a comma (or space) separated list. */
export function parseProgramList(text) {
  return String(text ?? "")
    .split(/[,;\s]+/)
    .map(programName)
    .filter(Boolean);
}

/** Does a target name (maybe with * and ? wildcards) mean `name`? */
function matches(target, name) {
  if (target === "*") return true;
  if (!/[*?]/.test(target)) return target === name;
  const re = new RegExp(`^${target.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(name);
}

/** The pieces of a command line between `;`, `&&`, `||` and newlines; pipes stay inside a piece. */
function statements(command) {
  return command.split(/\r?\n|;|&&|\|\|/).map((s) => s.trim()).filter(Boolean);
}

function words(text) {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** A list argument ("a,b" or a b) up to the next option. */
function listAfter(tokens, i) {
  const out = [];
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if (/^[-/]/.test(t) || t === "|") break;
    out.push(...t.split(",").map((x) => x.trim()).filter(Boolean));
    if (!t.endsWith(",")) break;
  }
  return out;
}

const PS_KILL = /\b(Stop-Process|spps)\b|(^|[|]\s*)kill\b|\.Kill\(\)/i;

/**
 * bash / zsh `kill` (also `sudo kill`, `/bin/kill`): its process ids, after the signal options (`-9`, `-KILL`,
 * `-s TERM`, `--`). A negative id is a process group (the one that id leads); `0` is the caller's own group (which
 * holds this Claude engine) and `-1` every process of the user: both are `everyone`.
 */
function unixKill(tokens, pids) {
  let everyone = false;
  for (let i = 0; i < tokens.length; i++) {
    if (!/^(?:\S*\/)?kill$/.test(tokens[i])) continue;
    let signal = false;
    let options = true;
    let seenPid = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (/^[|;&)]/.test(t)) break;
      if (options && t === "--") {
        options = false;
        continue;
      }
      if (options && ["-s", "-n", "--signal"].includes(t)) {
        signal = true;
        j++;
        continue;
      }
      if (options && !signal && !seenPid && /^-(?:\d+|[A-Za-z][A-Za-z0-9+]*)$/.test(t)) {
        signal = true;
        continue;
      }
      if (/^-?\d+$/.test(t)) {
        const n = Number(t);
        seenPid = true;
        if (n === 0 || n === -1) everyone = true;
        else pids.push(Math.abs(n));
      }
    }
  }
  return everyone;
}

/**
 * What a command would end: `names` (programs by name; "*" when it picks them by a filter it can't read), `pids`
 * (process ids written in it) and `everyone` (`kill 0`, `kill -1`: its own process group, or every process).
 */
export function killTargets(command) {
  const names = [];
  const pids = [];
  let everyone = false;
  const text = String(command ?? "");
  for (const statement of statements(text)) {
    const tokens = words(statement);
    const lower = statement.toLowerCase();

    if (unixKill(tokens, pids)) everyone = true;
    // ps … | grep x | … xargs kill, kill $(ps … | grep x …): the program grep picks.
    if (/\bkill\b/.test(statement) && /\bps\b/.test(statement)) {
      const grep = statement.match(/\bgrep\b(?:\s+-\S+)*\s+("[^"]*"|'[^']*'|[^\s|;&)]+)/);
      names.push(grep ? programName(grep[1].replace(/^\[(.)\]/, "$1")) : "*");
    }

    // taskkill /IM x, /FI "IMAGENAME eq x", /PID n (also //IM from Git Bash, and -IM).
    if (/\btaskkill(\.exe)?\b/i.test(statement)) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i].toLowerCase();
        if (/^(\/\/|\/|-)im$/.test(t)) names.push(...listAfter(tokens, i + 1).map(programName));
        if (/^(\/\/|\/|-)pid$/.test(t)) pids.push(...listAfter(tokens, i + 1).map(Number).filter(Number.isInteger));
        if (/^(\/\/|\/|-)fi$/.test(t)) {
          const filter = (tokens[i + 1] ?? "").replace(/^["']|["']$/g, "");
          const m = filter.match(/^\s*imagename\s+(eq|ne)\s+(.+)$/i);
          if (m) names.push(m[1].toLowerCase() === "eq" ? programName(m[2]) : "*");
          const p = filter.match(/^\s*pid\s+eq\s+(\d+)/i);
          if (p) pids.push(Number(p[1]));
        }
      }
    }

    // pkill / killall x, and pgrep / pidof x feeding kill.
    for (const m of statement.matchAll(/\b(pkill|killall)\b((?:\s+-\S+)*)\s+("[^"]*"|'[^']*'|[^\s|;&]+)/gi)) {
      names.push(programName(m[3]));
    }
    if (/\bkill\b/i.test(statement)) {
      for (const m of statement.matchAll(/\b(pgrep|pidof)\b(?:\s+-\S+)*\s+("[^"]*"|'[^']*'|[^\s|;&)]+)/gi)) {
        names.push(programName(m[2]));
      }
    }

    // wmic process where name='x' delete / call terminate.
    if (/\bwmic\b/i.test(statement) && /\bprocess\b/i.test(statement) && /\b(delete|terminate)\b/i.test(statement)) {
      const m = statement.match(/name\s*=\s*\\?["']?([^"'\s\\)]+)/i);
      names.push(m ? programName(m[1]) : "*");
      const p = statement.match(/processid\s*=\s*(\d+)/i);
      if (p) pids.push(Number(p[1]));
    }

    // Win32_Process through CIM / WMI, ended with Terminate or Remove-*.
    if (/win32_process/i.test(statement) && /(terminate|remove-ciminstance|remove-wmiobject|\.kill\(\))/i.test(lower)) {
      const found = [...statement.matchAll(/name\s*(?:=|-eq|-like|-match)\s*\\?["']([^"'\\]+)/gi)].map((m) =>
        programName(m[1]),
      );
      names.push(...(found.length ? found : ["*"]));
    }

    // PowerShell: Stop-Process -Name x / -Id n; Get-Process x | Stop-Process; (Get-Process x).Kill().
    if (PS_KILL.test(statement)) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^-(name|processname)$/i.test(t)) names.push(...listAfter(tokens, i + 1).map(programName));
        if (/^-id$/i.test(t)) pids.push(...listAfter(tokens, i + 1).map(Number).filter(Number.isInteger));
      }
      // Stop-Process 1234 (the id is its first positional parameter).
      for (const m of statement.matchAll(/\b(Stop-Process|spps)\s+(\d+)\b/gi)) pids.push(Number(m[2]));
      // kill 1234 / kill -9 1234 (bash and PowerShell's alias).
      for (const m of statement.matchAll(/(?:^|[|(;]\s*)kill((?:\s+-\S+)*)((?:\s+\d+)+)/gi)) {
        pids.push(...m[2].trim().split(/\s+/).map(Number));
      }
      const get = statement.match(/\b(Get-Process|gps)\b(.*?)(\||\)|$)/i);
      if (get) {
        const args = words(get[2]);
        if (args.some((a) => /^-id$/i.test(a))) {
          const i = args.findIndex((a) => /^-id$/i.test(a));
          pids.push(...listAfter(args, i + 1).map(Number).filter(Number.isInteger));
        } else {
          const i = args.findIndex((a) => /^-(name|processname)$/i.test(a));
          const given = i >= 0 ? listAfter(args, i + 1) : listAfter(args, 0);
          // Get-Process | Where-Object { ... } | Stop-Process: the names are in the filter.
          const filtered = [...statement.matchAll(/(?:name|processname)\s*-(?:eq|like|match)\s*["']([^"']+)/gi)];
          names.push(...given.map(programName), ...filtered.map((m) => programName(m[1])));
          if (!given.length && !filtered.length) names.push("*");
        }
      }
    }
  }
  return { names: [...new Set(names.filter(Boolean))], pids: [...new Set(pids)], everyone };
}

/** Local script files a command runs (.ps1, .sh, .bat, .cmd), resolved against `cwd`, that exist. */
export function scriptsRun(command, cwd) {
  const out = [];
  const ext = String.raw`\.(?:ps1|sh|bat|cmd)`;
  const script = new RegExp(String.raw`("[^"]+${ext}"|'[^']+${ext}'|[^\s"'|;&()]+${ext}(?=$|[\s|;&()]))`, "gi");
  for (const m of String(command ?? "").matchAll(script)) {
    const raw = m[1].replace(/^["']|["']$/g, "");
    const file = path.resolve(cwd || process.cwd(), raw);
    try {
      if (existsSync(file) && statSync(file).isFile() && statSync(file).size < 512 * 1024) out.push(file);
    } catch {
      // not a file we can read: nothing to scan
    }
  }
  return [...new Set(out)];
}

/**
 * The reason to refuse `command`, or null. `mode`: "all" | "listed" | "off"; `protectedNames`: programName()s;
 * `protectedPids`: process ids of layr itself (the app or core, and this engine).
 */
export function refusal(command, options = {}) {
  const { mode = "all", protectedNames = parseProgramList(DEFAULT_PROTECTED), protectedPids = [], cwd } = options;
  const check = (text, where) => {
    const { names, pids, everyone } = killTargets(text);
    const pid = pids.find((p) => protectedPids.includes(p));
    if (pid !== undefined) {
      return `Blocked by layr: ${where}ends process ${pid}, which is layr itself (the app with every thread in it, ` +
        `or this Claude engine), or its process group. ${INSTEAD}`;
    }
    if (everyone) {
      return `Blocked by layr: ${where}ends a whole process group or every process (\`kill 0\`, \`kill -1\`), ` +
        `which takes layr with it (the app with every thread in it, and this Claude engine). ${INSTEAD}`;
    }
    if (mode === "off" || !names.length) return null;
    const hit = mode === "listed"
      ? names.find((n) => protectedNames.some((p) => matches(n, p)))
      : names[0];
    if (hit === undefined) return null;
    const what = hit === "*" ? "programs picked by a filter" : `every program named ${hit}`;
    return `Blocked by layr: ${where}ends ${what}. Killing by name also ends the user's own programs: the layr app ` +
      `is layr (layr.exe on Windows), the same name as a test core, and its Claude engine is node; one such kill ` +
      `closed layr with every thread in it. ${INSTEAD}`;
  };
  const direct = check(command, "this command ");
  if (direct) return direct;
  for (const file of scriptsRun(command, cwd)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const inside = check(text, `the script it runs (${path.basename(file)}) `);
    if (inside) return inside;
  }
  return null;
}

/**
 * The SDK `hooks` option of a thread. `settings()` gives `{ mode, programs }` (the plugin's settings, may be async);
 * `protectedPids` the ids that are layr itself.
 */
export function guardHooks({ settings, protectedPids, onBlock = () => {} }) {
  const hook = async (input) => {
    const command = input?.tool_input?.command;
    if (typeof command !== "string" || !command.trim()) return { continue: true };
    let mode = "all";
    let programs = DEFAULT_PROTECTED;
    try {
      const s = (await settings()) ?? {};
      if (s.mode === "listed" || s.mode === "off" || s.mode === "all") mode = s.mode;
      if (typeof s.programs === "string") programs = s.programs;
    } catch {
      // settings unavailable: the safe default
    }
    const protectedNames = parseProgramList(programs);
    const reason = refusal(command, { mode, protectedNames, protectedPids, cwd: input.cwd });
    if (!reason) return { continue: true };
    onBlock(command, reason);
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  };
  return { PreToolUse: [{ matcher: GUARDED_TOOLS, hooks: [hook] }] };
}

/** The ids that are layr itself, seen from this backend: this engine and the core (or app) that started it. */
export function layrPids(proc = process) {
  return [proc.pid, proc.ppid].filter((p) => Number.isInteger(p) && p > 0);
}
