import { describe, expect, test } from "vitest";
import { createRegistry, dispatchEvent, type HookEvent } from "../src";

const defaults = { remindAfter: "24h", gateTimeout: "7d" };

function registry() {
  const r = createRegistry();
  r.stage({ name: "intake", runsIn: "host", next: () => "triage" });
  r.stage({ name: "triage", runsIn: "host", next: () => ({ finish: "done" }) });
  r.stage({ name: "planning", runsIn: "host", skip: (ctx) => ctx.ticketRef?.startsWith("HOTFIX-") ?? false, next: () => "triage" });
  for (const s of ["intake", "triage", "planning"]) r.prompt(s, () => s);
  r.pipeline({ name: "ticket", version: 1, stages: ["intake", "planning", "triage"], defaults });
  r.pipeline({ name: "support", version: 1, stages: ["intake", "triage"], defaults });
  return r;
}

const event = (over: Partial<HookEvent> = {}): HookEvent => ({
  name: "stage.approved", eventId: "run-C-1:stage.approved:triage:1", at: "2026-10-25T00:00:00Z",
  runId: "run-C-1", pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: "1", starter: "U1", request: "x",
  stage: "triage", attempt: 1, ...over,
});

describe("hooks", () => {
  test("filters by event, stage and pipeline, in registration order", () => {
    const r = registry();
    const calls: string[] = [];
    r.on("stage.approved", () => { calls.push("all"); });
    r.on("stage.approved", { stage: "triage" }, () => { calls.push("triage"); });
    r.on("stage.approved", { stage: ["intake", "planning"] }, () => { calls.push("early"); });
    r.on("stage.approved", { pipeline: "support" }, () => { calls.push("support"); });
    r.on("run.finished", () => { calls.push("finished"); });

    const names = (where: { stage?: string; pipeline: string }) =>
      r.hooksFor("stage.approved", where).map((h) => { h.handler(event()); return calls.pop(); });
    expect(names({ stage: "triage", pipeline: "ticket" })).toEqual(["all", "triage"]);
    expect(names({ stage: "intake", pipeline: "support" })).toEqual(["all", "early", "support"]);
    expect(r.hooksFor("run.finished", { pipeline: "ticket" })).toHaveLength(1);
  });

  test("required handlers run first and a failure throws before any best-effort side effect", async () => {
    const r = registry();
    const calls: string[] = [];
    r.on("stage.approved", () => { calls.push("best-effort"); });
    r.on("stage.approved", { mode: "required" }, () => { calls.push("required"); throw new Error("jira down"); });
    await expect(dispatchEvent(r, event())).rejects.toThrow("jira down");
    expect(calls).toEqual(["required"]);
  });

  test("best-effort failures are collected and logged, and the rest still run", async () => {
    const r = registry();
    const calls: string[] = [];
    const logs: string[] = [];
    r.on("stage.approved", { mode: "required" }, () => { calls.push("required"); });
    r.on("stage.approved", () => { throw new Error("metrics down"); });
    r.on("stage.approved", async () => { calls.push("audit"); });
    const res = await dispatchEvent(r, event(), (m) => logs.push(m));
    expect(calls).toEqual(["required", "audit"]);
    expect(res).toEqual({ ran: 3, failed: [{ index: 0, error: "metrics down" }] });
    expect(logs[0]).toContain("run-C-1:stage.approved:triage:1");
  });

  test("an event with no hooks is a no-op", async () => {
    expect(await dispatchEvent(registry(), event({ name: "gate.reminded" }))).toEqual({ ran: 0, failed: [] });
  });

  test("validate flags hooks filtering on unknown stages or pipelines", () => {
    const r = registry();
    r.on("stage.started", { stage: "qa" }, () => {});
    r.on("run.finished", { pipeline: "nope" }, () => {});
    expect(r.validate()).toEqual([
      'hook on "stage.started" filters on unregistered stage "qa"',
      'hook on "run.finished" filters on unregistered pipeline "nope"',
    ]);
  });

  test("skip is a pure decision on the stage", () => {
    const planning = registry().getStage("planning");
    const ctx = { runId: "r", pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: "1", starter: "U", request: "x" };
    expect(planning.skip?.({ ...ctx, ticketRef: "HOTFIX-12" })).toBe(true);
    expect(planning.skip?.({ ...ctx, ticketRef: "PL-12" })).toBe(false);
  });
});
