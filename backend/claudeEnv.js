// The environment Claude Code runs with.
//
// Claude runs on the Claude Code sign-in of this PC (the user's own subscription). An ANTHROPIC_API_KEY in the
// environment would silently switch it to paid API usage, so it is dropped unless LAYR_CLAUDE_USE_API_KEY=1.
// The core's own variables (the plugin's hub token above all) never reach Claude or the commands it runs. Nor does
// LAYR_HOME: the running app's home, which the layr CLI takes as its default, so a test's `layr serve` or
// `layr pkg link` without --home would act on the user's app. Nor LAYR_PACKAGES (its packages folder, where this
// plugin makes new plugins): a backend a thread starts for a test would make them in the user's app.
export function claudeEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "layr-claude/0.1.0" };
  if (process.env.LAYR_CLAUDE_USE_API_KEY !== "1") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const core = ["LAYR_HUB_TOKEN", "LAYR_HUB_URL", "LAYR_PLUGIN_ID", "LAYR_DATA_DIR", "LAYR_HOME", "LAYR_PACKAGES"];
  for (const key of core) delete env[key];
  // Nested Claude Code sessions refuse to start when this is set (the backend may be launched from one).
  delete env.CLAUDECODE;
  return env;
}
