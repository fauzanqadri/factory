import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { createApi, type WorkflowClientLike } from "../src/server";
import { registry } from "./fixtures/registry";
import type { LoadedText, PipelineSnapshot, RunState } from "../src/types";

const TOKEN = "api-token-for-tests";
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function fakeClient(over: { start?: () => Promise<unknown>; signal?: () => Promise<void>; query?: () => Promise<unknown> } = {}) {
  const log: any[] = [];
  const client = {
    workflow: {
      start: async (type: string, opts: any) => { log.push(["start", type, opts]); return over.start ? over.start() : {}; },
      getHandle: (id: string) => ({
        signal: async (sig: any, arg: any) => { log.push(["signal", id, sig.name, arg]); return over.signal?.(); },
        query: async () => (over.query ? over.query() : { stage: "intake", attempt: 1, status: "running", history: [] }),
      }),
    },
  } as unknown as WorkflowClientLike;
  return { client, log };
}

async function serve(client: WorkflowClientLike, extra: { packs?: PipelineSnapshot[]; texts?: Map<string, LoadedText> } = {}) {
  server = createServer(createApi({ client, registry, taskQueue: "q", token: TOKEN, ...extra }));
  await new Promise<void>((r) => server!.listen(0, r));
  const port = (server.address() as any).port;
  return (path: string, init: RequestInit = {}, auth = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) } });
}

const startBody = { pipeline: "ticket", channelId: "C1", threadTs: "1.2", sessionId: "s", starter: "U1", request: "fix it" };

describe("factory API", () => {
  test("healthz is open; everything else needs the bearer", async () => {
    const call = await serve(fakeClient().client);
    expect((await call("/healthz", {}, false)).status).toBe(200);
    expect((await call("/runs", { method: "POST", body: "{}" }, false)).status).toBe(401);
  });

  test("POST /runs starts run-<channel>-<thread> with the latest pipeline version pinned", async () => {
    const f = fakeClient();
    const call = await serve(f.client);
    const res = await call("/runs", { method: "POST", body: JSON.stringify(startBody) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: "run-C1-1.2", pipeline: "ticket", pipelineVersion: 1 });
    const [, type, opts] = f.log[0];
    expect(type).toBe("pipelineWorkflow");
    expect(opts).toMatchObject({ workflowId: "run-C1-1.2", taskQueue: "q", args: [{ ...startBody, pipelineVersion: 1 }] });
  });

  test("POST /runs: 400 on a missing field, 422 on an unknown pipeline, 409 when the thread already runs", async () => {
    const call = await serve(fakeClient({ start: async () => { throw new WorkflowExecutionAlreadyStartedError("x", "run-C1-1.2", "pipelineWorkflow"); } }).client);
    expect((await call("/runs", { method: "POST", body: JSON.stringify({ ...startBody, starter: "" }) })).status).toBe(400);
    expect((await call("/runs", { method: "POST", body: JSON.stringify({ ...startBody, pipeline: "nope" }) })).status).toBe(422);
    expect((await call("/runs", { method: "POST", body: JSON.stringify(startBody) })).status).toBe(409);
  });

  test("approvals and cancel become signals; GET returns the state query", async () => {
    const f = fakeClient();
    const call = await serve(f.client);
    const approval = { gateId: "g1", stage: "intake", attempt: 1, decision: "approve", by: "U2" };
    expect((await call("/runs/run-C1-1.2/approvals", { method: "POST", body: JSON.stringify(approval) })).status).toBe(202);
    expect((await call("/runs/run-C1-1.2/cancel", { method: "POST", body: JSON.stringify({ by: "U1" }) })).status).toBe(202);
    expect(f.log.map((l) => l.slice(0, 3))).toEqual([["signal", "run-C1-1.2", "approval"], ["signal", "run-C1-1.2", "cancel"]]);
    expect(f.log[0][3]).toEqual(approval);
    expect(await (await call("/runs/run-C1-1.2")).json()).toMatchObject({ stage: "intake", status: "running" });
  });

  test("a bad approval is 400 and an unknown run is 404", async () => {
    const call = await serve(fakeClient({ signal: async () => { throw new WorkflowNotFoundError("gone", "run-x", undefined); } }).client);
    expect((await call("/runs/run-x/approvals", { method: "POST", body: JSON.stringify({ gateId: "g", stage: "s", decision: "maybe", by: "U" }) })).status).toBe(400);
    expect((await call("/runs/run-x/approvals", { method: "POST", body: JSON.stringify({ gateId: "g", stage: "s", decision: "approve", by: "U" }) })).status).toBe(404);
  });
});

const template: LoadedText = { kind: "template", name: "spec", hash: "t", content: "## Problem *(mandatory)*\n<!-- what hurts -->\n## Goals *(mandatory)*" };
const texts = new Map([["template:spec", template]]);
const atSpecify = (over: Partial<RunState> = {}): RunState => ({
  stage: "specify", attempt: 1, status: "running", history: [],
  contract: { artifact: "spec", template: "spec", checklist: ["goals are measurable"], clarifyMax: 1, fromRegistry: true },
  ...over,
});
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

