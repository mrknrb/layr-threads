// Try threads with a plugin list (0.7.0) in a browser, without the app: three sample plugins in a throwaway home
// (their histories beside their folders), the dev server (dev/devserver.js: the real backend and real Claude on a
// stand-in hub) on a free port, and the address to open. Ctrl+C stops it. Not used in production.
//   node plugins/claude/dev/plugin-threads-demo.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-plugin-threads-"));
const packages = path.join(tmp, "home", "packages");
process.env.LAYR_PACKAGES = packages;
const { initPluginRepo } = await import("../backend/autoCommit.js");

const repos = [];
for (const [id, name, text] of [["notes", "Notes", "Notes with tags"], ["notes-lite", "Notes Lite", "Plain notes"],
  ["tasks", "Tasks", "A to-do list"]]) {
  const dir = path.join(packages, id, "mine");
  mkdirSync(path.join(dir, "panels"), { recursive: true });
  writeFileSync(path.join(dir, "layr.json"), JSON.stringify({ id, name, version: "0.1.0", description: text, layr: "^0.1",
    permissions: ["data"], panels: [{ id: "main", title: name, page: "panels/main.html" }] }, null, 2));
  writeFileSync(path.join(dir, "panels", "main.html"), `<h1>${name}</h1>\n`);
  await initPluginRepo(dir, id, { outside: true });
  repos.push({ id, name, kind: "made", path: dir, linked: true, version: "0.1.0", description: text,
    sources: [{ source: "key-demo", text: "you", versions: ["0.1.0"] }] });
}
writeFileSync(path.join(tmp, "repos.json"), JSON.stringify(repos));
const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
console.log(`Sample plugins in ${packages}`);
console.log(`Open http://127.0.0.1:${port}/  (Plugins › New: "No plugin yet", then mention @notes or @tasks)`);
const child = spawn(process.execPath, [path.join(pluginDir, "dev", "devserver.js"), "--port", String(port), "--data",
  path.join(tmp, "data"), "--repos", path.join(tmp, "repos.json")], { cwd: pluginDir, stdio: "inherit",
  env: { ...process.env, LAYR_PACKAGES: packages } });
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
