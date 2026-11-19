// Unit test of the kill guard (backend/guard.js), without Claude: which commands it refuses, in each setting, and
// that the hook answers the way the Agent SDK expects. Run: node test/guard.test.js
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeEnv } from "../backend/claudeEnv.js";
import { guardHooks, killTargets, layrPids, parseProgramList, refusal } from "../backend/guard.js";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const APP = 37728;
const ENGINE = 29204;
const pids = [APP, ENGINE];
const blocked = (cmd, opts = {}) => refusal(cmd, { protectedPids: pids, ...opts }) !== null;

// The commands that closed layr (tasks #3 and #6), and their relatives.
const byName = [
  "taskkill //F //IM layr.exe > /dev/null 2>&1; grep -i error /tmp/serve.log",
  "taskkill //F //IM layr.exe >/dev/null 2>&1; /c/src/flutter/bin/flutter build windows --debug",
  "taskkill /F /IM layr.exe",
  "taskkill /im LAYR.EXE /f",
  "taskkill /F /T /IM layr.exe",
  'taskkill /F /FI "IMAGENAME eq layr.exe"',
  "cmd /c taskkill /f /im node.exe",
  "Stop-Process -Name layr -Force",
  "Stop-Process -Name layr,node",
  "Stop-Process -ProcessName layr",
  "Get-Process layr | Stop-Process -Force",
  "Get-Process -Name layr -ErrorAction SilentlyContinue | Stop-Process",
  "gps layr | kill",
  "Get-Process | Where-Object { $_.ProcessName -eq 'layr' } | Stop-Process",
  "(Get-Process layr).Kill()",
  "pkill layr",
  "pkill -f layr.exe",
  "killall -9 node",
  "kill $(pgrep layr)",
  "pgrep -f layr | xargs kill",
  "wmic process where name='layr.exe' delete",
  "wmic process where \"name='layr.exe'\" call terminate",
  "Get-CimInstance Win32_Process -Filter \"Name='layr.exe'\" | Invoke-CimMethod -MethodName Terminate",
  "cd core && cargo build && taskkill /F /IM layr.exe",
];
for (const cmd of byName) check(blocked(cmd), `refused: ${cmd}`);

// What a careful worker does stays allowed.
const fine = [
  "$p = Start-Process -FilePath core\\target\\debug\\layr.exe -ArgumentList 'serve' -PassThru; Stop-Process -Id $p.Id",
  "Stop-Process -Id $core.Id -Force",
  "Stop-Process -Id 4242",
  "taskkill /F /PID 4242",
  "taskkill /F /T /PID 4242",
  "kill 4242",
  "kill -9 4242",
  "$p.Kill()",
  "Get-Process layr | Select-Object Id, Path",
  "Get-Process -Id 4242 | Stop-Process",
  "tasklist | findstr layr",
  "Get-CimInstance Win32_Process -Filter \"Name='layr.exe'\" | Select-Object ProcessId, CommandLine",
  "cargo test -p layr_core",
  "git log --oneline -5",
  "grep -rn kill src/",
];
for (const cmd of fine) check(!blocked(cmd), `allowed: ${cmd}`, refusal(cmd, { protectedPids: pids }));

// layr's own process ids are refused in every mode, also with a tree kill.
for (const mode of ["all", "listed", "off"]) {
  check(blocked(`taskkill /F /T /PID ${APP}`, { mode }), `${mode}: the app's id is refused (taskkill /T)`);
  check(blocked(`Stop-Process -Id ${ENGINE} -Force`, { mode }), `${mode}: the engine's id is refused (Stop-Process)`);
  check(blocked(`kill -9 ${APP}`, { mode }), `${mode}: the app's id is refused (kill)`);
  check(blocked(`Get-Process -Id ${APP} | Stop-Process`, { mode }), `${mode}: the app's id is refused (Get-Process)`);
}

// Settings: "listed" refuses only the programs listed, "off" none by name.
const listed = { mode: "listed", protectedNames: parseProgramList("layr.exe, node.exe, claude.exe") };
check(blocked("taskkill /F /IM layr.exe", listed), "listed: layr.exe refused");
check(blocked("Stop-Process -Name claude", listed), "listed: claude refused");
check(blocked("taskkill /F /IM l*", listed), "listed: a wildcard that means layr is refused");
check(blocked("Get-Process | Where-Object { $_.Path -like '*x*' } | Stop-Process", listed),
  "listed: a filter it can't read is refused");