describe("method layer API", () => {
  test("POST /runs for a pack pipeline copies its snapshot into the run", async () => {
    const snapshot = { pack: "p", name: "flow", version: 3, hash: "abc", stages: [], defaults: { remindAfter: "1h", gateTimeout: "1d" }, rules: [], pins: {}, pin: "record" } as PipelineSnapshot;
    const f = fakeClient();
    const call = await serve(f.client, { packs: [snapshot] });
    const res = await call("/runs", post({ ...startBody, pipeline: "flow" }));
    expect(await res.json()).toEqual({ runId: "run-C1-1.2", pipeline: "flow", pipelineVersion: 3, definitionHash: "abc" });
    expect(f.log[0][2].args[0]).toMatchObject({ pipeline: "flow", pipelineVersion: 3, snapshot });
    expect((await call("/runs", post({ ...startBody, pipeline: "flow", pipelineVersion: 2 }))).status).toBe(422);
  });

  test("POST /artifacts checks the submission against the run's contract: 422 with every problem", async () => {
    const f = fakeClient({ query: async () => atSpecify() });
    const call = await serve(f.client, { texts });
    const res = await call("/runs/run-C1-1.2/artifacts", post({ stage: "specify", attempt: 1, content: "## Problem\n<!-- what hurts -->\n" }));
    expect(res.status).toBe(422);
    expect((await res.json()).problems).toEqual([
      'mandatory section "problem" is empty',
      'mandatory section "goals" is missing',
      "template guidance comments are still in the artifact: remove them",
      'checklist item not answered: "goals are measurable"',
    ]);
    expect(f.log).toEqual([]); // nothing reached the run
  });

  test("POST /artifacts: a valid one is signalled with its hash and open questions", async () => {
    const f = fakeClient({ query: async () => atSpecify() });
    const call = await serve(f.client, { texts });
    const content = "## Problem\nslow refunds\n## Goals\nG-1 [NEEDS CLARIFICATION: which cards?]";
    const res = await call("/runs/run-C1-1.2/artifacts", post({ stage: "specify", attempt: 1, content, checklist: [{ item: "goals are measurable", pass: true }] }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ questions: ["which cards?"], approvable: false });
    const [kind, , sig, candidate] = f.log[0];
    expect([kind, sig]).toEqual(["signal", "artifact"]);
    expect(candidate).toMatchObject({ stage: "specify", attempt: 1, artifact: "spec", content, hash: body.hash, questions: ["which cards?"] });
  });

  test("POST /artifacts: 400 for a bad body, 409 for a stale attempt or a stage that produces nothing", async () => {
    const call = await serve(fakeClient({ query: async () => atSpecify() }).client, { texts });
    expect((await call("/runs/r/artifacts", post({ stage: "specify", content: "x" }))).status).toBe(400);
    expect((await call("/runs/r/artifacts", post({ stage: "specify", attempt: 1, content: "x", checklist: [{ item: 1 }] }))).status).toBe(400);
    expect((await call("/runs/r/artifacts", post({ stage: "specify", attempt: 2, content: "x" }))).status).toBe(409);
    const plain = await serve(fakeClient({ query: async () => atSpecify({ contract: { clarifyMax: 3, fromRegistry: true } }) }).client, { texts });
    expect((await plain("/runs/r/artifacts", post({ stage: "specify", attempt: 1, content: "x" }))).status).toBe(409);
  });

  test("approvals are refused with a reason when the run cannot act on them", async () => {
    const card = { gateId: "g", stage: "specify", attempt: 1, by: "U2" };
    const candidate = { stage: "specify", attempt: 1, artifact: "spec", content: "c", hash: "h", checklist: [], questions: ["which cards?"] };
    const noArtifact = await serve(fakeClient({ query: async () => atSpecify() }).client);
    expect((await noArtifact("/runs/r/approvals", post({ ...card, decision: "approve" }))).status).toBe(409);

    const open = await serve(fakeClient({ query: async () => atSpecify({ candidate }) }).client);
    const r1 = await open("/runs/r/approvals", post({ ...card, decision: "approve" }));
    expect([r1.status, (await r1.json()).error]).toEqual([409, 'answer the 1 open question(s) first (decision "answer")']);
    expect((await open("/runs/r/approvals", post({ ...card, decision: "answer", answers: [] }))).status).toBe(400);
    expect((await open("/runs/r/approvals", post({ ...card, decision: "answer", answers: ["Visa"] }))).status).toBe(202);

    const routed = await serve(fakeClient({ query: async () => atSpecify({ candidate: { ...candidate, questions: [] }, contract: { artifact: "spec", template: "spec", outcomes: ["ok", "redo"], outcomeRequired: true, clarifyMax: 3, fromRegistry: true } }) }).client);
    expect((await routed("/runs/r/approvals", post({ ...card, decision: "approve", outcome: "Ok" }))).status).toBe(422);
    expect((await routed("/runs/r/approvals", post({ ...card, decision: "approve" }))).status).toBe(422); // outcome required
    expect((await routed("/runs/r/approvals", post({ ...card, decision: "approve", outcome: "ok" }))).status).toBe(202);
    expect((await routed("/runs/r/approvals", post({ ...card, attempt: 0, decision: "approve" }))).status).toBe(202); // a stale card passes through; the run ignores it
  });

  test("GET /artifacts lists every version and the candidate; /artifacts/:name returns the latest or ?seq", async () => {
    const v = (seq: number) => ({ artifact: "spec", seq, stage: "specify", attempt: seq, content: `S${seq}`, hash: "h", approvedBy: "U2", at: "t" });
    const call = await serve(fakeClient({ query: async () => atSpecify({ artifacts: [v(1), v(2)] }) }).client);
    expect(await (await call("/runs/r/artifacts")).json()).toEqual({ artifacts: [v(1), v(2)], candidate: null });
    expect((await (await call("/runs/r/artifacts/spec")).json()).seq).toBe(2);
    expect((await (await call("/runs/r/artifacts/spec?seq=1")).json()).content).toBe("S1");
    expect((await call("/runs/r/artifacts/plan")).status).toBe(404);
  });
});
