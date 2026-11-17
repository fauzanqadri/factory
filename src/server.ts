import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { makeActivities, type HostConfig } from "./activities.js";
import { checkArtifact } from "./artifacts.js";
import { loadPacks, PackError, type PackSpec } from "./packs.js";
import type { Registry } from "./registry.js";
import { loadSkills, type LoadSkillsOptions } from "./skills.js";
import type { Approval, ArtifactCandidate, ArtifactSubmission, ChecklistAnswer, LoadedSkill, LoadedText, PipelineSnapshot, RunState, StartRun } from "./types.js";
import { approvalSignal, artifactSignal, cancelSignal, runIdFor, stateQuery, type PipelineInput } from "./workflow.js";

// Node-only, so exported here rather than from the sandbox-safe package root.
export { loadSkills, writeLock, SkillError, DEFAULT_SKILL_LIMITS, type LoadSkillsOptions, type LoadedSkills, type SkillLimits } from "./skills.js";
export { loadPack, loadPacks, PackError, type LoadedPack, type LoadPackOptions, type PackSpec } from "./packs.js";

/** The roles pack that ships with factory (analyst → pm → architect → story → dev → qa). Pass it to `startFactory({ packs })`. */
export const rolesPack = fileURLToPath(new URL("../packs/roles/", import.meta.url));

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
  /** Pack pipelines; `POST /runs` for one of these copies its snapshot into the run. */
  packs?: PipelineSnapshot[];
  /** Loaded templates (keyed `template:<name>`), for checking submitted artifacts. */
  texts?: Map<string, LoadedText>;
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
        const snapshot = (o.packs ?? []).find((p) => p.name === b.pipeline);
        if (snapshot) {
          if (b.pipelineVersion !== undefined && b.pipelineVersion !== snapshot.version) throw new HttpError(422, `pipeline "${b.pipeline}" is at version ${snapshot.version}`);
          pipelineVersion = snapshot.version;
        } else {
          try { pipelineVersion = o.registry.getPipeline(b.pipeline!, b.pipelineVersion).version; }
          catch (e) { throw new HttpError(422, (e as Error).message); }
        }
        const input: PipelineInput = { ...(b as StartRun), pipelineVersion, ...(snapshot ? { snapshot } : {}) };
        const runId = runIdFor(input.channelId, input.threadTs);
        try {
          await o.client.workflow.start(workflowType, { workflowId: runId, taskQueue: o.taskQueue, args: [input] });
        } catch (e) {
          if (e instanceof WorkflowExecutionAlreadyStartedError) throw new HttpError(409, "this thread already has a running run");
          throw e;
        }
        return send(res, 201, { runId, pipeline: input.pipeline, pipelineVersion, ...(snapshot ? { definitionHash: snapshot.hash } : {}) });
      }

      const m = url.pathname.match(/^\/runs\/([^/]+)(\/approvals|\/cancel|\/artifacts(?:\/([^/]+))?)?$/);
      if (m) {
        const handle = o.client.workflow.getHandle(decodeURIComponent(m[1]!));
        const sub = m[2] ?? "";
        try {
          if (req.method === "GET" && !sub) return send(res, 200, await handle.query(stateQuery));
          if (req.method === "GET" && sub.startsWith("/artifacts")) {
            const st = await handle.query(stateQuery);
            const all = st.artifacts ?? [];
            if (!m[3]) return send(res, 200, { artifacts: all, candidate: st.candidate ?? null });
            const name = decodeURIComponent(m[3]);
            const versions = all.filter((v) => v.artifact === name);
            if (!versions.length) throw new HttpError(404, `no approved artifact "${name}"`);
            const seq = url.searchParams.get("seq");
            const v = seq ? versions.find((x) => String(x.seq) === seq) : versions.at(-1);
            if (!v) throw new HttpError(404, `artifact "${name}" has no version ${seq}`);
            return send(res, 200, v);
          }
          if (req.method === "POST" && sub === "/artifacts") {
            const b = (await readJson(req)) as Partial<ArtifactSubmission>;
            if (typeof b.stage !== "string" || !b.stage || !Number.isInteger(b.attempt) || typeof b.content !== "string") {
              throw new HttpError(400, "stage, attempt (integer) and content (string) are required");
            }
            if (b.outcome !== undefined && typeof b.outcome !== "string") throw new HttpError(400, "outcome must be a string");
            const checklist = parseChecklist(b.checklist);
            const st = await handle.query(stateQuery);
            const c = st.contract;
            if (st.status !== "running" || st.stage !== b.stage || st.attempt !== b.attempt) {
              throw new HttpError(409, `the run is not waiting for ${b.stage} attempt ${b.attempt} (it is at ${st.stage} attempt ${st.attempt}, ${st.status})`);
            }
            if (!c?.artifact || !c.template) throw new HttpError(409, `stage "${b.stage}" does not produce an artifact`);
            const template = o.texts?.get(`template:${c.template}`);
            if (!template) throw new HttpError(500, `template "${c.template}" is not loaded`);
            const result = checkArtifact({
              content: b.content, template: template.content, checklist: c.checklist, answers: checklist,
              outcomes: c.outcomes, outcome: b.outcome, clarifyMax: c.clarifyMax,
            });
            if (c.fromRegistry) {
              const def = o.registry.getStage(b.stage);
              if (def.check) result.problems.push(...def.check({ stage: b.stage, attempt: b.attempt!, content: b.content, outcome: b.outcome, checklist }));
            }
            if (result.problems.length) return send(res, 422, { error: "the artifact does not meet its contract", problems: result.problems });
            const candidate: ArtifactCandidate = {
              stage: b.stage, attempt: b.attempt!, artifact: c.artifact, content: b.content,
              hash: createHash("sha256").update(b.content).digest("hex"),
              ...(b.outcome !== undefined ? { outcome: b.outcome } : {}), checklist, questions: result.questions,
            };
            await handle.signal(artifactSignal, candidate);
            return send(res, 202, { hash: candidate.hash, questions: candidate.questions, approvable: candidate.questions.length === 0 });
          }
          if (req.method === "POST" && sub === "/approvals") {
            const a = (await readJson(req)) as Partial<Approval>;
            if (!a.gateId || !a.stage || !a.by || (a.decision !== "approve" && a.decision !== "reject" && a.decision !== "answer")) {
              throw new HttpError(400, "gateId, stage, decision (approve|reject|answer) and by are required");
            }
            if (a.answers !== undefined && !(Array.isArray(a.answers) && a.answers.every((x) => typeof x === "string"))) throw new HttpError(400, "answers must be a list of strings");
            await checkApproval(a as Approval, await handle.query(stateQuery));
            await handle.signal(approvalSignal, a as Approval);
            return send(res, 202);
          }
          if (req.method === "POST" && sub === "/cancel") {
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

function parseChecklist(v: unknown): ChecklistAnswer[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HttpError(400, "checklist must be a list of { item, pass, note? }");
  return v.map((x) => {
    if (!x || typeof x.item !== "string" || typeof x.pass !== "boolean" || (x.note !== undefined && typeof x.note !== "string")) {
      throw new HttpError(400, "checklist must be a list of { item, pass, note? }");
    }
    return { item: x.item, pass: x.pass, ...(x.note !== undefined ? { note: x.note } : {}) };
  });
}

/**
 * Refuse an approval the run cannot act on, so the card shows the reason instead of the click
 * being dropped. Only for the stage and attempt the run is at; a stale card passes through and the
 * workflow ignores it, as before.
 */
async function checkApproval(a: Approval, st: RunState): Promise<void> {
  const c = st.contract;
  if (!c || st.status !== "running" || a.stage !== st.stage || (a.attempt !== undefined && a.attempt !== st.attempt)) return;
  if (a.outcome !== undefined && c.outcomes && !c.outcomes.includes(a.outcome)) throw new HttpError(422, `outcome "${a.outcome}" is not one of: ${c.outcomes.join(", ")}`);
  const cand = st.candidate && st.candidate.attempt === st.attempt ? st.candidate : undefined;
  if (a.decision === "answer") {
    if (!cand?.questions.length) throw new HttpError(409, "there are no open questions to answer");
    if (!a.answers || a.answers.length !== cand.questions.length || a.answers.some((x) => !x.trim())) {
      throw new HttpError(400, `give one non-empty answer for each of the ${cand.questions.length} open questions`);
    }
    return;
  }
  if (a.decision !== "approve") return;
  if (c.artifact) {
    if (!cand) throw new HttpError(409, `no "${c.artifact}" artifact has been submitted for this attempt yet`);
    if (cand.questions.length) throw new HttpError(409, `answer the ${cand.questions.length} open question(s) first (decision "answer")`);
  }
  if (c.outcomeRequired && (a.outcome ?? cand?.outcome) === undefined) throw new HttpError(422, `an outcome is required: one of ${(c.outcomes ?? []).join(", ")}`);
}

export interface FactoryOptions {
  registry: Registry;
  /** Absolute path of the app's workflows file (exports `pipelineWorkflow`). */
  workflowsPath: string;
  temporal: { address: string; namespace: string; taskQueue: string };
  host: HostConfig;
  apiToken: string;
  port: number;
  /** Skill loading: `root` is the app root (default: the current directory); see LoadSkillsOptions. */
  skills?: Partial<LoadSkillsOptions>;
  /** Workflow packs (folders with a factory.yaml), e.g. `[rolesPack, "methods/my-flow"]`. Relative paths resolve against the app root. */
  packs?: Array<string | PackSpec>;
}

/** Validate the registry, then run the Temporal worker and the HTTP API in one process. */
export async function startFactory(o: FactoryOptions): Promise<{ server: Server; worker: Worker; stop(): Promise<void> }> {
  const problems = o.registry.validate();
  if (problems.length) throw new Error(`registry is not consistent:\n- ${problems.join("\n- ")}`);
  if (o.host.token.length < 32) throw new Error("FACTORY_CALLBACK_TOKEN must be at least 32 characters");
  if (!o.apiToken) throw new Error("FACTORY_API_TOKEN is empty");
  const root = o.skills?.root ?? process.cwd();
  const loaded = await loadSkills(o.registry, { root, ...o.skills });
  for (const w of loaded.warnings) console.warn(`[factory] ${w}`);
  const packs = await loadPacks(o.packs ?? [], { root, limits: o.skills?.limits });
  const skills = new Map<string, LoadedSkill>(loaded.skills);
  const texts = new Map<string, LoadedText>(loaded.texts);
  const snapshots: PipelineSnapshot[] = [];
  for (const p of packs) {
    for (const w of p.warnings) console.warn(`[factory] ${w}`);
    for (const [k, v] of p.skills) skills.set(k, v);
    for (const [k, v] of p.texts) texts.set(k, v);
    for (const pl of p.pipelines) {
      const inRegistry = (() => { try { o.registry.getPipeline(pl.name); return true; } catch { return false; } })();
      if (inRegistry) throw new PackError(`pipeline "${pl.name}" is defined both in the registry and in pack "${p.name}"`);
      snapshots.push(pl);
    }
  }

  const worker = await Worker.create({
    connection: await NativeConnection.connect({ address: o.temporal.address }),
    namespace: o.temporal.namespace,
    taskQueue: o.temporal.taskQueue,
    workflowsPath: o.workflowsPath,
    activities: makeActivities(o.registry, o.host, { skills, texts }),
  });
  const client = new Client({ connection: await Connection.connect({ address: o.temporal.address }), namespace: o.temporal.namespace });
  const server = createServer(createApi({ client, registry: o.registry, taskQueue: o.temporal.taskQueue, token: o.apiToken, packs: snapshots, texts }));
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
