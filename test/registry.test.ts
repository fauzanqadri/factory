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
});
