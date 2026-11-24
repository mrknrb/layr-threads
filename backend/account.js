// What Claude Code on this PC offers: the signed-in account, its models with their effort levels, and plan usage.
// Read by starting Claude Code without sending a prompt, which costs nothing (as today's layr does in ai.ts).
//
// The limits belong to one account (its email). The accounts plugin can switch the PC's login at any time: the email
// Claude Code is signed in with is read from its global config (`~/.claude.json` `oauthAccount`, parsed only when the
// file changed) on every usage read, every rate limit event and a watch every few seconds; when it differs, the old
// account's readings and refusal (`rejectedUntil`) are dropped at once and the new account's are measured fresh.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeEnv } from "./claudeEnv.js";
import { errorMessage, log } from "./util.js";

const MODELS_MS = 30 * 60_000;
const USAGE_MS = 5 * 60_000;
const WATCH_MS = Number(process.env.LAYR_CLAUDE_ACCOUNT_WATCH_MS || 5000);
// `rejectedType`: the window the refusal came from (0.15.3), so a report on another window doesn't drop it.
const EMPTY_LIMITS = {
  fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, rejectedUntil: null, rejectedType: null,
};

/** Claude Code's global config, where the signed-in account is (found as the accounts plugin's files.js does). */
export function claudeConfigPath(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const legacy = path.join(configDir || path.join(os.homedir(), ".claude"), ".config.json");
  try {
    if (existsSync(legacy) && statSync(legacy).isFile() && statSync(legacy).size > 0) return legacy;
  } catch {
    // unreadable: the usual one
  }
  return path.join(configDir || os.homedir(), ".claude.json");
}

