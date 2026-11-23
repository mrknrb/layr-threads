// The Build times panel: how long the builds, tests and checks threads run take, per project (the backend's
// build_times tool, backend/buildTimes.js). Refreshes when shown and every minute.
import { call, h, icon, notify, ready, relTime } from "./common.js";

const $ = (id) => document.getElementById(id);
let layr;
let projects = [];

/** 2h 13m, 4m 10s, 12s. */
export function span(ms) {
  if (typeof ms !== "number") return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function load() {
  const days = Number($("days").value) || undefined;
  const project = $("project").value || undefined;
  let data;
  try {
    data = await call("build_times", { ...(days ? { days } : {}) });
  } catch (error) {
    $("list").replaceChildren(h("div", { class: "empty" }, `Could not load build times: ${error.message}`));
    return;
  }
  projects = data.projects;
  fillProjects(project);
  const shown = project ? projects.filter((p) => (p.id || `name:${p.name}`) === project) : projects;
  $("list").replaceChildren(
    ...(shown.length
      ? shown.map((p) => projectCard(p, days))
      : [h("div", { class: "empty" }, "No builds, tests or checks yet in this period. They show here as threads run them.")]),
  );
  const imp = data.imported;
  $("imported").textContent = imp
    ? `Past runs read from ${imp.files} transcripts, ${relTime(imp.at)} ago`
    : "Past threads are being read…";
}

function fillProjects(value) {
  const select = $("project");
  const options = [["", "All projects"], ...projects.map((p) => [p.id || `name:${p.name}`, p.name])];
  if (value && !options.some(([v]) => v === value)) options.push([value, "(no runs in this period)"]);
  select.replaceChildren(...options.map(([v, label]) => h("option", { value: v }, label)));
  select.value = value ?? "";
}

function projectCard(p, days) {
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "name" }, p.name),
      h("span", { class: "total" }, span(p.totalMs)),
      h("span", { class: "dim" }, `${p.runs} runs`),
      p.timedOut ? h("span", { class: "warn" }, `${p.timedOut} timed out`) : null,
    ),
    dayChart(p.days, days),
    kindsBlock(p),
    p.threads.length ? h("h3", {}, "Waited longest") : null,
    p.threads.length ? threadList(p.threads) : null,
    h("details", { class: "recent" }, h("summary", {}, "Latest runs"), recentList(p.recent)),
  );
}

function dayChart(list, days) {
  if (!list.length) return null;
  const byDay = new Map(list.map((d) => [d.day, d.ms]));
  const count = Math.min(days || 30, 90);
  const bars = [];
  const today = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    bars.push([key, byDay.get(key) ?? 0]);
  }
  const max = Math.max(...bars.map(([, ms]) => ms), 1);
  return h(
    "div",
    { class: "chart", title: "Build and check time per day" },
    bars.map(([day, ms]) =>
      h("div", { class: "bar", title: `${day}: ${span(ms)}` }, h("div", { style: { height: `${(ms / max) * 100}%` } })),
    ),
  );
}

const KINDS_SHOWN = 12;
/** Projects whose every kind is shown (the rest show the KINDS_SHOWN with the most time). */
const allKinds = new Set();

function kindsBlock(p) {
  const key = p.id || `name:${p.name}`;
  const more = p.kinds.length - KINDS_SHOWN;
  const open = allKinds.has(key);
  const shown = open || more <= 0 ? p.kinds : p.kinds.slice(0, KINDS_SHOWN);
  const toggle = () => {
    if (open) allKinds.delete(key);
    else allKinds.add(key);
    void load();
  };
  return h(
    "div",
    {},
    h("div", { class: "table-wrap" }, kindsTable({ ...p, kinds: shown })),
    more > 0 ? h("button", { class: "btn ghost small more", onclick: toggle }, open ? "Show fewer" : `Show all ${p.kinds.length} kinds`) : null,
  );
}

function kindsTable(p) {
  const head = ["Kind", "Runs", "Total", "Median", "Longest", "Cold", "Warm", "Failed", "Timed out"];
  const tips = {
    Cold: "Median of each folder's first run of this kind (a new worktree builds from scratch)",
    Warm: "Median of the later runs",
    "Timed out": "Ran past the command's timeout and went on in the background",
  };
  return h(
    "table",
    { class: "kinds" },
    h("thead", {}, h("tr", {}, head.map((c) => h("th", { title: tips[c] ?? null }, c)))),
    h(
      "tbody",
      {},
      p.kinds.map((k) =>
        h(
          "tr",
          {},
          h(
            "td",
            { class: "kind" },
            h("div", { class: "share", style: { width: `${(k.totalMs / Math.max(p.totalMs, 1)) * 100}%` } }),
            h("span", {}, k.kind),
          ),
          h("td", {}, k.runs),
          h("td", {}, span(k.totalMs)),
          h("td", {}, span(k.medianMs)),
          h("td", {}, span(k.maxMs)),
          h("td", { title: `${k.firstRuns} first runs` }, k.firstRuns ? span(k.firstMedianMs) : "–"),
          h("td", {}, span(k.laterMedianMs)),
          h("td", { class: k.failed ? "bad" : "dim" }, k.failed || "–"),
          h("td", { class: k.timedOut ? "warn" : "dim" }, k.timedOut || "–"),
        ),
      ),
    ),
  );
}

function threadList(threads) {
  return h(
    "ul",
    { class: "threads" },
    threads.map((t) =>
      h(
        "li",
        {
          class: t.thread ? "link" : null,
          title: t.thread ? "Open the thread" : null,
          onclick: t.thread ? () => layr.panels.open("thread", { thread: t.thread }).catch((e) => notify(e.message, "error")) : null,
        },
        h("span", { class: "title" }, t.title || "(no title)"),
        h("span", { class: "dim" }, `${t.runs} runs`),
        h("span", {}, span(t.ms)),
      ),
    ),
  );
}

function recentList(runs) {
  return h(
    "ul",
    { class: "runs" },
    runs.map((r) =>
      h(
        "li",
        { title: r.command },
        h("span", { class: `dot ${r.status}` }),
        h("span", { class: "kind" }, r.kind),
        r.first ? h("span", { class: "tag", title: "Its folder's first run of this kind" }, "cold") : null,
        r.timedOut ? h("span", { class: "tag warn" }, "timed out") : null,
        r.background ? h("span", { class: "tag" }, "background") : null,
        h("span", { class: "dim when" }, relTime(r.at)),
        h("span", {}, span(r.ms)),
      ),
    ),
  );
}

async function importAgain() {
  const btn = $("import");
  btn.disabled = true;
  btn.textContent = "Reading…";
  try {
    const r = await call("build_times_import", {});
    notify(r.added ? `${r.added} past runs added` : "No new past runs", "info");
    await load();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Read past threads again";
  }
}

async function main() {
  layr = await ready();
  $("refresh").append(icon("refresh", 14));
  $("refresh").onclick = () => void load();
  $("days").onchange = () => void load();
  $("project").onchange = () => void load();
  $("import").onclick = () => void importAgain();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void load());
  setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
  await load();
}

main().catch((error) => {
  $("list").replaceChildren(h("div", { class: "empty" }, error.message));
});
