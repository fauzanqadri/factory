import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { FactoryActivities, RunStageInput } from "../src/activities";
import { loadPack, rolesPack } from "../src/server";
import { approvalSignal, artifactSignal, cancelSignal, stateQuery, type PipelineInput, type PipelineResult } from "../src/workflow";
import { registry } from "./fixtures/registry";
import type { Approval, ArtifactCandidate, HookEvent, RunState } from "../src/types";

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
const calls: Array<{ kind: string; [k: string]: unknown }> = [];
const events: HookEvent[] = [];
const queue = "test";

const activities: FactoryActivities = {
  async runStage(i) {
    const prompt = i.spec ? `pack:${i.stage}` : registry.getPrompt(i.stage)({ ...i.ctx, stage: i.stage, attempt: i.attempt, note: i.note });
    calls.push({ kind: "runStage", stage: i.stage, attempt: i.attempt, note: i.note, requestId: i.requestId, prompt, input: i });
    return { promptHash: `h-${i.stage}-${i.attempt}`, skills: {} };
  },
  async emit(e) { events.push(e); },
  async remind(i) { calls.push({ kind: "remind", stage: i.stage }); },
  async finish(i) { calls.push({ kind: "finish", reason: i.reason }); },
  async commit(i) { calls.push({ kind: "commit", path: i.path, requestId: i.requestId }); return { sha: `sha-${i.path}` }; },
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

  test("a loop back to an earlier stage runs a fresh turn: unique requestId and eventId, stale cards ignored", async () => {
    const h = await start({ pipeline: "loop" });
    await waitingAt(h, "draft"); await approve(h, "draft");
    await waitingAt(h, "review"); await approve(h, "review", { outcome: "revise" });
    await waitingAt(h, "draft", 2); // the second visit counts as attempt 2, not a repeat of attempt 1
    await h.signal(approvalSignal, { gateId: "old-card", stage: "draft", attempt: 1, decision: "approve", by: "U3" }); // card from the first visit
    expect((await h.query(stateQuery)).stage).toBe("draft");
    await approve(h, "draft", { attempt: 2 });
    await waitingAt(h, "review", 2); await approve(h, "review", { attempt: 2 });
    const res = (await h.result()) as PipelineResult;
    expect(res.finish).toBe("done");

    const turns = calls.filter((c) => c.kind === "runStage");
    expect(turns.map((c) => `${c.stage}#${c.attempt}`)).toEqual(["draft#1", "review#1", "draft#2", "review#2"]);
    const ids = turns.map((c) => c.requestId as string);
    expect(new Set(ids).size).toBe(ids.length); // the host drops a repeated requestId, so a revisit must not reuse one
    const eventIds = events.map((e) => e.eventId);
    expect(new Set(eventIds).size).toBe(eventIds.length);
  });

  test("cancel finishes the run as cancelled", async () => {
    const h = await start();
    await waitingAt(h, "intake");
    await h.signal(cancelSignal, { by: "U1" });
    expect(((await h.result()) as PipelineResult).finish).toBe("cancelled");
    expect(events.at(-1)?.name).toBe("run.finished");
  });
});

let gate = 0;
const decide = (h: Handle, stage: string, attempt: number, decision: Approval["decision"] = "approve", extra: Partial<Approval> = {}) =>
  h.signal(approvalSignal, { gateId: `g${++gate}`, stage, attempt, decision, by: "U2", ...extra });
const submit = (h: Handle, stage: string, attempt: number, artifact: string, content: string, extra: Partial<ArtifactCandidate> = {}) =>
  h.signal(artifactSignal, { stage, attempt, artifact, content, hash: `hash-${content}`, checklist: [], questions: [], ...extra });
const turnsOf = (stage: string) => calls.filter((c) => c.kind === "runStage" && c.stage === stage).map((c) => c.input as RunStageInput);

