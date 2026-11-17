import { describe, expect, test } from "vitest";
import { createRegistry } from "../src";

const defaults = { remindAfter: "24h", gateTimeout: "7d" };

function sample() {
  const r = createRegistry();
  r.stage({ name: "intake", runsIn: "host", next: () => "triage" });
  r.stage({ name: "triage", runsIn: "host", next: (a) => (a.outcome && a.outcome !== "code" ? { finish: a.outcome } : "build") });
  r.stage({ name: "build", runsIn: "sandbox", next: () => ({ finish: "done" }) });
  for (const s of ["intake", "triage", "build"]) r.prompt(s, (i) => `${i.stage} #${i.attempt}`);
  r.pipeline({ name: "ticket", version: 1, stages: ["intake", "triage", "build"], defaults });
  return r;
}

const ctx = { runId: "r", pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: "1.0", starter: "U", request: "x" };

describe("registry", () => {
  test("stages, pipelines and prompts round-trip; a consistent set validates clean", () => {
    const r = sample();
    expect(r.getStage("build").runsIn).toBe("sandbox");
    expect(r.getPipeline("ticket", 1).stages).toEqual(["intake", "triage", "build"]);
    expect(r.getPrompt("triage")({ ...ctx, stage: "triage", attempt: 2 })).toBe("triage #2");
    expect(r.validate()).toEqual([]);
  });

  test("next decides the path: a non-code outcome finishes early", () => {
    const triage = sample().getStage("triage");
    const approval = { gateId: "g", stage: "triage", decision: "approve" as const, by: "U" };
    expect(triage.next({ ...approval, outcome: "code" }, ctx)).toBe("build");
    expect(triage.next({ ...approval, outcome: "answer" }, ctx)).toEqual({ finish: "answer" });
  });

  test("versions are append-only and the latest is the default", () => {
    const r = sample();
    expect(() => r.pipeline({ name: "ticket", version: 1, stages: ["intake"], defaults })).toThrow(/new version/);
    r.pipeline({ name: "ticket", version: 2, stages: ["intake", "build"], defaults });
    expect(r.getPipeline("ticket").version).toBe(2);
    expect(r.getPipeline("ticket", 1).stages).toHaveLength(3);
  });

  test("rejects duplicates, empty pipelines, bad versions and unknown names", () => {
    const r = sample();
    expect(() => r.stage({ name: "intake", runsIn: "host", next: () => "x" })).toThrow(/already/);
    expect(() => r.prompt("intake", () => "")).toThrow(/already/);
    expect(() => r.pipeline({ name: "p", version: 1, stages: [], defaults })).toThrow(/no stages/);
    expect(() => r.pipeline({ name: "p", version: 0, stages: ["intake"], defaults })).toThrow(/positive integer/);
    expect(() => r.getStage("nope")).toThrow(/unknown stage/);
    expect(() => r.getPipeline("nope")).toThrow(/unknown pipeline/);
    expect(() => r.getPrompt("nope")).toThrow(/no prompt/);
  });

  test("validate lists unregistered stages and missing prompts", () => {
    const r = createRegistry();
    r.stage({ name: "a", runsIn: "host", next: () => ({ finish: "done" }) });
    r.pipeline({ name: "p", version: 1, stages: ["a", "b"], defaults });
    expect(r.validate()).toEqual([
      'stage "a" (pipeline "p@1") has no prompt',
      'pipeline "p@1" uses unregistered stage "b"',
    ]);
  });
  test("skills: registered by name, duplicates and bad sources throw, unknown ones on a stage show in validate()", () => {
    const r = sample();
    r.skill("tdd", { path: "skills/tdd" });
    expect(r.getSkillDecls().map((d) => d.name)).toEqual(["tdd"]);
    expect(() => r.skill("tdd", { path: "x" })).toThrow("already registered");
    expect(() => r.skill("bad name", { path: "x" })).toThrow("must be");
    expect(() => r.skill("p", { path: "" })).toThrow("give a path, or a package");
    expect(() => r.skill("p", { package: "" })).toThrow("give a path, or a package");
    r.skill("from-pkg", { package: "@acme/skills", path: "tdd" }); // a folder inside a package
    expect(r.getSkillDecls().map((d) => d.name)).toEqual(["tdd", "from-pkg"]);
    const withSkills = createRegistry();
    withSkills.stage({ name: "a", runsIn: "host", skills: ["missing"], next: () => ({ finish: "done" }) });
    expect(withSkills.validate()).toContain('stage "a" uses unregistered skill "missing"');
  });

  test("personas and templates: one file each, by name; validate() checks stages, reads and outcomes", () => {
    const r = createRegistry();
    r.persona("analyst", { path: "personas/analyst.md" });
    r.template("brief", { package: "@acme/method", path: "templates/brief.md" });
    expect(r.getTextDecls()).toEqual([
      { kind: "persona", name: "analyst", source: { path: "personas/analyst.md" } },
      { kind: "template", name: "brief", source: { package: "@acme/method", path: "templates/brief.md" } },
    ]);
    expect(() => r.persona("analyst", { path: "x.md" })).toThrow("already registered");
    expect(() => r.template("t", { package: "@acme/method" })).toThrow("path of the file");
    expect(() => r.stage({ name: "x", runsIn: "host", clarify: { max: -1 }, next: () => "y" })).toThrow("clarify.max");

    r.stage({ name: "analyst", runsIn: "host", persona: "analyst", produces: { artifact: "brief", template: "brief" }, next: () => "pm" });
    r.stage({ name: "pm", runsIn: "host", persona: "pm", reads: ["brief", "nothing"], outcomes: [], checklist: ["x"], produces: { artifact: "prd", template: "prd" }, next: () => ({ finish: "done" }) });
    for (const s of ["analyst", "pm"]) r.prompt(s, () => s);
    r.pipeline({ name: "plan", version: 1, stages: ["analyst", "pm"], skills: ["rules"], defaults });
    expect(r.validate()).toEqual([
      'stage "pm" uses unregistered persona "pm"',
      'stage "pm" uses unregistered template "prd"',
      'stage "pm" declares an empty outcomes list (omit it to allow any outcome)',
      'pipeline "plan@1" uses unregistered skill "rules" as a project rule',
      'stage "pm" (pipeline "plan@1") reads "nothing", which no stage of the pipeline produces',
    ]);
  });
});
