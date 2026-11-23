// A stand-in for /_layr/layr.js when the panels run under dev/devserver.js (not loaded in production).
// Same API as the real SDK (docs/ARCHITECTURE.md > Panel SDK); tool calls go to the real backend through the dev
// server, events come from its fake hub over Server-Sent Events. Panel info comes from the URL:
//   ?panel=thread&params={"thread":"t_..."}&theme=dark
(function () {
  const url = new URL(location.href);
  const panel = url.searchParams.get("panel") || location.pathname.split("/").pop().replace(/\.html$/, "");
  let params = {};
  try {
    params = JSON.parse(url.searchParams.get("params") || "{}");
  } catch {}
  const instance = url.searchParams.get("instance") || `p_dev${Math.random().toString(36).slice(2, 10)}`;
  const stateKey = `mock-layr.state.${instance}`;
  let state = null;
  try {
    state = JSON.parse(sessionStorage.getItem(stateKey) || "null");
  } catch {}
  const theme = url.searchParams.get("theme") || "dark";
  document.documentElement.dataset.theme = theme;

  const listeners = new Map();
  const source = new EventSource("/dev/events");
  source.onmessage = (m) => {
    const { topic, data } = JSON.parse(m.data);
    for (const fn of listeners.get(topic) ?? []) {
      try {
        fn(data, topic);
      } catch (e) {
        console.error(e);
      }
    }
  };

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  /**
   * Other plugins' tools: none, unless localStorage "mock-layr.pipeline" is "1": then a fake pipeline whose task #42
   * is the thread t_demo1 (calls are logged in localStorage "mock-layr.pipelineCalls"). "mock-layr.pipelineToggles"
   * "1": it gives the task's toggles (pipeline 0.7); 🌙 off gives back "mock-layr.parked" as `unsent`.
   * "mock-layr.pipelineBox" "1" too (pipeline 0.16): with 🌙 on, Send and Approve wait as the text box's item
   * ("mock-layr.box": {start, text}); "mock-layr.boxSent" is what Away sent from the box.
   */
  async function fakePlugin(plugin, tool, args) {
    if (plugin === "concepts" && localStorage.getItem("mock-layr.concepts") === "1") return fakeConcepts(tool, args);
    if (plugin !== "pipeline" || localStorage.getItem("mock-layr.pipeline") !== "1") throw new Error(`No plugin ${plugin}`);
    const calls = JSON.parse(localStorage.getItem("mock-layr.pipelineCalls") || "[]");
    calls.push({ tool, args });
    localStorage.setItem("mock-layr.pipelineCalls", JSON.stringify(calls));
    const reply = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v && typeof v === "object" ? v : { result: v } });
    const toggles = localStorage.getItem("mock-layr.pipelineToggles") === "1";
    const away = localStorage.getItem("mock-layr.away") === "1";
    if (toggles && tool === "thread_action" && args.action === "toggle_away") {
      localStorage.setItem("mock-layr.away", args.on ? "1" : "0");
      if (!args.on && localStorage.getItem("mock-layr.parked")) {
        localStorage.setItem("mock-layr.unsent", localStorage.getItem("mock-layr.parked"));
        localStorage.removeItem("mock-layr.parked");
      }
      return reply({ ok: true });
    }
    if (toggles && tool === "thread_action" && args.action === "unsent_taken") {
      localStorage.removeItem("mock-layr.unsent");
      return reply({ ok: true });
    }
    const boxes = toggles && localStorage.getItem("mock-layr.pipelineBox") === "1";
    const box = JSON.parse(localStorage.getItem("mock-layr.box") || "null");
    if (boxes && away && ((tool === "send" && args.box) || (tool === "thread_action" && args.action === "approve" && args.box))) {
      localStorage.setItem("mock-layr.box", JSON.stringify({ start: tool !== "send", text: args.text ?? "" }));
      return reply({ number: 42, boxWaits: true });
    }
    if (boxes && tool === "thread_action" && args.action === "box_text") {
      if (box) localStorage.setItem("mock-layr.box", JSON.stringify({ ...box, text: args.text }));
      return reply({ number: 42, boxWaits: !!box });
    }
    if (boxes && tool === "thread_action" && args.action === "unbox") localStorage.removeItem("mock-layr.box");
    if (boxes && tool === "thread_action" && args.action === "box_sent_taken") localStorage.removeItem("mock-layr.boxSent");
    if (toggles && tool === "send" && away) localStorage.setItem("mock-layr.parked", args.text);
    if (tool === "thread_task") {
      if (args.thread !== "t_demo1") return reply(null);
      const extra = toggles
        ? { toggles: { plan: { on: false, can: false, why: "it has started" }, whenAway: { on: away, can: true } },
          ...(localStorage.getItem("mock-layr.unsent") ? { unsent: localStorage.getItem("mock-layr.unsent") } : {}) }
        : {};
      if (boxes) {
        if (box) extra.box = box;
        if (localStorage.getItem("mock-layr.boxSent") !== null) extra.boxSent = localStorage.getItem("mock-layr.boxSent");
        extra.buttons = [box ? { id: "unbox", label: box.start ? "Unapprove" : "Unsend" } : { id: "approve", label: "Approve · 🌙", kind: "primary" },
          { id: "settle", label: "Settle" }];
      }
      return reply({ ...extra, number: 42, title: "Add sorting to the notes list", column: "stopped", why: "Notes are hard to find in long lists",
        note: "Waits for your answers", link: "layr://pipeline/task/42",
        brief: { what: "A sort button: newest first, or A–Z.", asks: "Whether the order is remembered per notebook.", ifWrong: "The list order looks random." },
        stakes: "low", landing: { state: "waiting", problem: "the base moved on: rebase first" }, planning: false,
        buttons: [{ id: "land", label: "Land", kind: "primary", confirm: "Land #42 on main?" }, { id: "settle", label: "Settle" },
          { id: "delete", label: "Delete", kind: "danger", confirm: "Delete #42 and its worktree?" }], ...extra });
    }
    return reply({ ok: true });
  }

  /**
   * localStorage "mock-layr.concepts" = "1": a fake concepts plugin, answering as the real one (JSON text, no
   * structured content): prototypes p-sort-1 and p-sort-2, and two nodes touched by t_demo1.
   */
  function fakeConcepts(tool, args) {
    const text = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
    if (tool === "prototype_page") {
      const tall = args.node === "p-sort-2";
      if (args.node !== "p-sort-1" && !tall) return { content: [{ type: "text", text: `#${args.node} is not a prototype` }], isError: true };
      return text({ html: `<div class="layr-toolbar"><button class="layr-button primary" id="sort">Sort ${tall ? "▾" : "↓"}</button></div>` +
        `<div style="height:${tall ? 300 : 90}px;border:1px dashed var(--border)">notes</div>` +
        `<script>document.getElementById("sort").onclick = () => document.body.append("sorted");</script>` });
    }
    if (tool === "thread_nodes") {
      if (args.thread !== "t_demo1") return text([]);
      return text([{ id: "n-notes", text: "Notes list\nThe list of notes", did: "changed", note: "Added a Sort button" },
        { id: "n-order", text: "Sort order", did: "mentioned", note: null }]);
    }
    return { content: [{ type: "text", text: `No tool ${tool}` }], isError: true };
  }

  const toParent = (msg) => {
    if (window.parent !== window) window.parent.postMessage({ ...msg, instance }, "*");
  };

  const info = {
    plugin: "threads",
    panel,
    instance,
    params,
    state,
    // localStorage "mock-layr.phone" = "1": shown on a phone.
    device: localStorage.getItem("mock-layr.phone") === "1" ? { id: "phone", kind: "phone", name: "Phone" } : { id: "dev", kind: "pc", name: "Dev PC" },
    platform: localStorage.getItem("mock-layr.phone") === "1" ? "android" : "windows",
    theme: { mode: theme, accent: null },
    coreVersion: "dev",
  };

  window.layr = {
    __sdk: true,
    info,
    connected: true,
    ready: new Promise((resolve) => (source.readyState === 1 ? resolve() : source.addEventListener("open", () => resolve(), { once: true }))).then(() => info),
    call: (method, p) => post("/dev/rpc", { method, params: p }),
    data: {
      get: async (key) => JSON.parse(localStorage.getItem(`mock-data.${key}`) || "null"),
      set: async (key, v) => localStorage.setItem(`mock-data.${key}`, JSON.stringify(v)),
      delete: async (key) => localStorage.removeItem(`mock-data.${key}`),
      list: async () => [],
    },
    tools: {
      call: (tool, args, opts) =>
        opts?.plugin && opts.plugin !== "threads" ? fakePlugin(opts.plugin, tool, args ?? {}) : post("/dev/call", { tool, args: args ?? {}, plugin: opts?.plugin }),
      list: () => post("/dev/tools", {}),
    },
    // Optional connections: the pipeline is usable while localStorage "mock-layr.pipeline" is "1" (emit
    // layr:connections after changing it, as the core does after an install or an access change).
    connections: {
      get: async () => ({ blocked: false, reasons: [], connections: [{ plugin: "pipeline", required: false,
        usable: localStorage.getItem("mock-layr.pipeline") === "1" }] }),
      usable: async (plugin) => plugin === "pipeline" && localStorage.getItem("mock-layr.pipeline") === "1",
      onChange: (fn) => window.layr.events.on("layr:connections", fn),
    },
    events: {
      on(topic, fn) {
        const set = listeners.get(topic) ?? new Set();
        listeners.set(topic, set);
        set.add(fn);
        return () => set.delete(fn);
      },
      emit: (topic, data) => post("/dev/emit", { topic, data }),
    },
    panels: {
      open: async (p, prm, opts) => {
        toParent({ type: "open", panel: p, params: prm ?? {}, where: opts?.where ?? "tab" });
        if (window.parent === window) window.open(`/panels/${p}.html?panel=${p}&theme=${theme}&params=${encodeURIComponent(JSON.stringify(prm ?? {}))}`);
        return { instance: "p_devopened" };
      },
    },
    links: {
      // Logged in localStorage "mock-layr.links"; a thread link opens its panel as the core would.
      open: async (link) => {
        const links = JSON.parse(localStorage.getItem("mock-layr.links") || "[]");
        links.push(String(link));
        localStorage.setItem("mock-layr.links", JSON.stringify(links));
        const m = /^layr:\/\/(?:threads|claude)\/thread\/(.+)$/i.exec(String(link));
        if (m) return window.layr.panels.open("thread", { thread: decodeURIComponent(m[1]), link });
        return null;
      },
    },
    panel: {
      setTitle: async (title) => {
        document.title = title;
        toParent({ type: "title", title });
      },
      setState: async (s) => {
        info.state = s;
        sessionStorage.setItem(stateKey, JSON.stringify(s));
      },
      close: async () => toParent({ type: "close" }),
      onParams: () => () => {},
    },
    commands: { run: async () => null, list: async () => [] },
    ui: {
      notify: async (text, kind) => {
        console.log(`[notify ${kind ?? "info"}] ${text}`);
        toParent({ type: "notify", text, kind });
      },
    },
  };
})();
