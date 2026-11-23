// Boxed replies: a reply written under fixed headings (Summary, Changes, Questions…, the user's global CLAUDE.md
// "Replies" format) is cut into sections the thread panel draws as coloured boxes. Each list item's first line is its
// short version; the lines under it are the long one, and sub-items starting with "Example:", "Simply:" or "Why:" are
// extras opened one by one. Questions are numbered items with lettered answers, the ⭐ one recommended; a question
// starting with ☑️ is multiple choice (the panel adds a "None of them" answer). A reply without any of these headings
// is drawn as plain Markdown. No DOM here (the unit tests run it in Node); replies.js draws it.
import { Lexer } from "./vendor/marked.esm.js";

/** Every heading a section may have, by kind; the first is the one shown. */
export const SECTION_TITLES = {
  summary: ["Summary", "TL;DR"],
  changes: ["Changes", "What changed"],
  decisions: ["Decisions", "Decided"],
  questions: ["Questions"],
  needs: ["Needs you", "Action needed", "Your turn"],
  problems: ["Problems", "Issues", "Not done"],
  risks: ["Risks", "Risk"],
  checks: ["Checks", "Checked", "Verified"],
  test: ["How to test", "Testing", "To test"],
  next: ["Next", "Next steps", "Ideas", "Follow-ups"],
  notes: ["Notes", "Note"],
};

const EXTRA_LABELS = { example: "Example", simply: "Simply", eli5: "Simply", why: "Why" };

