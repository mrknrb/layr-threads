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
  const toParent = (msg) => {
    if (window.parent !== window) window.parent.postMessage({ ...msg, instance }, "*");
  };

  const info = {
    plugin: "claude",
    panel,
    instance,
    params,
    state,
    device: { id: "dev", kind: "pc", name: "Dev PC" },
    platform: "windows",
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
      call: (tool, args, opts) => post("/dev/call", { tool, args: args ?? {}, plugin: opts?.plugin }),
      list: () => post("/dev/tools", {}),
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
