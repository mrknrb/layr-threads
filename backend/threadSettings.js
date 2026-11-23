// Claude Code settings layered over the user's own for every layr thread (the SDK's flag settings, highest
// priority after policy). They keep a thread's context lean: what layr threads never use is hidden, so it costs no
// tokens on every turn. On 2026-11-16: about 3,000 input tokens less on each first turn (estimated), more with the
// claude.ai connectors loaded. Outside layr, Claude Code keeps all of it.

/** skillOverrides: "off" hides a skill; "name-only" lists it without its description (Claude still finds it by name);
 * "user-invocable-only" keeps only its /command. Computer use, the browsers and Claude Code's own skills stay. */
const SKILLS = {
  // claude.ai's synced skills that have nothing to do with coding in layr.
  docs: "off",
  "google-workspace": "off",
  morning: "off",
  "import-memory": "off",
  "skill-creator": "off",
  "deep-research": "off",
  // Office files and charts: rare, so only their names stay listed.
  docx: "name-only",
  xlsx: "name-only",
  pptx: "name-only",
  pdf: "name-only",
  dataviz: "name-only",
};

export const THREAD_SETTINGS = {
  // claude.ai's connectors (Claude Docs, Google Drive, Gmail, Calendar): layr's own plugins come through its hub.
  disableClaudeAiConnectors: true,
  skillOverrides: SKILLS,
  // Claude Code plugins installed for other work.
  enabledPlugins: { "typesafe@typesafe-ai": false },
};

/** The settings of one thread: THREAD_SETTINGS, unless LAYR_CLAUDE_FULL_CONTEXT=1 (everything, as in Claude Code). */
export function threadSettings(env = process.env) {
  return env.LAYR_CLAUDE_FULL_CONTEXT === "1" ? null : THREAD_SETTINGS;
}
