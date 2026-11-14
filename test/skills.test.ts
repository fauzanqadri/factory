import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createRegistry, loadSkills, renderSkills, SkillError, writeLock } from "../src";
import { parseFrontmatter } from "../src/skills";

const fixtures = path.join(__dirname, "fixtures");
const made: string[] = [];
afterAll(async () => { await Promise.all(made.map((d) => rm(d, { recursive: true, force: true }))); });

/** A throwaway app directory holding the given files (paths relative to it). */
async function app(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "factory-skills-")));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

const skillMd = (name: string, body = "") => `---\nname: ${name}\ndescription: test\n---\n${body}\n`;

async function load(root: string, name = "s", dir = "skills/s", opts: Parameters<typeof loadSkills>[1] extends infer O ? Partial<O> : never = {}, include?: string[]) {
  const r = createRegistry();
  r.skill(name, { path: dir }, { include });
  return loadSkills(r, { root, ...opts });
}

const paths = (s: { files: Array<{ path: string }> }) => s.files.map((f) => f.path);

describe("loading real-world shaped skills", () => {
  test("a bare name (eval.md) is found at the skill root; agents/openai.yaml and URLs, paths and code names are not loaded", async () => {
    const r = createRegistry();
    r.skill("no-ai-slop", { path: "skills/no-ai-slop" });
    const { skills, warnings } = await loadSkills(r, { root: fixtures });
    const s = skills.get("no-ai-slop")!;
    expect(paths(s)).toEqual(["SKILL.md", "eval.md"]);
    expect(s.description).toBe("Edit drafts into sharper, more human writing while keeping the writer's voice.");
    expect(warnings).toEqual([]);
  });

  test("links resolve against the containing file; child-of-child loads; cycles end; evals/ is never read", async () => {
    const r = createRegistry();
    r.skill("golang-testing", { path: "skills/golang-testing" });
    const { skills, warnings } = await loadSkills(r, { root: fixtures });
    const s = skills.get("golang-testing")!;
    expect(paths(s)).toEqual(["SKILL.md", "references/helpers.md", "references/http-testing.md", "references/mocking.md"]);
    expect(s.files.some((f) => f.content.includes("NEVER-LOAD-ME"))).toBe(false);
    expect(s.description).toBe("Production-ready Go test guidance covering table-driven tests and mocking.");
    // other skills are mentioned but not registered here; the skill's own name is fine
    expect(warnings).toEqual([expect.stringContaining('mentions skill "golang-stretchr-testify"')]);
  });

  test("renderSkills puts each file under a path heading so references still make sense", async () => {
    const r = createRegistry();
    r.skill("no-ai-slop", { path: "skills/no-ai-slop" });
    const { skills } = await loadSkills(r, { root: fixtures });
    const text = renderSkills([skills.get("no-ai-slop")!]);
    expect(text).toContain("## Skill: no-ai-slop");
    expect(text.indexOf("### no-ai-slop/SKILL.md")).toBeLessThan(text.indexOf("### no-ai-slop/eval.md"));
    expect(text).toContain("No summary endings.");
    expect(renderSkills([])).toBe("");
  });

  test("the hash is stable and changes with content", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "one") });
    const a = (await load(root)).skills.get("s")!.hash;
    expect((await load(root)).skills.get("s")!.hash).toBe(a);
    await writeFile(path.join(root, "skills/s/SKILL.md"), skillMd("s", "two"));
    expect((await load(root)).skills.get("s")!.hash).not.toBe(a);
  });
});