describe("method layer", () => {
  test("an approve before any artifact is ignored; the approved artifact is frozen, committed and handed to the next stage", async () => {
    const h = await start({ pipeline: "spec" });
    await waitingAt(h, "specify");
    await decide(h, "specify", 1); // nothing submitted yet: dropped
    await submit(h, "specify", 1, "spec", "first draft");
    await submit(h, "specify", 1, "spec", "S1"); // a resubmission in the same turn replaces it
    await submit(h, "specify", 7, "spec", "stale"); // not the current attempt: ignored
    let s = await h.query(stateQuery);
    expect(s.stage).toBe("specify");
    expect(s.history).toEqual([]);
    expect(s.candidate?.content).toBe("S1");
    expect(s.contract).toMatchObject({ artifact: "spec", template: "spec", fromRegistry: true });
    await decide(h, "specify", 1);
    s = await waitingAt(h, "plan");
    const path = `docs/${h.workflowId}/spec-1.md`;
    expect(s.artifacts!.map((v) => [v.artifact, v.seq, v.content, v.approvedBy, v.commit])).toEqual([["spec", 1, "S1", "U2", { path, sha: `sha-${path}` }]]);
    expect(calls.find((c) => c.kind === "commit")).toMatchObject({ path, requestId: `${h.workflowId}:commit:spec:1` });
    expect(turnsOf("plan")[0]!.inputs!.map((v) => v.content)).toEqual(["S1"]);
    expect(events.find((e) => e.name === "stage.approved" && e.stage === "specify")?.artifact?.seq).toBe(1);
    expect(s.turns!.map((t) => `${t.stage}#${t.attempt}:${t.promptHash}`)).toEqual(["specify#1:h-specify-1", "plan#1:h-plan-1"]);

    await submit(h, "plan", 1, "plan", "P1", { outcome: "ok" });
    await decide(h, "plan", 1);
    const res = (await h.result()) as PipelineResult;
    expect(res.finish).toBe("done:1"); // next() received the approved artifacts
    expect(res.state.history.at(-1)).toMatchObject({ stage: "plan", decision: "approve", outcome: "ok" }); // the artifact's outcome
  });

  test("open questions block approval; an answer records the clarification and reruns the stage", async () => {
    const h = await start({ pipeline: "spec" });
    await waitingAt(h, "specify");
    await submit(h, "specify", 1, "spec", "S?", { questions: ["Which cards?"] });
    await decide(h, "specify", 1); // a question is open: dropped
    await decide(h, "specify", 1, "answer", { answers: ["Visa only"] });
    const s = await waitingAt(h, "specify", 2);
    expect(s.clarifications).toEqual([{ stage: "specify", attempt: 1, question: "Which cards?", answer: "Visa only", by: "U2" }]);
    expect(turnsOf("specify")[1]!.clarifications).toEqual(s.clarifications);
    expect(events.some((e) => e.name === "stage.clarified" && e.stage === "specify")).toBe(true);
    expect(s.history.map((x) => x.decision)).toEqual(["answer"]);
    await h.signal(cancelSignal, { by: "U1" });
    expect(((await h.result()) as PipelineResult).finish).toBe("cancelled");
  });

  test("every rejection, and the reason the run was sent back, reach the stage's next prompt", async () => {
    const h = await start({ pipeline: "spec" });
    await waitingAt(h, "specify");
    await submit(h, "specify", 1, "spec", "S1");
    await decide(h, "specify", 1);
    await waitingAt(h, "plan");
    await decide(h, "plan", 1, "reject", { note: "too vague" });
    await waitingAt(h, "plan", 2);
    await decide(h, "plan", 2, "reject", { note: "still vague" });
    await waitingAt(h, "plan", 3);
    expect(turnsOf("plan")[2]!.feedback!.map((f) => `${f.kind}:${f.attempt}:${f.note}`)).toEqual(["rejected:1:too vague", "rejected:2:still vague"]);
    await submit(h, "plan", 3, "plan", "P3", { outcome: "redo" });
    await decide(h, "plan", 3, "approve", { note: "the spec misses refunds" });
    await waitingAt(h, "specify", 2);
    expect(turnsOf("specify")[1]!.feedback).toEqual([{ kind: "sent-back", stage: "specify", attempt: 3, by: "U2", note: "the spec misses refunds", outcome: "redo", from: "plan" }]);
    await h.signal(cancelSignal, { by: "U1" });
    await h.result();
  });

  test("a pack run routes from its snapshot: the roles pack end to end, with a failed QA gate and a second story", async () => {
    const snapshot = (await loadPack(rolesPack)).pipelines[0]!;
    const h = await start({ pipeline: "roles", snapshot });
    const produces: Record<string, string> = { analyst: "brief", pm: "prd", architect: "architecture", story: "story", dev: "dev-record", qa: "qa-gate" };
    const step = async (stage: string, attempt: number, outcome?: string) => {
      await waitingAt(h, stage, attempt);
      await submit(h, stage, attempt, produces[stage]!, `${stage}#${attempt}`, outcome ? { outcome } : {});
      await decide(h, stage, attempt);
    };
    await step("analyst", 1);
    await step("pm", 1);
    await step("architect", 1);
    await step("story", 1, "ready");
    await step("dev", 1);
    await step("qa", 1, "fail");
    await step("dev", 2);
    await step("qa", 2, "pass");
    await step("story", 2, "none-left");
    const res = (await h.result()) as PipelineResult;
    expect(res.finish).toBe("done");
    expect(res.state.definitionHash).toBe(snapshot.hash);

    const dev2 = turnsOf("dev")[1]!;
    expect(dev2.spec?.persona).toBe("roles/dev");
    expect(dev2.pins).toEqual(snapshot.pins);
    expect(dev2.inputs!.map((v) => `${v.artifact}:${v.content}`)).toEqual(["story:story#1", "qa-gate:qa#1"]);
    expect(dev2.feedback).toEqual([expect.objectContaining({ kind: "sent-back", from: "qa", outcome: "fail" })]);
    expect(turnsOf("story")[1]!.inputs!.map((v) => `${v.artifact}:${v.seq}`)).toEqual(["prd:1", "architecture:1", "story:1", "qa-gate:2"]);
    expect(calls.filter((c) => c.kind === "commit").map((c) => (c.path as string).replace(`docs/factory/${h.workflowId}/`, ""))).toEqual([
      "brief.md", "prd.md", "architecture.md", "stories/1.md", "dev-records/1.md", "qa-gates/1.md", "dev-records/2.md", "qa-gates/2.md", "stories/2.md",
    ]);
  });
});