/** Used when Claude Code can't be asked (offline, not signed in yet). */
export const FALLBACK_MODELS = [
  { id: "opus", label: "Opus", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"], thinking: true },
  { id: "sonnet", label: "Sonnet", description: "Fast and capable", efforts: ["low", "medium", "high", "max"], thinking: true },
  { id: "haiku", label: "Haiku", description: "Fastest", efforts: [], thinking: false },
];

export class Account {
  /** `configPath`: Claude Code's global config (tests); `onAccountChanged(email)`: a switch was seen, or measured. */
  constructor({ configPath, onAccountChanged } = {}) {
    this.models = null;
    this.modelsAt = 0;
    this.account = null;
    this.error = null;
    this.limits = { ...EMPTY_LIMITS };
    this.limitsAt = 0;
    this.limitsSource = null;
    this.usageCheckedAt = 0;
    this.windows = [];
    this.probing = null;
    this.configPath = configPath ?? claudeConfigPath();
    /** The config file as last read: {mtimeMs, size, email}. */
    this.live = null;
    /** The email the limits are of: undefined before the first one is known. */
    this.limitsAccount = undefined;
    this.onAccountChanged = onAccountChanged ?? null;
    this.watchTimer = null;
  }

  /**
   * The email Claude Code is signed in with now, from its global config: a string, null when it isn't signed in with
   * an account (signed out, an API key), undefined when the file can't be read. Parsed again only when it changed.
   */
  liveEmail() {
    try {
      const st = statSync(this.configPath);
      if (this.live && this.live.mtimeMs === st.mtimeMs && this.live.size === st.size) return this.live.email;
      const config = JSON.parse(readFileSync(this.configPath, "utf8"));
      const email = config?.oauthAccount?.emailAddress ?? null;
      this.live = { mtimeMs: st.mtimeMs, size: st.size, email };
      return email;
    } catch {
      // Missing, or half written (Claude Code rewrites it often): what was read last.
      return this.live?.email;
    }
  }

  /**
   * The account is `email` now: when the limits were another account's, they and its refusal are dropped, and the
   * next usage read measures again. Gives true when it switched.
   */
  noteAccount(email) {
    if (!email || this.limitsAccount === email) return false;
    const before = this.limitsAccount;
    this.limitsAccount = email;
    if (before === undefined) return false;
    log(`the Claude account is now ${email} (was ${before}): its limits are read fresh`);
    this.limits = { ...EMPTY_LIMITS };
    this.windows = [];
    this.limitsAt = 0;
    this.limitsSource = null;
    this.usageCheckedAt = 0;
    if (this.account?.email !== email) this.account = { email };
    this.onAccountChanged?.(email);
    return true;
  }

  /** Look at the live login: true when the account switched since the last look. */
  checkAccount() {
    return this.noteAccount(this.liveEmail());
  }

  /** Watch the live login: a switch drops the old limits at once and measures the new account's in the background. */
  watch(ms = WATCH_MS) {
    clearInterval(this.watchTimer);
    this.checkAccount();
    this.watchTimer = setInterval(() => {
      if (!this.checkAccount()) return;
      void this.probe({ withUsage: true }).then(() => this.onAccountChanged?.(this.limitsAccount));
    }, ms);
    this.watchTimer.unref?.();
  }

  stopWatching() {
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  /** Start Claude Code idle: account, models and (optionally) plan usage. */
  probe({ withUsage = false } = {}) {
    this.probing ??= (async () => {
      let end;
      const ended = new Promise((resolve) => (end = resolve));
      async function* idle() {
        await ended;
      }
      const q = query({
        prompt: idle(),
        options: { settingSources: [], tools: [], persistSession: false, env: claudeEnv(), cwd: process.cwd() },
      });
      try {
        const init = await withTimeout(q.initializationResult(), 60_000, "Claude Code did not start in a minute");
        this.noteAccount(init.account?.email ?? null);
        this.account = init.account ?? null;
        const models = (init.models ?? []).map(modelFromInfo);
        if (models.length) {
          this.models = models;
          this.modelsAt = Date.now();
        }
        this.error = null;
        if (withUsage) {
          this.usageCheckedAt = Date.now();
          const usage = await q
            .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
            .catch((error) => void log("plan usage unavailable:", errorMessage(error)));
          if (usage) this.setUsage(usage);
        }
      } catch (error) {
        this.error = errorMessage(error);
        log("Claude Code probe failed:", this.error);
      } finally {
        end();
        try {
          q.close();
        } catch {
          // closed already
        }
      }
    })().finally(() => (this.probing = null));
    return this.probing;
  }

  async listModels() {
    if (!this.models || Date.now() - this.modelsAt > MODELS_MS) await this.probe();
    return this.models ?? FALLBACK_MODELS;
  }

  /** Remember models a running thread's Claude Code reported (supportedModels). */
  setModels(infos) {
    const models = (infos ?? []).map(modelFromInfo);
    if (models.length) {
      this.models = models;
      this.modelsAt = Date.now();
    }
  }

  async usage({ refresh = false } = {}) {
    // Another account since the last reading: its limits are measured now, not in up to 5 minutes.
    if (this.checkAccount()) refresh = true;
    if (refresh || Date.now() - this.usageCheckedAt > USAGE_MS) await this.probe({ withUsage: true });
    return {
      account: this.account
        ? { email: this.account.email ?? null, subscription: this.account.subscriptionType ?? null,
            provider: this.account.apiProvider ?? null }
        : null,
      limits: this.limits,
      windows: this.windows,
      source: this.limitsSource,
      updatedAt: this.limitsAt ? new Date(this.limitsAt).toISOString() : null,
      error: this.error,
    };
  }

  setUsage(usage) {
    this.limitsAt = Date.now();
    this.limitsSource = "usage";
    if (!usage.rate_limits_available || !usage.rate_limits) return;
    const w = (x) => (x ? { utilization: x.utilization, resetsAt: x.resets_at } : null);
    const r = usage.rate_limits;
    this.windows = (Array.isArray(r.limits) ? r.limits : []).map((l) => ({
      kind: l.kind,
      group: l.group,
      percent: l.percent,
      resetsAt: l.resets_at,
      model: l.scope?.model?.display_name ?? null,
    }));
    this.limits = {
      ...this.limits,
      fiveHour: w(r.five_hour),
      sevenDay: w(r.seven_day),
      sevenDayOpus: w(r.seven_day_opus),
      sevenDaySonnet: w(r.seven_day_sonnet),
    };
  }

  /** Runs report rate limits one window at a time (rate_limit_event). */
  setRateLimit(info) {
    if (!info) return;
    this.checkAccount();
    const resetsAt = info.resetsAt
      ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString()
      : null;
    const key = {
      five_hour: "fiveHour",
      seven_day: "sevenDay",
      seven_day_opus: "sevenDayOpus",
      seven_day_sonnet: "sevenDaySonnet",
    }[info.rateLimitType];
    if (key) {
      const prev = this.limits[key];
      const utilization =
        info.utilization === undefined
          ? (prev?.utilization ?? null)
          : info.utilization <= 1
            ? Math.round(info.utilization * 1000) / 10
            : info.utilization;
      this.limits[key] = { utilization, resetsAt: resetsAt ?? prev?.resetsAt ?? null };
    }
    // 0.15.3: a refusal holds until its time, or until the same window reports room; an "allowed" report about another
    // window (the five-hour one while the weekly Opus one refuses) used to drop it, and paused threads went on at once.
    const type = info.rateLimitType ?? null;
    if (info.status === "rejected") {
      this.limits.rejectedUntil = resetsAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
      this.limits.rejectedType = type;
    } else if (
      !this.limits.rejectedUntil ||
      (this.limits.rejectedType ?? null) === type ||
      Date.parse(this.limits.rejectedUntil) <= Date.now()
    ) {
      this.limits.rejectedUntil = null;
      this.limits.rejectedType = null;
    }
    this.limitsAt = Date.now();
    this.limitsSource = "event";
  }
}

function modelFromInfo(m) {
  return {
    id: m.value,
    label: m.displayName || m.value,
    description: m.description || "",
    resolved: m.resolvedModel ?? null,
    efforts: m.supportedEffortLevels ?? [],
    thinking: m.supportsAdaptiveThinking === true,
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => clearTimeout(timer));
}
