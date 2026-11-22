// layr's skills as real Claude Code skills (docs/ARCHITECTURE.md > Skills, The claude plugin > Skills, 0.13.0).
// The core keeps one list of every installed plugin's skills and which are on (`layr__skills_list`). Each query
// gets them as one local Claude Code plugin named "layr" (the SDK's `plugins` option), built in
// `<LAYR_DATA_DIR>/skills/<hash>/` from the skills' folders: `.claude-plugin/plugin.json` and `skills/<name>/`.
// A thread's own `skillsOff` leaves some out. The same set of skills reuses the same folder; folders no thread used
// for a week are removed. Claude Code reads a skill's files when it uses it, so a folder in use is never rebuilt in
// place: a changed skill gives a new hash.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorMessage, log } from "./util.js";

const KEEP_MS = 7 * 24 * 3600_000;
/** A core without skills: asked again after this long. */
const RETRY_MS = 60_000;

/** The folder name a skill gets in the "layr" plugin: its own name, or `<plugin>-<name>` when two plugins clash. */
export function folderNames(skills) {
  const count = new Map();
  for (const s of skills) {
    const name = s.id.split("/")[1];
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return skills.map((s) => {
    const [plugin, name] = s.id.split("/");
    return count.get(name) > 1 ? `${plugin}-${name}` : name;
  });
}

/** The skills a thread gets: those on in layr, minus the thread's own `skillsOff`. */
export function forThread(skills, meta) {
  const off = new Set(Array.isArray(meta?.skillsOff) ? meta.skillsOff : []);
  return skills.filter((s) => s && typeof s.id === "string" && s.id.includes("/") && s.folder && !off.has(s.id));
}

function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

/** A hash of the set: ids, folders and their SKILL.md's size and time. */
export function setHash(skills) {
  const parts = skills.map((s) => [s.id, s.folder, stamp(path.join(s.folder, "SKILL.md"))]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return crypto.createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export class Skills {
  constructor({ hub, dataDir }) {
    this.hub = hub;
    this.root = path.join(dataDir, "skills");
    this.unsupportedUntil = 0;
    this.lastList = [];
  }

  /** Every skill that is on in layr (`[]` without a hub, or with a core from before skills). */
  async list() {
    if (!this.hub?.available || Date.now() < this.unsupportedUntil) return [];
    try {
      const got = await this.hub.call("layr__skills_list", {});
      this.lastList = Array.isArray(got?.skills) ? got.skills : [];
      return this.lastList;
    } catch (error) {
      const message = errorMessage(error);
      if (/unknown tool|not found|skills_list/i.test(message)) this.unsupportedUntil = Date.now() + RETRY_MS;
      log("skills aren't available:", message);
      return [];
    }
  }

  /** The SDK `plugins` entry for a thread's query, or null when it gets no skills. */
  async pluginFor(meta) {
    const skills = forThread(await this.list(), meta);
    if (!skills.length) return null;
    try {
      const dir = this.build(skills);
      this.cleanup(dir);
      return { type: "local", path: dir, skipMcpDiscovery: true };
    } catch (error) {
      log("couldn't put the skills together:", errorMessage(error));
      return null;
    }
  }

  build(skills) {
    const dir = path.join(this.root, setHash(skills));
    if (fs.existsSync(path.join(dir, ".ready"))) {
      const now = new Date();
      fs.utimesSync(dir, now, now);
      return dir;
    }
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "layr", version: "1.0.0", description: "Skills from your layr plugins (Settings > Skills)" }, null, 2),
    );
    const names = folderNames(skills);
    skills.forEach((s, i) => {
      fs.cpSync(s.folder, path.join(tmp, "skills", names[i]), { recursive: true, dereference: true });
    });
    fs.writeFileSync(path.join(tmp, ".ready"), new Date().toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return dir;
  }

  /** Removes folders no thread used for a week (and half-built ones), never `keep`. */
  cleanup(keep) {
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const e of entries) {
      const full = path.join(this.root, e.name);
      if (!e.isDirectory() || full === keep) continue;
      try {
        const age = now - fs.statSync(full).mtimeMs;
        if (age > KEEP_MS || (e.name.includes(".tmp-") && age > 3600_000)) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // in use or gone: next time
      }
    }
  }
}
