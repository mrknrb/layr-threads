// A turn that stops at the Claude account's usage limit is no failure (0.9.0): the conversation is kept, so the thread
// pauses and goes on by itself in the same session once the limit is over. These are the pure parts: spotting a
// limit, when it ends, and whether the account has room again before then (another account signed in).
//
// When it ends, in this order: the time the limit's own message says (`…limit reached|1731000000`, `resets 4pm`,
// `try again in 20 minutes`), the account's refusal (a rate_limit_event "rejected"), a window that is full; then a
// minute more, so the first try doesn't meet the limit's last second. Unknown: FALLBACK_MS, then it tries again
// (and pauses again if the limit still holds). Never longer than a week.

/** When nothing says when the limit ends, the thread tries again this much later. */
export const FALLBACK_MS = 30 * 60_000;
/** After the reset time, a little more. */
export const SLACK_MS = 60_000;
/** A pause this long (a weekly limit) is told to the user once. */
export const LONG_PAUSE_MS = 12 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** What the thread is told when it goes on after the limit (the user message it gets, marked `auto: "limit"`). */
export const LIMIT_NOTE =
  "[layr: your turn stopped at the Claude account's usage limit, which is over now. Carry on where you left off. " +
  "First check what was already done (files, git status, the output of what you ran) instead of assuming, and don't " +
  "redo finished steps.]";

/** The turn ended on a usage limit: Claude Code said so (`rate_limit`, a refusal), or its error text does. */
export function isLimitEnd({ sawLimit = false, error = "" } = {}) {
  if (sawLimit) return true;
  return /usage limit|limit reached|hit your limit|out of extra usage/i.test(String(error ?? ""));
}

/**
 * When the limit a message names resets, from its text alone (ISO), or null. `now` decides what "resets 4pm" means:
 * the next 4 pm on the PC's clock. (The pipeline reads limits the same way: plugins/pipeline/backend/limits.js.)
 */
export function resetFromText(text, now = Date.now()) {
  const s = String(text ?? "");
  const epoch = /\|\s*(\d{10,13})\b/.exec(s);
  if (epoch) {
    const n = Number(epoch[1]);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const inMin = /try again in (\d+)\s*(minutes?|mins?|hours?|h)\b/i.exec(s);
  if (inMin) return new Date(now + Number(inMin[1]) * (/^h/i.test(inMin[2]) ? 3_600_000 : 60_000)).toISOString();
  const m = /resets?\s+(?:at\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(s);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const ampm = m[5]?.toLowerCase();
  if (!ampm && !m[4]) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hour, minute);
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month >= 0) {
    at.setMonth(month, Number(m[2]));
    if (at.getTime() < now - 86_400_000) at.setFullYear(at.getFullYear() + 1);
  } else if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

const future = (iso, now) => !!iso && Date.parse(iso) > now;

/**
 * When a paused thread goes on (ISO): from the limit's message `text`, else the account's `limits` (Account.limits:
 * `rejectedUntil`, full windows), plus SLACK_MS; else `fallbackMs` from now. `known`: whether anything said when.
 */
export function pauseUntil({ text = "", limits = null, now = Date.now(), fallbackMs = FALLBACK_MS } = {}) {
  let said = resetFromText(text, now);
  if (!future(said, now)) said = null;
  if (!said && future(limits?.rejectedUntil, now)) said = limits.rejectedUntil;
  if (!said) {
    const full = [limits?.fiveHour, limits?.sevenDay]
      .filter((w) => w && Number(w.utilization) >= 100 && future(w.resetsAt, now))
      .map((w) => w.resetsAt)
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    said = full[0] ?? null;
  }
  if (!said) return { until: new Date(now + fallbackMs).toISOString(), known: false };
  return { until: new Date(Math.min(Date.parse(said) + SLACK_MS, now + WEEK_MS)).toISOString(), known: true };
}

const pctOf = (w, now) => (!w || w.utilization == null || (w.resetsAt && Date.parse(w.resetsAt) <= now) ? 0 : Number(w.utilization));

/**
 * The account has room again before the pause ends: a reading taken after the pause began (`limitsAt`, ms) shows no
 * refusal and neither window full. Another account signed in drops the old one's readings, so its first reading counts.
 */
export function limitRoom(limits, limitsAt, since, now = Date.now()) {
  if (!limits || !limitsAt || !(limitsAt > Date.parse(since))) return false;
  if (!limits.fiveHour && !limits.sevenDay) return false;
  if (future(limits.rejectedUntil, now)) return false;
  return pctOf(limits.fiveHour, now) < 100 && pctOf(limits.sevenDay, now) < 100;
}

/** "16:00", or "Sat 16:00" when not today: when the pause ends, for the transcript and notifications. */
export function clockText(iso, now = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "later";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}