function normalize(title) {
  return String(title)
    .replace(/[*_`]/g, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim()
    .toLowerCase();
}

const KIND_BY_TITLE = new Map(
  Object.entries(SECTION_TITLES).flatMap(([kind, titles]) => titles.map((t) => [normalize(t), kind])),
);

/** A heading's kind (`## Changes`, `### ✅ Checks:`), or null when it isn't one of the sections. */
export const sectionKind = (title) => KIND_BY_TITLE.get(normalize(title)) ?? null;

/**
 * The line a reply ends with: `Status: done · Risk: database · Try: ready` → {status, risks, try?}, and the text
 * before it. No such line: the text as it is and status null.
 */
export function splitStatusLine(text) {
  const full = String(text ?? "");
  const trimmed = full.replace(/\s+$/, "");
  const cut = trimmed.lastIndexOf("\n");
  const last = trimmed.slice(cut + 1).replace(/^[*_`>\s]+|[*_`\s]+$/g, "");
  if (!/^status\s*:/i.test(last)) return { text: full, status: null };
  const clean = (s) => s.replace(/[*_`]/g, "").trim();
  const parts = new Map();
  for (const part of last.split(/\s*[·|•]\s*/)) {
    const at = part.indexOf(":");
    if (at > 0) parts.set(clean(part.slice(0, at)).toLowerCase(), clean(part.slice(at + 1)));
  }
  const risk = parts.get("risk") ?? parts.get("risks") ?? "";
  const risks = /^(none|no|-|—)?$/i.test(risk) ? [] : risk.split(/\s*[,;/]\s*/).filter(Boolean);
  const tryIt = parts.get("try");
  const status = { status: parts.get("status") ?? "", risks, ...(tryIt ? { try: tryIt } : {}) };
  return { text: cut < 0 ? "" : trimmed.slice(0, cut), status };
}

/**
 * The message cut into sections [{kind, parts}], or null when it has none of the known headings. A part is
 * {type: "prose", markdown} | {type: "list", ordered, start, items: [{short, long, extras}]} |
 * {type: "questions", questions: [{number, text, detail, options: [{letter, text, why, starred, score?}], multi}]} |
 * {type: "status", status, risks, try?}.
 */
export function parseBoxes(full) {
  const { text, status } = splitStatusLine(full);
  const tokens = new Lexer({ gfm: true }).lex(text);
  const sections = [];
  let current = { kind: null, depth: 0, tokens: [] };
  const close = () => {
    const parts = toParts(current.kind, current.tokens);
    if (current.kind || parts.length) sections.push({ kind: current.kind, parts });
  };
  for (const token of tokens) {
    if (token.type === "heading") {
      const kind = sectionKind(token.text);
      // A known heading starts a section; an unknown one as high as the section's own ends it.
      if (kind || (current.kind && token.depth <= current.depth)) {
        close();
        current = { kind, depth: token.depth, tokens: kind ? [] : [token] };
        continue;
      }
    }
    current.tokens.push(token);
  }
  close();
  if (status) sections.push({ kind: null, parts: [{ type: "status", ...status }] });
  return sections.some((s) => s.kind) ? sections : null;
}

function toParts(kind, tokens) {
  const parts = [];
  let prose = [];
  const flush = () => {
    const markdown = rawOf(prose).trim();
    if (markdown) parts.push({ type: "prose", markdown });
    prose = [];
  };
  for (const token of tokens) {
    if (token.type !== "list" || !kind || kind === "notes") {
      prose.push(token);
      continue;
    }
    flush();
    const start = token.ordered && typeof token.start === "number" ? token.start : 1;
    if (kind === "questions") {
      parts.push({ type: "questions", questions: token.items.map((item, i) => toQuestion(item, start + i)) });
    } else {
      parts.push({ type: "list", ordered: token.ordered, start, items: token.items.map(toItem) });
    }
  }
  flush();
  return parts;
}

const rawOf = (tokens) => tokens.map((t) => t.raw).join("");

/** The item's first line, and the tokens after it. */
function split(item) {
  const [head, ...rest] = item.tokens;
  if (!head || (head.type !== "text" && head.type !== "paragraph")) return { first: "", rest: item.tokens };
  const raw = head.raw.replace(/\n+$/, "");
  const cut = raw.indexOf("\n");
  if (cut < 0) return { first: raw, rest };
  return { first: raw.slice(0, cut), rest: [{ type: "paragraph", raw: `${raw.slice(cut + 1)}\n\n` }, ...rest] };
}

const EXTRA = /^\**\s*(example|simply|eli5|why)\s*:\s*\**\s*([\s\S]*)$/i;

function toItem(item) {
  const { first, rest } = split(item);
  const extras = [];
  const long = [];
  for (const token of rest) {
    if (token.type !== "list") {
      long.push(token.raw);
      continue;
    }
    const kept = [];
    for (const sub of token.items) {
      const match = sub.text.match(EXTRA);
      if (match) extras.push({ label: EXTRA_LABELS[match[1].toLowerCase()], text: match[2].replace(/^\*+\s*/, "").trim() });
      else kept.push(sub.raw.replace(/\n+$/, ""));
    }
    if (kept.length) long.push(`${kept.join("\n")}\n\n`);
  }
  return { short: first.trim(), long: long.join("").trim(), extras };
}

/** `A. text ⭐ **why**`, `**B)** text **why**`, `C ⭐ text. **why**` */
const OPTION = /^\**([A-Z])\**(?:[.):]|\s*[-–—])?\**(?=\s)\s*([\s\S]*)$/;
/** ☑️ (with or without its emoji selector) first in a question: several answers can be picked. */
const MULTI = /^☑️?\s*/u;

function toQuestion(item, number) {
  const { first, rest } = split(item);
  const options = [];
  const detail = [];
  for (const token of rest) {
    if (token.type !== "list") {
      detail.push(token.raw);
      continue;
    }
    for (const sub of token.items) {
      const option = toOption(sub.text.trim());
      if (option) options.push(option);
      else detail.push(`${sub.raw.replace(/\n+$/, "")}\n`);
    }
  }
  // "3. Which one?" written inside an unordered list keeps its own number.
  const numbered = first.match(/^(\d+)[.)]\s+(.*)$/);
  let text = (numbered ? numbered[2] : first).trim();
  // The user's format: `☑️ 🚩 9 🔴 Which…` (☑️ first), `4 ⚪ Where…`; a 🚩 written before the ☑️ is forgiven.
  const multi = /^(?:🚩\s*)?☑/u.test(text);
  text = text.replace(MULTI, "");
  return {
    number: numbered ? Number(numbered[1]) : number,
    text,
    detail: detail.join("").trim(),
    options,
    multi,
  };
}

function toOption(text) {
  const match = text.replace(/\n/g, " ").match(OPTION);
  if (!match) return null;
  let body = match[2];
  const starred = body.includes("⭐");
  body = body.replaceAll("⭐", " ");
  // The reason is the last bold part, when something comes before it.
  const reason = body.match(/^([\s\S]*\S)\s*\*\*([^*]+)\*\*\s*$/);
  const why = reason ? reason[2].trim() : "";
  const label = (reason ? reason[1] : body).replace(/\s+/g, " ").trim().replace(/[.:,;–—-]+$/, "").trim();
  // `Haiku (90%)` or `Haiku 90%`: the score is taken out of the text and drawn as its own badge.
  const scored = label.match(/\s*\(?(\d{1,3})%\)?$/);
  const score = scored && Number(scored[1]) <= 100 ? Number(scored[1]) : undefined;
  const answer = score === undefined ? label : label.slice(0, scored.index).trim();
  return { letter: match[1], text: answer, why, starred, ...(score !== undefined ? { score } : {}) };
}

/** A message's questions, in order. */
export const questionsOf = (sections) =>
  (sections ?? []).flatMap((s) => s.parts.flatMap((p) => (p.type === "questions" ? p.questions : [])));

/** The answer the panel adds under every multiple choice question: none of Claude's. */
export const NONE = "none";
export const NONE_TEXT = "None of them";

/**
 * Picks: {[question number]: letters (or [NONE])}. Nothing picked for a question means the ⭐ ones. The key AGREE (0,
 * questions are numbered from 1) says you agree with every ⭐ answer: set by the button under the questions, dropped
 * by any other pick.
 */
export const AGREE = 0;
export const AGREE_TEXT = "I agree with everything recommended";
export const answersText = (changes) => `My answers: ${changes}. Everything else as recommended.`;

/** The answers shown as chosen: what's picked, or the ⭐ ones while nothing is. */
export function chosenOf(question, picks) {
  return picks?.length ? picks : question.options.filter((o) => o.starred).map((o) => o.letter);
}

export const agreed = (picked) => Boolean(picked?.[AGREE]?.length);

/** What's picked after the agree button: only the agreement, or nothing when it was on. */
export const toggleAgree = (picked) => (agreed(picked) ? {} : { [AGREE]: ["all"] });

/**
 * One question's picks after clicking an answer. One answer, unless it is multiple choice: then answers add up, and
 * even one pick replaces all the ⭐ ones. Clicking a picked answer takes it back; None of them goes alone.
 */
export function pick(question, picks, letter) {
  const current = picks ?? [];
  if (current.includes(letter)) return current.filter((l) => l !== letter);
  if (!question.multi || letter === NONE) return [letter];
  const order = question.options.map((o) => o.letter);
  return [...current.filter((l) => l !== NONE), letter].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** All picks after clicking an answer: that question's change, and the agreement dropped. */
export function pickIn(picked, question, letter) {
  const rest = { ...(picked ?? {}) };
  delete rest[AGREE];
  return { ...rest, [question.number]: pick(question, rest[question.number], letter) };
}

/**
 * What goes in front of the next message. Nothing picked says nothing; the agree button says "I agree with
 * everything recommended"; answers that differ from the ⭐ ones say "My answers: 1B, 2AC, 3 None of them. Everything
 * else as recommended.", so changing an answer agrees to the rest. Picks equal to the ⭐ ones say nothing of their own.
 */
export function answerPrefix(questions, picked) {
  const changes = questions
    .flatMap((q) => {
      const letters = (picked?.[q.number] ?? []).filter((l) => (l === NONE && q.multi) || q.options.some((o) => o.letter === l));
      if (!letters.length) return [];
      if (letters.includes(NONE)) return [`${q.number} ${NONE_TEXT}`];
      const starred = q.options.filter((o) => o.starred).map((o) => o.letter);
      if (letters.length === starred.length && letters.every((l) => starred.includes(l))) return [];
      return [`${q.number}${letters.join("")}`];
    })
    .join(", ");
  if (changes) return answersText(changes);
  return questions.length && agreed(picked) ? AGREE_TEXT : "";
}

/** Whether any answer is picked (or agreed). */
export const hasPicks = (picked) => Object.values(picked ?? {}).some((p) => p?.length);
