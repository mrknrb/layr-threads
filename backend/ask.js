// One-shot questions (the `ask` tool): one Agent SDK turn with no tools, no saved session, no worktree and none of
// the user's or project's settings (no CLAUDE.md), for small background jobs other plugins have (a brief, a summary,
// a classification). It runs on the PC's Claude Code sign-in like every thread, so it counts against the same plan:
// haiku by default.
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import os from "node:os";
import { isConfigBroken } from "./claudeConfig.js";
import { claudeEnv } from "./claudeEnv.js";

export const ASK_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const ASK_DEFAULT_MODEL = "haiku";
const PROMPT_MAX = 200_000;
const TIMEOUT_MS = 5 * 60_000;
/** Claude Code couldn't read its config (`~/.claude.json` left empty by another one): asked again after these waits. */
export const ASK_CONFIG_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

/** Check the arguments (the tool's schema checks them too); gives them cleaned or throws why not. */
export function askArgs(a) {
  const prompt = String(a?.prompt ?? "");
  if (!prompt.trim()) throw new Error("The prompt is empty");
  if (prompt.length > PROMPT_MAX) throw new Error(`The prompt is longer than ${PROMPT_MAX} characters`);
  if (a.effort !== undefined && a.effort !== null && !ASK_EFFORTS.includes(a.effort)) {
    throw new Error(`effort is one of ${ASK_EFFORTS.join(", ")}`);
  }
  return {
    prompt,
    system: a.system?.trim() ? String(a.system) : null,
    model: a.model?.trim() ? String(a.model).trim() : ASK_DEFAULT_MODEL,
    effort: a.effort ?? null,
  };
}

/** The SDK options of one ask: one turn, no tools, nothing saved, no settings files. */
export function askOptions({ system, model, effort }) {
  return {
    model,
    ...(effort ? { effort } : {}),
    maxTurns: 1,
    tools: [],
    settingSources: [],
    persistSession: false,
    permissionMode: "dontAsk",
    cwd: os.tmpdir(),
    env: claudeEnv(),
    ...(system ? { systemPrompt: system } : {}),
  };
}

/**
 * Ask once and give `{text, model, usage?}`. `query`: the SDK's (tests pass a fake with the same shape: a function
 * of {prompt, options} giving an async iterable of SDK messages with close()). When Claude Code couldn't read its
 * config it is asked again after each of `retryMs`, `beforeRetry()` first (the engine's repairConfig).
 */
export async function ask(input, { query = sdkQuery, timeoutMs = TIMEOUT_MS, retryMs = ASK_CONFIG_RETRY_MS, beforeRetry } = {}) {
  const a = askArgs(input);
  for (let attempt = 0; ; attempt++) {
    try {
      return await askOnce(a, { query, timeoutMs });
    } catch (error) {
      if (attempt >= retryMs.length || !isConfigBroken(error?.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs[attempt]));
      await Promise.resolve(beforeRetry?.()).catch(() => {});
    }
  }
}

async function askOnce(a, { query, timeoutMs }) {
  const q = query({ prompt: a.prompt, options: askOptions(a) });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  try {
    return await Promise.race([read(q, a.model), timeout]);
  } finally {
    clearTimeout(timer);
    try {
      q.close?.();
    } catch {
      // closed already
    }
  }
}

async function read(q, model) {
  let text = "";
  let usage = null;
  let usedModel = model;
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init" && msg.model) usedModel = msg.model;
    else if (msg.type === "assistant") {
      const parts = (msg.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
      if (parts.length) text = parts.join("");
    } else if (msg.type === "result") {
      if (msg.is_error || (msg.subtype && msg.subtype !== "success")) {
        const why = msg.errors?.join("; ") || msg.result || msg.subtype || "failed";
        throw new Error(`Claude couldn't answer: ${why}`);
      }
      if (typeof msg.result === "string" && msg.result.trim()) text = msg.result;
      if (msg.usage) usage = { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 };
      break;
    }
  }
  return { text: text.trim(), model: usedModel, ...(usage ? { usage } : {}) };
}
