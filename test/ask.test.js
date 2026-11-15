// Offline test of the one-shot `ask` tool (backend/ask.js) and of thread_start's allowedTools (engine.js), with a fake
// Agent SDK query: no Claude usage. Run: node test/ask.test.js
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, askArgs, askOptions } from "../backend/ask.js";
import { allowedToolsOf, PERMISSION_MODES } from "../backend/engine.js";

let failures = 0;
function check(ok, what, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (error) {
    return re.test(error.message);
  }
};

// Arguments
check(throws(() => askArgs({ prompt: "  " }), /empty/), "an empty prompt is refused");
check(throws(() => askArgs({ prompt: "hi", effort: "huge" }), /effort is one of/), "an unknown effort is refused");
const a = askArgs({ prompt: "Say hi" });
check(a.model === "haiku" && a.system === null && a.effort === null, "haiku by default, no system, no effort", a);
check(askArgs({ prompt: "x", model: " sonnet ", effort: "low" }).model === "sonnet", "a model is kept (trimmed)");

// Options: one turn, no tools, nothing saved, no settings files (no CLAUDE.md), nobody asked
const o = askOptions(askArgs({ prompt: "x", system: "Be short", effort: "low" }));
check(o.maxTurns === 1, "one turn");
check(Array.isArray(o.tools) && o.tools.length === 0, "no tools");
check(Array.isArray(o.settingSources) && o.settingSources.length === 0, "no settings files");
check(o.persistSession === false, "no saved session");
check(o.permissionMode === "dontAsk", "nothing is asked");
check(o.systemPrompt === "Be short" && o.effort === "low" && o.model === "haiku", "system, effort and model passed");
check(!("ANTHROPIC_API_KEY" in o.env) || process.env.LAYR_CLAUDE_USE_API_KEY === "1", "no API key unless asked for");

// A fake query: the SDK's message stream
function fakeQuery(messages, seen) {
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    let closed = false;
    return {
      close: () => (closed = true),
      get closed() {
        return closed;
      },
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    };
  };
}
const seen = [];
const answer = await ask(
  { prompt: "What is 2+2?" },
  {
    query: fakeQuery(
      [
        { type: "system", subtype: "init", model: "claude-haiku-x" },
        { type: "assistant", message: { content: [{ type: "text", text: "4" }] } },
        { type: "result", subtype: "success", result: "4", usage: { input_tokens: 10, output_tokens: 1 } },
      ],
      seen,
    ),
  },
);
check(answer.text === "4", "the answer's text", answer);
check(answer.model === "claude-haiku-x", "the model that answered");
check(answer.usage?.inputTokens === 10 && answer.usage.outputTokens === 1, "its usage");
check(seen[0].prompt === "What is 2+2?" && seen[0].options.maxTurns === 1, "the prompt reached the query");

let failed = null;
try {
  await ask({ prompt: "x" }, { query: fakeQuery([{ type: "result", subtype: "error_max_turns", is_error: true }], []) });
} catch (error) {
  failed = error.message;
}
check(/couldn't answer/.test(failed ?? ""), "a failed turn throws", failed);

let slow = null;
const never = () => ({ close() {}, async *[Symbol.asyncIterator]() { await new Promise(() => {}); } });
try {
  await ask({ prompt: "x" }, { query: never, timeoutMs: 50 });
} catch (error) {
  slow = error.message;
}
check(/No answer/.test(slow ?? ""), "it gives up after the timeout", slow);

// thread_start's allowedTools and the dontAsk mode
check(PERMISSION_MODES.includes("dontAsk"), "dontAsk is a permission mode");
check(JSON.stringify(allowedToolsOf([" Read ", "Read", "", "mcp__layr__pipeline__propose"])) === '["Read","mcp__layr__pipeline__propose"]', "allowedTools cleaned");
check(allowedToolsOf(undefined).length === 0, "no allowedTools: none");
check(throws(() => allowedToolsOf("Read"), /list/), "allowedTools must be a list");

// The tool is registered with its arguments (server.js starts the backend when imported, so read its source)
const here = path.dirname(fileURLToPath(import.meta.url));
const server = readFileSync(path.join(here, "..", "backend", "server.js"), "utf8");
check(/tool\(\s*"ask",/.test(server), "the ask tool is registered");
check(/allowedTools: z/.test(server), "thread_start takes allowedTools");

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
