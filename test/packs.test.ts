import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadPack, loadPacks, PackError, rolesPack } from "../src/server";

const made: string[] = [];
afterAll(async () => { await Promise.all(made.map((d) => rm(d, { recursive: true, force: true }))); });

async function dir(files: Record<string, string>): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(tmpdir(), "factory-pack-")));
  made.push(d);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(d, rel)), { recursive: true });
    await writeFile(path.join(d, rel), content);
  }
  return d;
}

/** A small method a Hermes Agent user might bring: their SOUL.md as the persona, one skill as a project rule. */
const hermesPack = {
  "factory.yaml": [
    "name: hermes-flow",
    "rules: [house-style]",
    "stages:",
    "  plan:",
    "    persona: soul",
    "    produces: { artifact: plan, template: plan, commit: 'plans/{runId}.md' }",
    "    checklist: [Every step has an owner]",
    "    next: build",
    "  build:",
    "    runsIn: sandbox",
    "    persona: soul",
    "    reads: [plan]",
    "    produces: { artifact: report }",
    "    next:",
    "      shipped: { finish: done }",
    "      blocked: plan",
  ].join("\n"),
  "personas/soul.md": "# SOUL\nYou are Hermes: patient, exact, and you never guess.",
  "stages/plan.md": "Plan the work for {{request}}.",
  "stages/build.md": "Build what the plan says.",
  "templates/plan.md": "## Steps *(mandatory)*",
  "templates/report.md": "## Result *(mandatory)*",
  "skills/house-style/SKILL.md": "---\nname: house-style\ndescription: how we write\n---\nShort sentences.",
};

describe("workflow packs", () => {
  test("the shipped roles pack loads: six stages, qualified names, every file pinned", async () => {
    const pack = await loadPack(rolesPack);
    expect(pack.name).toBe("roles");
    const [p] = pack.pipelines;
    expect(p!.name).toBe("roles");
    expect(p!.stages.map((s) => s.name)).toEqual(["analyst", "pm", "architect", "story", "dev", "qa"]);
    const story = p!.stages.find((s) => s.name === "story")!;
    expect(story).toMatchObject({
      persona: "roles/scrum-master", instructions: "roles/story", reads: ["prd", "architecture", "story", "qa-gate"],
      produces: { artifact: "story", template: "roles/story", commit: "docs/factory/{runId}/stories/{seq}.md" },
      outcomes: ["ready", "none-left"], route: { ready: "dev", "none-left": { finish: "done" } },
    });
    expect(p!.stages.find((s) => s.name === "qa")!.outcomes).toEqual(["pass", "concerns", "fail"]);
    expect(Object.keys(p!.pins).filter((k) => k.startsWith("template:"))).toHaveLength(6);
    expect(p!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadPack(rolesPack)).pipelines[0]!.hash).toBe(p!.hash); // stable
  });

  test("bring your own: a SOUL.md persona, a project-rule skill, a routing table; the default pipeline is the pack", async () => {
    const root = await dir(hermesPack);
    const pack = await loadPack(root);
    const [p] = pack.pipelines;
    expect(p!.name).toBe("hermes-flow");
    expect(p!.rules).toEqual(["hermes-flow/house-style"]);
    expect(pack.texts.get("persona:hermes-flow/soul")!.content).toContain("You are Hermes");
    expect(pack.skills.get("hermes-flow/house-style")!.name).toBe("house-style");
    expect(p!.stages[1]).toMatchObject({ runsIn: "sandbox", reads: ["plan"], outcomes: ["shipped", "blocked"], produces: { artifact: "report", template: "hermes-flow/report" } });
    expect(Object.keys(p!.pins).sort()).toEqual([
      "instructions:hermes-flow/build", "instructions:hermes-flow/plan", "persona:hermes-flow/soul",
      "skill:hermes-flow/house-style", "template:hermes-flow/plan", "template:hermes-flow/report",
    ]);
  });

  test("editing a pack file changes the pins and the hash (running runs keep their copy)", async () => {
    const root = await dir(hermesPack);
    const before = (await loadPack(root)).pipelines[0]!;
    await writeFile(path.join(root, "personas/soul.md"), "# SOUL\nYou are Hermes, now terse.");
    const after = (await loadPack(root)).pipelines[0]!;
    expect(after.pins["persona:hermes-flow/soul"]).not.toBe(before.pins["persona:hermes-flow/soul"]);
    expect(after.hash).not.toBe(before.hash);
  });

  test("an overlay replaces files and merges stage fields over the base", async () => {
    const overlay = await dir({
      "factory.yaml": "stages:\n  plan:\n    checklist: [Every step has an owner, Every step has a date]\n",
      "templates/plan.md": "## Steps *(mandatory)*\n## Dates *(mandatory)*",
    });
    const base = await dir(hermesPack);
    const plain = (await loadPack(base)).pipelines[0]!;
    const layered = await loadPack({ dir: base, overlays: [overlay] });
    const plan = layered.pipelines[0]!.stages[0]!;
    expect(plan.checklist).toEqual(["Every step has an owner", "Every step has a date"]);
    expect(plan.persona).toBe("hermes-flow/soul"); // untouched fields stay
    expect(layered.texts.get("template:hermes-flow/plan")!.content).toContain("## Dates");
    expect(layered.pipelines[0]!.hash).not.toBe(plain.hash);
  });

  test("every definition problem is reported at once", async () => {
    const root = await dir({
      "factory.yaml": [
        "name: broken",
        "stages:",
        "  a:",
        "    persona: ghost",
        "    reads: [nothing]",
        "    checklist: [x]",
        "    outcomes: [go, stop]",
        "    next: { go: b, other: c }",
        "  b:",
        "    next: { finish: done }",
      ].join("\n"),
      "stages/a.md": "A",
    });
    const err = await loadPack(root).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PackError);
    const msg = (err as Error).message;
    for (const part of [
      "personas/ghost.md does not exist",
      "a checklist needs an artifact",
      'outcome "stop" has no route',
      'next routes "other", which is not in outcomes',
      "stages/b.md does not exist",
      'stage "a" routes to "c", which is not in the pipeline',
      'stage "a" reads "nothing", which no stage of the pipeline produces',
    ]) expect(msg).toContain(part);
  });

  test("a missing factory.yaml, invalid YAML and duplicate pipelines across packs fail", async () => {
    await expect(loadPack(await dir({ "README.md": "x" }))).rejects.toThrow(/factory.yaml is missing/);
    await expect(loadPack(await dir({ "factory.yaml": "name: [unclosed" }))).rejects.toThrow(/not valid YAML/);
    const a = await dir(hermesPack);
    const b = await dir({ ...hermesPack, "factory.yaml": hermesPack["factory.yaml"].replace("name: hermes-flow", "name: other\npipelines: [{ name: hermes-flow, stages: [plan, build] }]") });
    await expect(loadPacks([a, b])).rejects.toThrow(/defined by both pack "hermes-flow" and pack "other"/);
  });
});
