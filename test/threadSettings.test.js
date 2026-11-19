// Unit test of the settings layered over every thread (backend/threadSettings.js), without Claude.
// Run: node test/threadSettings.test.js
import { THREAD_SETTINGS, threadSettings } from "../backend/threadSettings.js";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const levels = new Set(["on", "name-only", "user-invocable-only", "off"]);
const bad = Object.entries(THREAD_SETTINGS.skillOverrides).filter(([, v]) => !levels.has(v));
check(bad.length === 0, "every skill override is a level Claude Code knows", bad);
check(THREAD_SETTINGS.disableClaudeAiConnectors === true, "claude.ai connectors are off in threads");
check(!("run" in THREAD_SETTINGS.skillOverrides), "the run skill stays as it is");
check(!("computer-use" in THREAD_SETTINGS.skillOverrides), "computer use stays as it is");
check(threadSettings({}) === THREAD_SETTINGS, "the lean settings by default");
check(threadSettings({ LAYR_CLAUDE_FULL_CONTEXT: "1" }) === null, "LAYR_CLAUDE_FULL_CONTEXT=1: Claude Code's own");

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
