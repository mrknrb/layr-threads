// Unit tests without Claude or a core (0.13.0): layr's skills put together as one local Claude Code plugin
// (backend/skills.js). Run: node test/skills.test.js
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Skills, folderNames, forThread, setHash } from "../backend/skills.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-claude-skills-"));

function skillFolder(name, text = `---\nname: ${name}\ndescription: test\n---\nDo it.\n`) {
  const dir = path.join(tmp, "src", name, Math.random().toString(36).slice(2));
  mkdirSync(path.join(dir, "ref"), { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), text);
  writeFileSync(path.join(dir, "ref", "more.md"), "more");
  return dir;
}

/** A hub that answers layr__skills_list with `skills` (or fails like a core from before skills). */
function fakeHub(skills, { fail } = {}) {
  return {
    available: true,
    calls: 0,
    async call(name) {
      this.calls += 1;
      assert.equal(name, "layr__skills_list");
      if (fail) throw new Error("Unknown tool layr__skills_list");
      return { skills };
    },
  };
}

test("names clash only across plugins", () => {
  const names = folderNames([{ id: "scraper/web" }, { id: "wiki/web" }, { id: "wiki/notes" }]);
  assert.deepEqual(names, ["scraper-web", "wiki-web", "notes"]);
});

test("a thread's skillsOff leaves skills out", () => {
  const all = [{ id: "a/x", folder: "/x" }, { id: "a/y", folder: "/y" }, { id: "bad", folder: "/z" }];
  assert.deepEqual(forThread(all, { skillsOff: ["a/y"] }).map((s) => s.id), ["a/x"]);
  assert.deepEqual(forThread(all, {}).map((s) => s.id), ["a/x", "a/y"]);
});

test("the plugin folder is built once per set and has every skill's files", async () => {
  const web = skillFolder("web");
  const notes = skillFolder("notes");
  const listed = [
    { id: "scraper/web", name: "web", folder: web },
    { id: "wiki/notes", name: "notes", folder: notes },
  ];
  const skills = new Skills({ hub: fakeHub(listed), dataDir: path.join(tmp, "data") });
  const entry = await skills.pluginFor({ id: "t1" });
  assert.equal(entry.type, "local");
  assert.equal(entry.skipMcpDiscovery, true);
  const manifest = JSON.parse(readFileSync(path.join(entry.path, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "layr");
  assert.ok(readFileSync(path.join(entry.path, "skills", "web", "SKILL.md"), "utf8").includes("Do it."));
  assert.ok(existsSync(path.join(entry.path, "skills", "notes", "ref", "more.md")));

  // The same set: the same folder. One off for a thread: another folder without it.
  assert.equal((await skills.pluginFor({ id: "t2" })).path, entry.path);
  const fewer = await skills.pluginFor({ id: "t3", skillsOff: ["wiki/notes"] });
  assert.notEqual(fewer.path, entry.path);
  assert.deepEqual(readdirSync(path.join(fewer.path, "skills")), ["web"]);

  // A changed SKILL.md gives a new hash (a folder in use is never rebuilt in place).
  const before = setHash(listed);
  writeFileSync(path.join(web, "SKILL.md"), "---\nname: web\ndescription: changed and longer\n---\nNew.\n");
  assert.notEqual(setHash(listed), before);

  // Everything off for the thread: no plugin at all.
  assert.equal(await skills.pluginFor({ id: "t4", skillsOff: ["scraper/web", "wiki/notes"] }), null);
});

test("a core without skills: no plugin, and it isn't asked again at once", async () => {
  const hub = fakeHub([], { fail: true });
  const skills = new Skills({ hub, dataDir: path.join(tmp, "data-old") });
  assert.equal(await skills.pluginFor({ id: "t" }), null);
  assert.equal(await skills.pluginFor({ id: "t" }), null);
  assert.equal(hub.calls, 1);
});

test("no hub: no skills", async () => {
  const skills = new Skills({ hub: { available: false }, dataDir: path.join(tmp, "data-none") });
  assert.deepEqual(await skills.list(), []);
});
