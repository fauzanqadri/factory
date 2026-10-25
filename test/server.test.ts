import { afterEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { createApi, type WorkflowClientLike } from "../src/server";
import { registry } from "./fixtures/registry";

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

async function serve(client: WorkflowClientLike) {
  server = createServer(createApi({ client, registry, taskQueue: "q", token: TOKEN }));
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
