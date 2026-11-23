// Small helpers shared by the backend modules.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

/** Log to stderr: the core keeps it in logs/threads.log (stdout is MCP). */
export function log(...args) {
  const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : safeJson(a)));
  process.stderr.write(`[threads ${new Date().toISOString()}] ${text.join(" ")}\n`);
}

export function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : safeJson(error);
}

/** A short random id with a prefix, e.g. `t_k3j9x2m1q8`. */
export function newId(prefix) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(10);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return `${prefix}_${id}`;
}

export { randomUUID };

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a file so readers never see half of it: a temporary file first, then a rename. */
export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log(`could not read ${file}:`, errorMessage(error));
    return fallback;
  }
}

export function isDirectory(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Lowercase words joined by dashes, at most `max` characters: "Fix the login!" → "fix-the-login". */
export function slugify(text, max = 40) {
  const slug = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/g, "");
}

/** A short title from a prompt: its first line, at most 60 characters. */
export function titleFromPrompt(prompt) {
  const line = String(prompt ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "New thread";
  const clean = line.replace(/[#*`>_]+/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}...` : clean || "New thread";
}

/** Cut a long string, saying how much was left out. */
export function truncate(text, max) {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (${text.length - max} more characters)`;
}

/** A push-based async iterable: the streaming input of a Claude query. */
export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
    return true;
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Resolve after `ms`, or earlier when `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