check(!blocked("taskkill /F /IM vite.exe", listed), "listed: vite.exe allowed");
check(!blocked("pkill python", listed), "listed: python allowed");
check(blocked("taskkill /F /IM vite.exe"), "all (the default): vite.exe refused too");
check(!blocked("taskkill /F /IM layr.exe", { mode: "off" }), "off: by name allowed");
const custom = { mode: "listed", protectedNames: parseProgramList("Code.exe chrome") };
check(blocked("taskkill /IM chrome.exe", custom) && !blocked("taskkill /IM layr.exe", custom),
  "listed: a list of its own, separated by spaces");

// The refusal says what to do instead.
const reason = refusal("taskkill /F /IM layr.exe", { protectedPids: pids });
check(/Stop-Process -Id/.test(reason) && /test-core\.ps1/.test(reason), "the refusal says what to do instead", reason);

// A script the command runs is read too.
const dir = mkdtempSync(path.join(os.tmpdir(), "layr-guard-"));
writeFileSync(path.join(dir, "cleanup.ps1"), "Write-Host bye\nStop-Process -Name layr -Force\n");
writeFileSync(path.join(dir, "ok.ps1"), "$p = Start-Process notepad -PassThru\nStop-Process -Id $p.Id\n");
writeFileSync(path.join(dir, "clean up.sh"), "taskkill //F //IM layr.exe\n");
check(blocked("powershell -File .\\cleanup.ps1", { cwd: dir }), "a script that kills by name is refused");
check(blocked('bash "clean up.sh"', { cwd: dir }), "a quoted script path with a space is read");
check(!blocked("powershell -File ./ok.ps1", { cwd: dir }), "a script that stops its own id is allowed");
check(!blocked("powershell -File ./missing.ps1", { cwd: dir }), "a script that doesn't exist is no reason");

// killTargets in detail.
const t = killTargets('taskkill /F /IM layr.exe /IM "node.exe" /PID 12 /PID 13');
check(t.names.includes("layr") && t.names.includes("node") && t.pids.includes(12) && t.pids.includes(13),
  "killTargets reads several /IM and /PID", t);
check(killTargets('taskkill /F /FI "IMAGENAME ne explorer.exe"').names[0] === "*", "IMAGENAME ne: every program");

// The hook as the SDK calls it.
const hooks = guardHooks({ settings: async () => ({ mode: "all" }), protectedPids: pids });
const matcher = hooks.PreToolUse[0];
check(matcher.matcher.split("|").includes("Bash") && matcher.matcher.split("|").includes("PowerShell"),
  "the hook watches Bash and PowerShell", matcher.matcher);
const hook = matcher.hooks[0];
const call = (command) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: dir });
const denied = await call("pkill layr");
const out = denied?.hookSpecificOutput;
check(out?.permissionDecision === "deny" && out.hookEventName === "PreToolUse" && out.permissionDecisionReason,
  "a refused command gets permissionDecision deny, with the reason", denied);
const passed = await call("ls");
check(passed?.continue === true && !passed.hookSpecificOutput, "an allowed command goes on", passed);
const noCommand = await hook({ hook_event_name: "PreToolUse", tool_name: "Monitor", tool_input: { ws: { url: "x" } } });
check(noCommand?.continue === true, "a Monitor on a WebSocket goes on");
const broken = guardHooks({ settings: async () => { throw new Error("hub down"); }, protectedPids: pids });
const safe = await broken.PreToolUse[0].hooks[0]({ tool_input: { command: "taskkill /IM vite.exe" } });
check(safe?.hookSpecificOutput?.permissionDecision === "deny", "settings unavailable: every kill by name refused");
let logged = null;
const off = guardHooks({ settings: () => ({ mode: "off" }), protectedPids: pids, onBlock: (c) => (logged = c) });
const offOut = await off.PreToolUse[0].hooks[0]({ tool_input: { command: `taskkill /T /F /PID ${APP}` } });
check(offOut?.hookSpecificOutput?.permissionDecision === "deny" && logged === `taskkill /T /F /PID ${APP}`,
  "off: the app's id still refused, and said to onBlock");

// layr's ids, and the environment threads get.
check(layrPids({ pid: 5, ppid: 7 }).join() === "5,7", "layrPids: this engine and the core that started it");
process.env.LAYR_HOME = "C:\\somewhere\\layr-dev";
check(!("LAYR_HOME" in claudeEnv()), "threads don't get LAYR_HOME (the running app's home)");

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
