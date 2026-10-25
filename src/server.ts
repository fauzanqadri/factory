import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { makeActivities, type HostConfig } from "./activities.js";
import type { Registry } from "./registry.js";
import type { Approval, StartRun } from "./types.js";
import { approvalSignal, cancelSignal, runIdFor, stateQuery, type PipelineInput } from "./workflow.js";

/** The part of the Temporal client the API uses (a real `Client`, or a fake in tests). */
export interface WorkflowClientLike {
  workflow: Pick<Client["workflow"], "start" | "getHandle">;
}

export interface ApiOptions {
  client: WorkflowClientLike;
  registry: Registry;
  taskQueue: string;
  /** Bearer the chat host sends (FACTORY_API_TOKEN). */
  token: string;
  /** Workflow type, i.e. the export name in the app's workflows file. */
  workflowType?: string;
}

const MAX_BODY = 256 * 1024;

/** Request handler for the factory API (docs/04-http-contract.md). */
export function createApi(o: ApiOptions) {
  const workflowType = o.workflowType ?? "pipelineWorkflow";
  const expected = Buffer.from(o.token);

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7).trim() : "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const readJson = async (req: IncomingMessage): Promise<any> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "body too large");
      chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { throw new HttpError(400, "invalid JSON"); }
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://factory");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && url.pathname === "/runs") {
        const b = (await readJson(req)) as Partial<StartRun>;
        for (const f of ["pipeline", "channelId", "threadTs", "sessionId", "starter", "request"] as const) {
          if (typeof b[f] !== "string" || !b[f]) throw new HttpError(400, `${f} is required`);
        }
        let pipelineVersion: number;
        try { pipelineVersion = o.registry.getPipeline(b.pipeline!, b.pipelineVersion).version; }
        catch (e) { throw new HttpError(422, (e as Error).message); }
        const input: PipelineInput = { ...(b as StartRun), pipelineVersion };
        const runId = runIdFor(input.channelId, input.threadTs);
        try {
          await o.client.workflow.start(workflowType, { workflowId: runId, taskQueue: o.taskQueue, args: [input] });
        } catch (e) {
          if (e instanceof WorkflowExecutionAlreadyStartedError) throw new HttpError(409, "this thread already has a running run");
          throw e;
        }
        return send(res, 201, { runId, pipeline: input.pipeline, pipelineVersion });
      }

      const m = url.pathname.match(/^\/runs\/([^/]+)(\/approvals|\/cancel)?$/);
      if (m) {
        const handle = o.client.workflow.getHandle(decodeURIComponent(m[1]!));
        try {
          if (req.method === "GET" && !m[2]) return send(res, 200, await handle.query(stateQuery));
          if (req.method === "POST" && m[2] === "/approvals") {
            const a = (await readJson(req)) as Partial<Approval>;
            if (!a.gateId || !a.stage || !a.by || (a.decision !== "approve" && a.decision !== "reject")) {
              throw new HttpError(400, "gateId, stage, decision (approve|reject) and by are required");
            }
            await handle.signal(approvalSignal, a as Approval);
            return send(res, 202);
          }
          if (req.method === "POST" && m[2] === "/cancel") {
            const b = await readJson(req);
            if (typeof b.by !== "string" || !b.by) throw new HttpError(400, "by is required");
            await handle.signal(cancelSignal, { by: b.by });
            return send(res, 202);
          }
        } catch (e) {
          if (e instanceof WorkflowNotFoundError) throw new HttpError(404, "no such run");
          throw e;
        }
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      return send(res, 500, { error: "internal error" });
    }
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface FactoryOptions {
  registry: Registry;
  /** Absolute path of the app's workflows file (exports `pipelineWorkflow`). */
  workflowsPath: string;
  temporal: { address: string; namespace: string; taskQueue: string };
  host: HostConfig;
  apiToken: string;
  port: number;
}

/** Validate the registry, then run the Temporal worker and the HTTP API in one process. */
export async function startFactory(o: FactoryOptions): Promise<{ server: Server; worker: Worker; stop(): Promise<void> }> {
  const problems = o.registry.validate();
  if (problems.length) throw new Error(`registry is not consistent:\n- ${problems.join("\n- ")}`);
  if (o.host.token.length < 32) throw new Error("FACTORY_CALLBACK_TOKEN must be at least 32 characters");
  if (!o.apiToken) throw new Error("FACTORY_API_TOKEN is empty");

  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address: o.temporal.address }),
    namespace: o.temporal.namespace,
    taskQueue: o.temporal.taskQueue,
    workflowsPath: o.workflowsPath,
    activities: makeActivities(o.registry, o.host),
  });
  const client = new Client({ connection: await Connection.connect({ address: o.temporal.address }), namespace: o.temporal.namespace });
  const server = createServer(createApi({ client, registry: o.registry, taskQueue: o.temporal.taskQueue, token: o.apiToken }));
  await new Promise<void>((resolve) => server.listen(o.port, resolve));
  const running = worker.run();
  return {
    server,
    worker,
    async stop() {
      server.close();
      worker.shutdown();
      await running;
    },
  };
}
