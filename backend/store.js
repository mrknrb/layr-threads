// Where the plugin keeps its state, all under LAYR_DATA_DIR:
//   projects.json              the folders the user works in
//   threads/index.json         every thread's metadata (the list the panels show)
//   threads/<id>.jsonl         a thread's transcript, one entry per line, numbered by `seq`
//   threads/<id>.went-back.jsonl  what going back took out of it, kept
//   threads/<id>/              its pasted images
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureDir, log, newId, nowIso, readJson, writeFileAtomic, errorMessage } from "./util.js";

export class Store {
  constructor(dataDir) {
    this.dataDir = ensureDir(dataDir);
    this.threadsDir = ensureDir(path.join(dataDir, "threads"));
    this.projectsFile = path.join(dataDir, "projects.json");
    this.indexFile = path.join(this.threadsDir, "index.json");
    this.projects = readJson(this.projectsFile, []);
    /** @type {Record<string, any>} */
    this.threads = readJson(this.indexFile, {});
    /** Last seq per thread, so appends don't read the file. */
    this.seqs = new Map();
    this.indexTimer = null;
  }

  // Projects

  saveProjects() {
    writeFileAtomic(this.projectsFile, JSON.stringify(this.projects, null, 2));
  }

  findProject(ref) {
    if (!ref) return null;
    const norm = normalizePath(ref);
    return (
      this.projects.find((p) => p.id === ref) ||
      this.projects.find((p) => normalizePath(p.path) === norm) ||
      this.projects.find((p) => p.name.toLowerCase() === String(ref).toLowerCase()) ||
      null
    );
  }

  /** `kind: "plugin"` (with `pluginId`): a plugin's own folder, shown under Plugins, not Projects. */
  addProject({ path: dir, name, defaultModel, defaultEffort, defaultPermissionMode, kind, pluginId }) {
    const existing = this.findProject(dir);
    if (existing) {
      if (kind && existing.kind !== kind) {
        Object.assign(existing, { kind, pluginId: pluginId || null });
        this.saveProjects();
      }
      return existing;
    }
    const project = {
      id: newId("p"),
      name: name || path.basename(path.resolve(dir)) || dir,
      path: path.resolve(dir),
      defaultModel: defaultModel || null,
      defaultEffort: defaultEffort || null,
      defaultPermissionMode: defaultPermissionMode || null,
      ...(kind ? { kind, pluginId: pluginId || null } : {}),
      createdAt: nowIso(),
    };
    this.projects.push(project);
    this.saveProjects();
    return project;
  }

  updateProject(id, patch) {
    const project = this.findProject(id);
    if (!project) throw new Error(`No project ${id}`);
    for (const key of ["name", "defaultModel", "defaultEffort", "defaultPermissionMode"]) {
      if (patch[key] !== undefined) project[key] = patch[key] || null;
    }
    if (!project.name) project.name = path.basename(project.path);
    this.saveProjects();
    return project;
  }

  removeProject(id) {
    const project = this.findProject(id);
    if (!project) throw new Error(`No project ${id}`);
    this.projects = this.projects.filter((p) => p.id !== project.id);
    this.saveProjects();
    return project;
  }

  // Threads

  thread(id) {
    return this.threads[id] ?? null;
  }

  createThread(meta) {
    this.threads[meta.id] = meta;
    this.saveIndexSoon();
    return meta;
  }

  updateThread(id, patch) {
    const meta = this.threads[id];
    if (!meta) return null;
    Object.assign(meta, patch, { updatedAt: nowIso() });
    this.saveIndexSoon();
    return meta;
  }

  saveIndexSoon() {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.saveIndexNow();
    }, 150);
  }

  saveIndexNow() {
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    try {
      writeFileAtomic(this.indexFile, JSON.stringify(this.threads));
    } catch (error) {
      log("could not save the thread index:", errorMessage(error));
    }
  }

  transcriptFile(id) {
    return path.join(this.threadsDir, `${id}.jsonl`);
  }

  attachmentsDir(id) {
    return ensureDir(path.join(this.threadsDir, id));
  }

  lastSeq(id) {
    if (this.seqs.has(id)) return this.seqs.get(id);
    const entries = this.readTranscript(id);
    const last = entries.length ? entries[entries.length - 1].seq : 0;
    this.seqs.set(id, last);
    return last;
  }

  /** Append an entry to a thread's transcript; gives it `seq` and `ts`. */
  append(id, entry) {
    const seq = this.lastSeq(id) + 1;
    this.seqs.set(id, seq);
    const full = { seq, ts: nowIso(), ...entry };
    appendFileSync(this.transcriptFile(id), `${JSON.stringify(full)}\n`);
    return full;
  }

  readTranscript(id) {
    const file = this.transcriptFile(id);
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a line cut by a crash: skip it
      }
    }
    return out;
  }

  /** Entries with seq < before (or the newest), at most `limit`, oldest first. */
  readPage(id, { limit = 500, before, after } = {}) {
    let entries = this.readTranscript(id);
    if (after != null) entries = entries.filter((e) => e.seq > after);
    if (before != null) entries = entries.filter((e) => e.seq < before);
    const more = entries.length > limit;
    return { entries: more ? entries.slice(entries.length - limit) : entries, more };
  }

  /**
   * Going back: the entries from `seq` on leave the transcript, kept in threads/<id>.went-back.jsonl. Later entries
   * go on numbering after the last one there was, so a seq never comes back. Gives the entries taken out.
   */
  cutTranscript(id, seq) {
    const entries = this.readTranscript(id);
    const cut = entries.filter((e) => e.seq >= seq);
    if (!cut.length) return [];
    const at = nowIso();
    appendFileSync(this.wentBackFile(id), cut.map((e) => `${JSON.stringify({ ...e, wentBackAt: at })}
`).join(""));
    const kept = entries.filter((e) => e.seq < seq);
    writeFileAtomic(this.transcriptFile(id), kept.map((e) => `${JSON.stringify(e)}
`).join(""));
    this.seqs.set(id, Math.max(this.lastSeq(id), entries.at(-1).seq));
    return cut;
  }

  wentBackFile(id) {
    return path.join(this.threadsDir, `${id}.went-back.jsonl`);
  }

  saveAttachment(id, name, buffer) {
    const file = path.join(this.attachmentsDir(id), name);
    writeFileSync(file, buffer);
    return file;
  }

  readAttachment(id, name) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("Bad attachment name");
    return readFileSync(path.join(this.threadsDir, id, name));
  }

  deleteThreadFiles(id) {
    rmSync(this.transcriptFile(id), { force: true });
    rmSync(this.wentBackFile(id), { force: true });
    rmSync(path.join(this.threadsDir, id), { recursive: true, force: true });
  }
}

export function normalizePath(p) {
  const resolved = path.resolve(String(p)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