describe("what is rejected", () => {
  const outside = "TOP-SECRET";

  test("../ traversal, its %-encoded form, and an absolute path fail boot", async () => {
    for (const link of ["../secret.md", "%2e%2e/secret.md", "..%2fsecret.md", "/etc/passwd.md"]) {
      const root = await app({ "skills/s/SKILL.md": skillMd("s", `[x](${link})`), "skills/secret.md": outside });
      await expect(load(root), link).rejects.toThrow(SkillError);
    }
  });

  test("a bare name that climbs out fails boot too", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "see ../secret.md"), "skills/secret.md": outside });
    await expect(load(root)).rejects.toThrow(/leaves the skill folder/);
  });

  test("a sibling folder that shares the root's prefix is outside (tdd-evil vs tdd)", async () => {
    const root = await app({ "skills/tdd/SKILL.md": skillMd("tdd", "[x](../tdd-evil/x.md)"), "skills/tdd-evil/x.md": outside });
    await expect(load(root, "tdd", "skills/tdd")).rejects.toThrow(/leaves the skill folder/);
  });

  test("a symlinked file, and a file under a symlinked folder, fail boot", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "[a](./a.md) [b](./dir/b.md)"), "elsewhere/b.md": outside, "elsewhere/a.md": outside });
    await symlink(path.join(root, "elsewhere/a.md"), path.join(root, "skills/s/a.md"));
    await expect(load(root)).rejects.toThrow(/symlink/);
    await rm(path.join(root, "skills/s/a.md"));
    await writeFile(path.join(root, "skills/s/a.md"), "ok");
    await symlink(path.join(root, "elsewhere"), path.join(root, "skills/s/dir"));
    await expect(load(root)).rejects.toThrow(/symlink/);
  });

  test.skipIf(process.platform === "win32")("a FIFO is not a regular file", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "[p](./pipe.md)") });
    execFileSync("mkfifo", [path.join(root, "skills/s/pipe.md")]);
    await expect(load(root)).rejects.toThrow(/not a regular file/);
  });

  test("a SKILL.md that is missing, or whose frontmatter name differs, fails boot", async () => {
    await expect(load(await app({ "skills/s/other.md": "x" }))).rejects.toThrow(/SKILL\.md does not exist/);
    await expect(load(await app({ "skills/s/SKILL.md": skillMd("different") }))).rejects.toThrow(/expected "s"/);
    await expect(load(await app({ "skills/s/SKILL.md": "no frontmatter" }))).rejects.toThrow(/missing/);
    await expect(load(await app({}))).rejects.toThrow(/does not exist/);
  });

  test("a file over the size limit fails boot, as do too many files, too deep a chain and a blown stage budget", async () => {
    const big = await app({ "skills/s/SKILL.md": skillMd("s", "[b](./b.md)"), "skills/s/b.md": "x".repeat(200) });
    await expect(load(big, "s", "skills/s", { limits: { maxFileBytes: 100 } })).rejects.toThrow(/file limit/);
    await expect(load(big, "s", "skills/s", { limits: { maxSkillBytes: 100 } })).rejects.toThrow(/exceed/);
    await expect(load(big, "s", "skills/s", { limits: { maxFiles: 1 } })).rejects.toThrow(/more than 1 files/);
    const deep = await app({
      "skills/s/SKILL.md": skillMd("s", "[a](./a.md)"), "skills/s/a.md": "[b](./b.md)", "skills/s/b.md": "[c](./c.md)", "skills/s/c.md": "end",
    });
    await expect(load(deep, "s", "skills/s", { limits: { maxDepth: 2 } })).rejects.toThrow(/deeper than/);

    const r = createRegistry();
    r.skill("s", { path: "skills/s" });
    r.stage({ name: "build", runsIn: "host", skills: ["s"], next: () => ({ finish: "done" }) });
    await expect(loadSkills(r, { root: big, limits: { maxStageBytes: 100 } })).rejects.toThrow(/stage "build"/);
  });
});

describe("what is ignored", () => {
  test("URLs, anchors, non-text targets, hidden files and directories are not loaded", async () => {
    const root = await app({
      "skills/s/SKILL.md": skillMd("s", "[u](https://x.test/a.md) [f](file:///etc/x.md) [h](#top) [y](./c.yaml) [i](./img.png) [d](./.hidden.md) [dir](./folder.md) [m](mailto:a@b.md)"),
      "skills/s/c.yaml": "k: v", "skills/s/.hidden.md": "HIDDEN", "skills/s/folder.md/inner.md": "x",
    });
    const { skills, warnings } = await load(root);
    expect(paths(skills.get("s")!)).toEqual(["SKILL.md"]);
    expect(warnings.join("\n")).toMatch(/\.hidden\.md.*hidden/);
    expect(warnings.join("\n")).toMatch(/folder\.md.*directory/);
  });

  test("a missing child is a warning, not a failure, and is reported once", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "[a](./nope.md) and again [b](./nope.md)") });
    const { skills, warnings } = await load(root);
    expect(paths(skills.get("s")!)).toEqual(["SKILL.md"]);
    expect(warnings).toHaveLength(1);
  });

  test("when a bare name exists at the root and next to the file, the root wins and it warns", async () => {
    const root = await app({
      "skills/s/SKILL.md": skillMd("s", "[r](./refs/r.md)"), "skills/s/refs/r.md": "use notes.md",
      "skills/s/notes.md": "ROOT", "skills/s/refs/notes.md": "NEAR",
    });
    const { skills, warnings } = await load(root);
    expect(skills.get("s")!.files.find((f) => f.path === "notes.md")!.content).toBe("ROOT");
    expect(paths(skills.get("s")!)).not.toContain("refs/notes.md");
    expect(warnings.join("\n")).toMatch(/more than one folder/);
  });
});

