// What Claude Code on this PC offers: the signed-in account, its models with their effort levels, and plan usage.
// Read by starting Claude Code without sending a prompt, which costs nothing (as today's layr does in ai.ts).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv } from "./claudeEnv.js";
import { errorMessage, log } from "./util.js";

const MODELS_MS = 30 * 60_000;
const USAGE_MS = 5 * 60_000;

/** Used when Claude Code can't be asked (offline, not signed in yet). */
export const FALLBACK_MODELS = [
  { id: "opus", label: "Opus", description: "Most capable", efforts: ["low", "medium", "high", "xhigh", "max"], thinking: true },
  { id: "sonnet", label: "Sonnet", description: "Fast and capable", efforts: ["low", "medium", "high", "max"], thinking: true },
  { id: "haiku", label: "Haiku", description: "Fastest", efforts: [], thinking: false },
];

export class Account {
  constructor() {
    this.models = null;
    this.modelsAt = 0;
    this.account = null;
    this.error = null;
    this.limits = { fiveHour: null, sevenDay: null, sevenDayOpus: null, sevenDaySonnet: null, rejectedUntil: null };
    this.limitsAt = 0;
    this.limitsSource = null;
    this.usageCheckedAt = 0;
    this.windows = [];
    this.probing = null;
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
    this.limits.rejectedUntil = info.status === "rejected" ? (resetsAt ?? new Date(Date.now() + 15 * 60_000).toISOString()) : null;
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
