// A reply drawn as boxes (boxes.js): one coloured box per section, list items short with their long version behind
// ▸ and extras (Example, Simply, Why) behind chips, the status line as chips, and questions whose answers can be
// picked in the latest reply. A reply without the known headings is plain Markdown.
import { NONE, NONE_TEXT, SECTION_TITLES, AGREE_TEXT, agreed, chosenOf, parseBoxes } from "./boxes.js";
import { h } from "./common.js";
import { inlineMarkdown, markdown } from "./render.js";

/**
 * The reply's element. `picker` (latest reply only): {picked, onPick(question, letter), onAgree()}; without it the
 * answers are shown, not pickable. Gives {el, sections} (sections null for plain Markdown).
 */
export function renderReply(text, picker = null) {
  const sections = parseBoxes(text);
  if (!sections) return { el: markdown(text), sections: null };
  const el = h("div", { class: "boxes" });
  for (const section of sections) {
    const parts = section.parts.map((p) => part(p, picker));
    if (!section.kind) el.append(...parts);
    else el.append(h("section", { class: `box box-${section.kind}` },
      section.kind === "notes" ? null : h("div", { class: "box-title" }, SECTION_TITLES[section.kind][0]), ...parts));
  }
  return { el, sections };
}

function part(p, picker) {
  if (p.type === "prose") return markdown(p.markdown);
  if (p.type === "list") return h(p.ordered ? "ol" : "ul", { class: "box-list", start: p.ordered ? String(p.start) : null }, p.items.map(item));
  if (p.type === "status") return statusChips(p);
  if (p.type === "questions") {
    const out = h("div", { class: "box-questions-list" }, p.questions.map((q) => question(q, picker)));
    if (picker) {
      const on = agreed(picker.picked);
      const agree = h("button", { class: `box-agree${on ? " chosen" : ""}`, title: on ? "Take it back" :
        "Agree with every ⭐ answer (questions you don't answer otherwise aren't agreed to)" }, on ? "✓ " : "", AGREE_TEXT);
      agree.addEventListener("click", () => picker.onAgree());
      out.append(agree);
    }
    return out;
  }
  return null;
}

function statusChips(s) {
  const risks = s.risks.length ? s.risks.map((r) => h("span", { class: "reply-chip risky" }, `risk: ${r}`)) : [h("span", { class: "reply-chip" }, "no risk")];
  return h("div", { class: "reply-status", title: "The status line the reply ends with" },
    s.status ? h("span", { class: "reply-chip" }, s.status) : null, ...risks,
    s.try ? h("span", { class: `reply-chip${s.try === "ready" ? " ready" : ""}` }, s.try === "ready" ? "ready to try" : `try: ${s.try}`) : null);
}

function item(it) {
  const li = h("li", {}, inlineMarkdown(it.short, "box-short"));
  let long = null;
  let extra = null;
  if (it.long) {
    const more = h("button", { class: "box-more", title: "Details" }, "▸");
    more.addEventListener("click", () => {
      if (long) {
        long.remove();
        long = null;
      } else {
        long = markdown(it.long, "md box-long");
        li.insertBefore(long, extra);
      }
      more.textContent = long ? "▾" : "▸";
    });
    li.append(more);
  }
  const chips = it.extras.map((e) => {
    const chip = h("button", { class: "box-chip" }, e.label);
    chip.addEventListener("click", () => {
      const wasOn = chip.classList.contains("on");
      for (const c of chips) c.classList.remove("on");
      extra?.remove();
      extra = null;
      if (!wasOn) {
        chip.classList.add("on");
        extra = markdown(e.text, "md box-extra");
        li.append(extra);
      }
    });
    return chip;
  });
  li.append(...chips);
  return li;
}

function question(q, picker) {
  const picks = picker?.picked?.[q.number];
  const chosen = chosenOf(q, picks);
  const option = (letter, text, starred, why, score) => {
    const b = h("button", { class: `box-option${chosen.includes(letter) ? " chosen" : ""}${letter === NONE ? " none" : ""}`, disabled: !picker },
      h("span", { class: "box-option-letter" }, letter === NONE ? "–" : letter, starred ? h("span", { class: "box-option-star", title: "Recommended" }, "⭐") : null),
      h("span", { class: "box-option-text" }, inlineMarkdown(text),
        score !== undefined ? h("span", { class: `box-option-score ${score >= 80 ? "high" : score >= 50 ? "mid" : "low"}`, title: "How reasonable Claude thinks this answer is" }, `${score}%`) : null,
        why ? h("span", { class: "box-option-why" }, ` ${why}`) : null));
    if (picker) b.addEventListener("click", () => picker.onPick(q, letter));
    return b;
  };
  return h("div", { class: `box-question${picks?.length ? " changed" : ""}` },
    h("div", { class: "box-question-title" }, h("span", { class: "box-question-number" }, `${q.number}.`), " ",
      q.multi ? h("span", { title: "Multiple choice: pick any; even one pick replaces all the ⭐ ones" }, "☑️ ") : null, inlineMarkdown(q.text)),
    q.detail ? markdown(q.detail, "md box-question-detail") : null,
    ...q.options.map((o) => option(o.letter, o.text, o.starred, o.why, o.score)),
    q.multi ? option(NONE, NONE_TEXT, false, "") : null);
}