describe("include", () => {
  test("loads a file nothing mentions, through the same checks; a missing one fails boot", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s"), "skills/s/extra.md": "EXTRA" });
    expect(paths((await load(root, "s", "skills/s", {}, ["extra.md"])).skills.get("s")!)).toEqual(["SKILL.md", "extra.md"]);
    await expect(load(root, "s", "skills/s", {}, ["gone.md"])).rejects.toThrow(/does not exist/);
    await expect(load(root, "s", "skills/s", {}, ["../x.md"])).rejects.toThrow(/leaves the skill folder/);
  });
});

describe("lockfile", () => {
  test("a written lock verifies; a changed skill fails (enforce) or warns (warn); no lock means off", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s", "v1") });
    const r = createRegistry();
    r.skill("s", { path: "skills/s" });
    const lockPath = path.join(root, "skills.lock.json");

    expect((await loadSkills(r, { root })).warnings).toEqual([]); // no lockfile yet: off
    await writeLock(r, await loadSkills(r, { root }), lockPath);
    expect(JSON.parse(await readFile(lockPath, "utf8")).skills.s.source).toEqual({ path: "skills/s" });
    expect((await loadSkills(r, { root })).warnings).toEqual([]);

    await writeFile(path.join(root, "skills/s/SKILL.md"), skillMd("s", "v2"));
    await expect(loadSkills(r, { root })).rejects.toThrow(/changed since it was locked/);
    const warned = await loadSkills(r, { root, lock: "warn" });
    expect(warned.warnings.join("\n")).toMatch(/changed since it was locked/);
    expect((await loadSkills(r, { root, lock: "off" })).warnings).toEqual([]);
  });

  test("a skill missing from an existing lockfile fails boot", async () => {
    const root = await app({ "skills/s/SKILL.md": skillMd("s"), "skills/t/SKILL.md": skillMd("t") });
    const one = createRegistry();
    one.skill("s", { path: "skills/s" });
    await writeLock(one, await loadSkills(one, { root }), path.join(root, "skills.lock.json"));
    const two = createRegistry();
    two.skill("s", { path: "skills/s" });
    two.skill("t", { path: "skills/t" });
    await expect(loadSkills(two, { root })).rejects.toThrow(/"t" is not in the lockfile/);
  });
});

describe("npm packages", () => {
  test("resolves the package's skill folder; one that points outside the package fails", async () => {
    const root = await app({
      "node_modules/@acme/skill-x/package.json": JSON.stringify({ name: "@acme/skill-x", version: "1.0.0", skill: "skill" }),
      "node_modules/@acme/skill-x/skill/SKILL.md": skillMd("x", "[r](./r.md)"),
      "node_modules/@acme/skill-x/skill/r.md": "child",
      "node_modules/@acme/skill-bad/package.json": JSON.stringify({ name: "@acme/skill-bad", version: "1.0.0", skill: "../skill-x/skill" }),
    });
    const ok = createRegistry();
    ok.skill("x", { package: "@acme/skill-x" });
    expect(paths((await loadSkills(ok, { root })).skills.get("x")!)).toEqual(["SKILL.md", "r.md"]);

    const bad = createRegistry();
    bad.skill("x", { package: "@acme/skill-bad" });
    await expect(loadSkills(bad, { root })).rejects.toThrow(/outside the package/);

    const missing = createRegistry();
    missing.skill("x", { package: "@acme/not-installed" });
    await expect(loadSkills(missing, { root })).rejects.toThrow(/cannot resolve package/);
  });
});

describe("frontmatter", () => {
  test("scalars, quotes, and folded values", () => {
    expect(parseFrontmatter('---\nname: "a"\ndescription: >\n  one\n  two\nlicense: MIT\n---\nbody')).toEqual({ name: "a", description: "one two", license: "MIT" });
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });
});
