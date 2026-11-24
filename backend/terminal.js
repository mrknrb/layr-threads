// Windows on the PC the thread panel opens: ▶ Run on a command block of a reply (a new terminal window in the
// thread's folder running it), and the thread's folder in VS Code or the file manager. Windows, macOS (Terminal.app,
// Finder) and Linux (the first terminal found, xdg-open). A click carries when it was made
// (`at`): one that reaches the PC much later (a phone's click queued while the PC was off) is dropped instead of
// opening a window out of the blue.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A click older than this when the PC gets it doesn't run. */
export const RUN_FRESH_MS = 60_000;
const SCRIPTS = path.join(os.tmpdir(), "layr-commands");
/** Scripts are kept this long, so a slow window still finds its own; older ones go on the next run. */
const KEEP_MS = 60 * 60_000;

/** Fenced code languages that get a ▶ Run button, and the shell they run in. Untagged blocks get none. */
const SHELL_OF = {
  powershell: "powershell", pwsh: "powershell", ps: "powershell", ps1: "powershell",
  cmd: "cmd", bat: "cmd", batch: "cmd",
  bash: "bash", sh: "bash", shell: "bash", zsh: "bash",
};

export const shellOf = (language) => {
  const key = String(language ?? "").toLowerCase();
  return Object.hasOwn(SHELL_OF, key) ? SHELL_OF[key] : null;
};

export const SCRIPT_EXTENSION = { powershell: ".ps1", cmd: ".cmd", bash: ".sh" };

const shQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * The script the new window runs: it shows the command, then runs it; the window stays open afterwards. On macOS and
 * Linux (`platform`) a bash script starts with `cd` into `cwd` (Terminal.app and gnome-terminal open in the home
 * folder whatever the caller's folder) and ends in the user's own shell.
 */
export function scriptFor(shell, command, { platform = process.platform, cwd } = {}) {
  const body = String(command ?? "").replace(/\r\n/g, "\n").trimEnd();
  const shown = body.split("\n");
  const unix = platform !== "win32";
  switch (shell) {
    case "powershell":
      return [
        "$Host.UI.RawUI.WindowTitle = 'layr: run command'",
        ...(unix && cwd ? [`Set-Location -LiteralPath '${String(cwd).replaceAll("'", "''")}'`] : []),
        ...shown.map((line) => `Write-Host '> ${line.replaceAll("'", "''")}' -ForegroundColor Cyan`),
        "",
        ...shown,
        "",
      ].join(unix ? "\n" : "\r\n");
    case "cmd":
      // With echo on, cmd shows each line before running it. The script is UTF-8, so the code page is too.
      return ["@chcp 65001 >nul", "@title layr: run command", ...shown, ""].join("\r\n");
    case "bash":
      return [
        ...(unix ? ["#!/bin/bash", ...(cwd ? [`cd -- ${shQuote(cwd)} || exit 1`] : [])] : []),
        "printf '\\033]0;layr: run command\\007'",
        ...shown.map((line) => `printf '\\033[36m> %s\\033[0m\\n' ${shQuote(line)}`),
        "",
        ...shown,
        "",
        // The window stays open in an interactive shell, in the folder the command left it in.
        unix ? 'exec "${SHELL:-/bin/bash}" -l -i' : "exec bash --login -i",
        "",
      ].join("\n");
    default:
      throw new Error(`Unknown shell ${shell}: powershell, cmd or bash`);
  }
}

/** A program on the PATH (or null). */
export function onPath(name, env = process.env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Linux: a terminal to open, as `[program, ...arguments before the command]`: `$TERMINAL`, then Debian's
 * `x-terminal-emulator`, then the common ones. `find` looks a name up (tests pass their own).
 */
export function linuxTerminal(find = onPath, env = process.env) {
  const known = [
    ["x-terminal-emulator", "-e"],
    ["gnome-terminal", "--"],
    ["ptyxis", "--"],
    ["kgx", "--"],
    ["konsole", "-e"],
    ["xfce4-terminal", "-x"],
    ["mate-terminal", "-x"],
    ["tilix", "-e"],
    ["kitty"],
    ["alacritty", "-e"],
    ["wezterm", "start", "--"],
    ["foot"],
    ["xterm", "-e"],
  ];
  const chosen = env.TERMINAL && find(env.TERMINAL) ? [[env.TERMINAL, ...(known.find(([n]) => n === env.TERMINAL)
    ?.slice(1) ?? ["-e"])]] : [];
  for (const [name, ...args] of [...chosen, ...known]) {
    const program = find(name);
    if (program) return [program, ...args];
  }
  return null;
}

/** Throws when the click is too old (or from the future by more than a minute: another device's clock). */
export function checkFresh(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t)) throw new Error("When was it clicked? `at` (ms) is missing");
  if (now - t > RUN_FRESH_MS) throw new Error("That click is more than a minute old, so it didn't run. Click again.");
  if (t - now > RUN_FRESH_MS) throw new Error("That click comes from a clock far ahead of this PC's, so it didn't run.");
}

/**
 * The backend's environment without what layr added (the hub token above all), as a terminal you open yourself
 * would have it. NODE_ENV and npm's variables too: `npm install` in the window would otherwise behave differently.
 */
export function terminalEnv(extra = {}, from = process.env) {
  const env = { ...from };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (/^(LAYR_|NPM_|PNPM_|DOTENV_)/.test(upper) || ["NODE_ENV", "NODE_OPTIONS", "INIT_CWD", "CLAUDECODE",
      "CLAUDE_AGENT_SDK_CLIENT_APP", "ELECTRON_RUN_AS_NODE"].includes(upper)) delete env[name];
  }
  return { ...env, ...extra };
}

