// The environment Claude Code runs with.
//
// Claude runs on the Claude Code sign-in of this PC (the user's own subscription). An ANTHROPIC_API_KEY in the
// environment would silently switch it to paid API usage, so it is dropped unless LAYR_CLAUDE_USE_API_KEY=1.
// The core's own variables (the plugin's hub token above all) never reach Claude or the commands it runs.
export function claudeEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "layr-claude/0.1.0" };
  if (process.env.LAYR_CLAUDE_USE_API_KEY !== "1") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  for (const key of Object.keys(env)) {
    if (key === "LAYR_HUB_TOKEN" || key === "LAYR_HUB_URL" || key === "LAYR_PLUGIN_ID" || key === "LAYR_DATA_DIR") {
      delete env[key];
    }
  }
  // Nested Claude Code sessions refuse to start when this is set (the backend may be launched from one).
  delete env.CLAUDECODE;
  return env;
}
