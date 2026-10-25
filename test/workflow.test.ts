import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { FactoryActivities } from "../src/activities";
import { approvalSignal, cancelSignal, stateQuery, type PipelineInput, type PipelineResult } from "../src/workflow";
import { registry } from "./fixtures/registry";
import type { Approval, HookEvent, RunState } from "../src/types";

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
const calls: Array<{ kind: string; [k: string]: unknown }> = [];
const events: HookEvent[] = [];
const queue = "test";

const activities: FactoryActivities = {
  async runStage(i) { calls.push({ kind: "runStage", stage: i.stage, attempt: i.attempt, note: i.note, requestId: i.requestId, prompt: registry.getPrompt(i.stage)({ ...i.ctx, stage: i.stage, attempt: i.attempt, note: i.note }) }); },
  async emit(e) { events.push(e); },
  async remind(i) { calls.push({ kind: "remind", stage: i.stage }); },
  async finish(i) { calls.push({ kind: "finish", reason: i.reason }); },
};

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: queue,
    workflowsPath: fileURLToPath(new URL("./fixtures/workflows.ts", import.meta.url)),
    activities,
  });
  running = worker.run();
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

let seq = 0;
async function start(over: Partial<PipelineInput> = {}) {
  calls.length = 0;
  events.length = 0;
  const id = `run-C-${++seq}`;
  const input: PipelineInput = { pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: String(seq), sessionId: "s", starter: "U1", request: "fix it", ...over };
  return env.client.workflow.start("pipelineWorkflow", { workflowId: id, taskQueue: queue, args: [input] });
}
type Handle = Awaited<ReturnType<typeof start>>;

/** Wait until the run is waiting at `stage` (attempt), then return its state. */
async function waitingAt(h: Handle, stage: string, attempt = 1): Promise<RunState> {
  for (let i = 0; i < 200; i++) {
    const s = await h.query(stateQuery);
    if (s.stage === stage && s.attempt === attempt && s.waitingSince) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run never waited at ${stage}#${attempt}`);
}
const approve = (h: Handle, stage: string, extra: Partial<Approval> = {}) =>
  h.signal(approvalSignal, { gateId: `${stage}-${extra.attempt ?? 1}-${extra.decision ?? "approve"}`, stage, decision: "approve", by: "U2", ...extra });

describe("pipeline workflow", () => {
  test("runs every stage in order, waiting for an approval after each", async () => {
    const h = await start();
    for (const s of ["intake", "triage", "planning", "building"]) { await waitingAt(h, s); await approve(h, s); }
    const res = (await h.result()) as PipelineResult;
    expect(res.finish).toBe("done");
    expect(calls.map((c) => c.kind === "runStage" ? c.stage : c.kind)).toEqual(["intake", "triage", "planning", "building", "finish"]);
    expect(calls[0]!.requestId).toBe(`${h.workflowId}:intake:1`);
    expect(events.map((e) => e.name)).toEqual([
      "run.started",
      "stage.started", "stage.approved", "stage.started", "stage.approved",
      "stage.started", "stage.approved", "stage.started", "stage.approved",
      "run.finished",
    ]);
    expect(res.state.history.map((x) => `${x.stage}:${x.decision}`)).toEqual(["intake:approve", "triage:approve", "planning:approve", "building:approve"]);
  });

  test("a reject reruns the same stage as the next attempt, with the note in the prompt", async () => {
    const h = await start({ pipeline: "support" });
    await waitingAt(h, "intake"); await approve(h, "intake");
    await waitingAt(h, "triage");
    await approve(h, "triage", { decision: "reject", note: "check the other service" });
    await waitingAt(h, "triage", 2);
    const rerun = calls.filter((c) => c.kind === "runStage" && c.stage === "triage");
    expect(rerun.map((c) => c.attempt)).toEqual([1, 2]);
    expect(rerun[1]!.prompt).toBe("triage#2 note=check the other service");
    expect(rerun[1]!.requestId).toBe(`${h.workflowId}:triage:2`);
    expect(events.some((e) => e.name === "stage.rejected" && e.approval?.note === "check the other service")).toBe(true);
    await approve(h, "triage", { attempt: 2, outcome: "answer" });
    expect(((await h.result()) as PipelineResult).finish).toBe("answer");
  });

  test("a stale card from an earlier attempt and a repeated gateId are both ignored", async () => {
    const h = await start({ pipeline: "support" });
    await waitingAt(h, "intake"); await approve(h, "intake");
    await waitingAt(h, "triage");
    await approve(h, "triage", { attempt: 1, decision: "reject", note: "again" });
    await waitingAt(h, "triage", 2);
    await h.signal(approvalSignal, { gateId: "old-card", stage: "triage", attempt: 1, decision: "approve", by: "U3" }); // stale
    await approve(h, "triage", { attempt: 1, decision: "reject", note: "again" });                                    // repeated gateId
    const s = await h.query(stateQuery);
    expect(s.attempt).toBe(2);
    expect(s.status).toBe("running");
    await approve(h, "triage", { attempt: 2, outcome: "answer" });
    expect(((await h.result()) as PipelineResult).finish).toBe("answer");
  });

  test("a triage outcome other than code finishes early", async () => {
    const h = await start();
    await waitingAt(h, "intake"); await approve(h, "intake");
    await waitingAt(h, "triage"); await approve(h, "triage", { outcome: "data_fix" });
    const res = (await h.result()) as PipelineResult;
    expect(res.finish).toBe("data_fix");
    expect(calls.filter((c) => c.kind === "runStage").map((c) => c.stage)).toEqual(["intake", "triage"]);
  });

  test("skip passes a stage through with no turn and no gate", async () => {
    const h = await start({ ticketRef: "HOTFIX-1" });
    await waitingAt(h, "intake"); await approve(h, "intake");
    await waitingAt(h, "triage"); await approve(h, "triage", { outcome: "code" });
    await waitingAt(h, "building");
    expect(calls.some((c) => c.stage === "planning")).toBe(false);
    expect(events.some((e) => e.name === "stage.skipped" && e.stage === "planning")).toBe(true);
    await approve(h, "building");
    const res = (await h.result()) as PipelineResult;
    expect(res.state.history.find((x) => x.stage === "planning")?.decision).toBe("skip");
  });

  test("an unanswered gate reminds after remindAfter and times out after gateTimeout", async () => {
    const h = await start();
    await waitingAt(h, "intake");
    const res = (await h.result()) as PipelineResult; // time skipping jumps the 1h reminders and the 3h timeout
    expect(res.finish).toBe("timed-out");
    expect(calls.filter((c) => c.kind === "remind").length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.name === "gate.reminded").length).toBeGreaterThanOrEqual(2);
    expect(calls.at(-1)).toEqual({ kind: "finish", reason: "timed-out" });
  });

  test("cancel finishes the run as cancelled", async () => {
    const h = await start();
    await waitingAt(h, "intake");
    await h.signal(cancelSignal, { by: "U1" });
    expect(((await h.result()) as PipelineResult).finish).toBe("cancelled");
    expect(events.at(-1)?.name).toBe("run.finished");
  });
});