/** Git for Windows' bash; WSL's `bash.exe` in System32 would start in Linux instead. */
function gitBash() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")];
  for (const root of roots) {
    const bash = root && path.join(root, "Git", "bin", "bash.exe");
    if (bash && existsSync(bash)) return bash;
  }
  throw new Error("Git Bash isn't installed, so bash commands can't run");
}

async function removeOld() {
  const now = Date.now();
  for (const name of await readdir(SCRIPTS).catch(() => [])) {
    const file = path.join(SCRIPTS, name);
    const { mtimeMs } = await stat(file).catch(() => ({ mtimeMs: now }));
    if (now - mtimeMs > KEEP_MS) await rm(file, { force: true }).catch(() => {});
  }
}

function detached(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: "ignore", ...options });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * The command goes in a script file, so nothing in it has to survive quoting on a command line. `start` gives the
 * shell a console window of its own (Windows Terminal, when it's the default terminal), which outlives the backend.
 */
export async function openTerminal(cwd, shell, command) {
  if (!cwd || !existsSync(cwd)) throw new Error(`The folder ${cwd} doesn't exist`);
  if (!SCRIPT_EXTENSION[shell]) throw new Error(`Unknown shell ${shell}: powershell, cmd or bash`);
  if (!String(command ?? "").trim()) throw new Error("The command is empty");
  await mkdir(SCRIPTS, { recursive: true });
  await removeOld();
  if (process.platform !== "win32") return openUnixTerminal(cwd, shell, command);
  const file = path.join(SCRIPTS, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${SCRIPT_EXTENSION[shell]}`);
  // Windows PowerShell reads a script without a byte order mark in the ANSI code page.
  await writeFile(file, (shell === "powershell" ? "﻿" : "") + scriptFor(shell, command), "utf8");
  const quote = (text) => `"${text}"`;
  const [program, env] =
    shell === "powershell"
      ? [`powershell.exe -NoExit -ExecutionPolicy Bypass -File ${quote(file)}`, {}]
      : shell === "cmd"
        ? [`cmd.exe /k ${quote(file)}`, {}]
        : // Git Bash's login profile goes to the home folder unless CHERE_INVOKING is set.
          [`${quote(gitBash())} ${quote(file.replaceAll("\\", "/"))}`, { CHERE_INVOKING: "1" }];
  // With /s, cmd takes everything between the outer quotes as it is; these paths hold no quotes.
  const line = quote(`start ${quote("layr")} ${program}`);
  await detached("cmd.exe", ["/d", "/s", "/c", line], { cwd, windowsVerbatimArguments: true, env: terminalEnv(env) });
}

/**
 * macOS and Linux: the command goes in an executable bash script that `cd`s into the folder first (a PowerShell
 * block in a `.ps1` run by `pwsh`, when it is installed). macOS opens it in Terminal.app (`open -a Terminal`), Linux
 * in the first terminal it finds (`linuxTerminal`). cmd blocks are Windows only.
 */
async function openUnixTerminal(cwd, shell, command) {
  if (shell === "cmd") throw new Error("cmd commands run only on Windows: use a bash block");
  const base = path.join(SCRIPTS, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let script = `${base}.sh`;
  if (shell === "powershell") {
    const pwsh = onPath("pwsh");
    if (!pwsh) throw new Error("PowerShell (pwsh) isn't installed on this PC, so PowerShell commands can't run");
    await writeFile(`${base}.ps1`, scriptFor("powershell", command, { cwd }), "utf8");
    await writeFile(script, ["#!/bin/bash", `exec ${shQuote(pwsh)} -NoExit -File ${shQuote(`${base}.ps1`)}`, ""]
      .join("\n"), { encoding: "utf8", mode: 0o700 });
  } else {
    await writeFile(script, scriptFor("bash", command, { cwd }), { encoding: "utf8", mode: 0o700 });
  }
  await chmod(script, 0o700);
  const env = terminalEnv();
  if (process.platform === "darwin") {
    await detached("open", ["-a", "Terminal", script], { cwd, env });
    return;
  }
  const terminal = linuxTerminal();
  if (!terminal) {
    throw new Error("No terminal found (gnome-terminal, konsole, xterm…): install one, or set TERMINAL to yours");
  }
  const [program, ...args] = terminal;
  await detached(program, [...args, "/bin/bash", script], { cwd, env });
}

/** Opens a folder in VS Code (`code`, on the PATH as its installer puts it) or the file manager (File Explorer,
 * Finder, or what `xdg-open` picks on Linux). */
export async function openFolder(folder, app) {
  if (!folder || !existsSync(folder)) throw new Error(`The folder ${folder} doesn't exist`);
  if (app !== "vscode" && app !== "explorer") throw new Error(`Unknown app ${app}: vscode or explorer`);
  if (process.platform !== "win32") {
    const env = terminalEnv();
    if (app === "vscode") {
      const code = onPath("code");
      if (code) await detached(code, [folder], { cwd: folder, env });
      else if (process.platform === "darwin") await detached("open", ["-b", "com.microsoft.VSCode", folder], { env });
      else throw new Error("VS Code's `code` command isn't on the PATH");
    } else {
      await detached(process.platform === "darwin" ? "open" : "xdg-open", [folder], { cwd: folder, env });
    }
    return;
  }
  if (folder.includes('"')) throw new Error("That folder's name can't be opened");
  if (app === "vscode") {
    // `code` is a .cmd, so it goes through cmd.
    await detached("cmd.exe", ["/d", "/s", "/c", `"code "${folder}""`], { cwd: folder, windowsVerbatimArguments: true,
      windowsHide: true, env: terminalEnv() });
  } else if (app === "explorer") {
    await detached("explorer.exe", [folder], { cwd: folder, env: terminalEnv() });
  } else throw new Error(`Unknown app ${app}: vscode or explorer`);
}
