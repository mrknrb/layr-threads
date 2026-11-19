// Subagents of a thread: the Agent tool's workers, each a conversation of its own (0.3.9).
//
// Claude Code forwards a subagent's whole conversation (forwardSubagentText) with `parent_tool_use_id` (the Agent
// call that started it, kept when the subagent is resumed) and `agent_id` (its id, the task_id of its task events).
// The engine keeps each thread's subagents in its metadata (`subagents`); older threads have only their Agent calls,
// whose result says "agentId: <id>". The user writes to a subagent through the main agent: layr has no way to write
// to it directly, so the main agent is asked to pass the message on, word for word, with SendMessage, which resumes
// a finished subagent too, with its context. A thread's older subagent conversations (from before layr forwarded
// their text) are read from Claude Code's own transcript of the subagent (getSubagentMessages).

const TOOL_RESULT_MAX = 20_000;

/** The subagent id an Agent call's result names ("agentId: a7a4…"), or null. */
export function agentIdIn(text) {
  return /agentId:\s*([0-9a-f]{8,})/i.exec(String(text ?? ""))?.[1] ?? null;
}

/**
 * A thread's subagent by its id: from the thread's `subagents`, else found in its transcript (an Agent call whose
 * result names it). {id, toolUseId, description, type, status} or null.
 */
export function findSubagent(meta, entries, agentId) {
  const known = (meta.subagents ?? []).find((s) => s.id === agentId);
  if (known) return known;
  const result = entries.find((e) => e.type === "tool_result" && agentIdIn(e.content) === agentId);
  if (!result) return null;
  const call = entries.find((e) => e.type === "tool_use" && e.id === result.id);
  return {
    id: agentId,
    toolUseId: result.id,
    description: String(call?.input?.description ?? ""),
    type: call?.input?.subagent_type ?? null,
    status: "done",
  };
}

/** The message the main agent gets for the user's message to a subagent: pass it on, word for word. */
export function relayPrompt(relay, text) {
  const name = relay.description ? `"${relay.description}" (agent id ${relay.agent})` : `with agent id ${relay.agent}`;
  return (
    `The user wrote a message to your subagent ${name}, in layr's view of that subagent. Pass it on word for word: ` +
    `call SendMessage with to: "${relay.agent}" and the text between the <message> tags as its message (load ` +
    `SendMessage with ToolSearch first if it isn't loaded). Don't answer it, act on it or add to it yourself. Then ` +
    `go on with what you were doing; if you had nothing else to do, reply only "Passed on." The user reads the ` +
    `subagent's answer in that view: when it comes back to you, don't repeat, summarize or comment on it; use it ` +
    `if it matters for your own work, and if it doesn't, reply only "Noted."\n\n<message>\n${text}\n</message>`
  );
}

/** Text Claude Code adds for the model only (reminders): not shown as a message. */
function harnessOnly(text) {
  const t = String(text ?? "").trim();
  return !t || /^<(system-reminder|local-command-[a-z]+|command-[a-z]+)>[\s\S]*<\/\1>$/.test(t);
}

/** What a user message of a subagent says to it (its task, a message passed on), or "" (only tool results). */
export function userText(content) {
  if (typeof content === "string") return harnessOnly(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && !harnessOnly(b.text))
    .map((b) => b.text)
    .join("\n");
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/**
 * A subagent's conversation, from Claude Code's transcript of it (getSubagentMessages), as thread entries under its
 * Agent call `toolUseId`: what it was told (by: "claude"), its text, thoughts, tool calls and results.
 */
export function subagentEntries(messages, toolUseId, agentId) {
  const out = [];
  let n = 0;
  const add = (e) => out.push({ seq: -1, ...e, parent: toolUseId, agent: agentId, disk: true });
  for (const m of messages ?? []) {
    const content = m?.message?.content;
    const key = m?.uuid ?? `d${n++}`;
    if (m?.type === "user") {
      const text = userText(content);
      if (text) add({ type: "user", id: `${key}:u`, text, by: "claude" });
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== "tool_result") continue;
        let text = "";
        let images = 0;
        if (typeof b.content === "string") text = b.content;
        else for (const c of b.content ?? []) c?.type === "text" ? (text += (text ? "\n" : "") + c.text) : c?.type === "image" && images++;
        add({ type: "tool_result", id: b.tool_use_id, content: truncate(text, TOOL_RESULT_MAX), isError: b.is_error === true,
          ...(images ? { images } : {}) });
      }
    } else if (m?.type === "assistant") {
      (Array.isArray(content) ? content : []).forEach((b, i) => {
        if (b?.type === "text" && b.text) add({ type: "text", id: `${key}:${i}`, text: b.text });
        else if (b?.type === "thinking" && b.thinking) add({ type: "thinking", id: `${key}:${i}`, text: b.thinking });
        else if (b?.type === "tool_use") add({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
      });
    }
  }
  return out;
}
