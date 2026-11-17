/**
 * The pipeline workflow. This module is loaded into Temporal's workflow sandbox, so it
 * imports only the workflow SDK, the registry, pure helpers and types: no I/O, no Node APIs.
 * Date.now() is deterministic here (Temporal replaces it with workflow time).
 *
 * A run follows either a code pipeline (registry: `next`/`skip` functions) or a pack pipeline
 * (a PipelineSnapshot in the start input: routing tables as data). A stage without `produces`
 * issues exactly the Temporal commands it did before artifacts existed, so runs started on
 * earlier code replay unchanged.
 */
import { msToNumber } from "@temporalio/common";
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { FactoryActivities } from "./activities.js";
import { contractOf, fillPath, latestArtifacts, routeNext } from "./artifacts.js";
import type { Registry } from "./registry.js";
import type {
  Approval, ArtifactCandidate, ArtifactVersion, Feedback, FinishReason, HookEventName, Next, PipelineSnapshot,
  RunContext, RunState, StageDef, StageName, StageSpec, StartRun,
} from "./types.js";

export const approvalSignal = defineSignal<[Approval]>("approval");
export const cancelSignal = defineSignal<[{ by: string }]>("cancel");
/** A checked artifact submission (the API runs the checks before signalling). */
export const artifactSignal = defineSignal<[ArtifactCandidate]>("artifact");
export const stateQuery = defineQuery<RunState>("state");

/** What a run is started with: StartRun with the pipeline version pinned, and the pack snapshot for a pack pipeline. */
export type PipelineInput = StartRun & { pipelineVersion: number; snapshot?: PipelineSnapshot };

export interface PipelineResult {
  finish: FinishReason;
  state: RunState;
}

/** Workflow id for a chat thread: at most one running run per thread. */
export const runIdFor = (channelId: string, threadTs: string) => `run-${channelId}-${threadTs}`;

/**
 * Builds the workflow function for an app's registry. Export the result from the app's
 * workflows file; the export name is the workflow type (use `pipelineWorkflow`).
 */
export function makePipelineWorkflow(registry: Registry) {
  return async function pipelineWorkflow(input: PipelineInput): Promise<PipelineResult> {
    const shortCall = { startToCloseTimeout: "30s", retry: { initialInterval: "2s", maximumInterval: "1m" } } as const;
    const host = proxyActivities<Pick<FactoryActivities, "runStage" | "remind" | "finish" | "commit">>(shortCall);
    const hooks = proxyActivities<Pick<FactoryActivities, "emit">>({ ...shortCall, startToCloseTimeout: "2m" });

    const snapshot = input.snapshot;
    const pipeline = snapshot
      ? { name: snapshot.name, version: snapshot.version, stages: snapshot.stages.map((s) => s.name), defaults: snapshot.defaults, skills: snapshot.rules }
      : registry.getPipeline(input.pipeline, input.pipelineVersion);
    const rules = pipeline.skills ?? [];
    const specOf = (name: StageName): { spec: StageSpec; def?: StageDef } => {
      if (!snapshot) { const def = registry.getStage(name); return { spec: def, def }; }
      const spec = snapshot.stages.find((s) => s.name === name);
      if (!spec) throw new Error(`stage "${name}" is not in the run's snapshot`);
      return { spec };
    };

    const ctx: RunContext = {
      runId: workflowInfo().workflowId,
      pipeline: pipeline.name,
      pipelineVersion: pipeline.version,
      channelId: input.channelId,
      threadTs: input.threadTs,
      starter: input.starter,
      ticketRef: input.ticketRef,
      request: input.request,
    };
    const state: RunState = {
      stage: pipeline.stages[0]!, attempt: 0, status: "running", history: [],
      pipeline: pipeline.name, pipelineVersion: pipeline.version, definitionHash: snapshot?.hash,
      artifacts: [], clarifications: [], turns: [],
    };
    const artifacts = state.artifacts!;
    const clarifications = state.clarifications!;
    const attempts = new Map<StageName, number>();
    const seenGates = new Set<string>();
    const inbox: Approval[] = [];
    const feedbackLog: Feedback[] = [];
    let cancelled = false;

    setHandler(stateQuery, () => state);
    setHandler(cancelSignal, () => { cancelled = true; });
    setHandler(approvalSignal, (a) => {
      if (seenGates.has(a.gateId)) return; // a repeated click or signal
      seenGates.add(a.gateId);
      inbox.push(a);
    });
    setHandler(artifactSignal, (c) => {
      // Only for the turn that is current; a late submission from an earlier attempt is stale.
      if (state.status !== "running" || c.stage !== state.stage || c.attempt !== state.attempt) return;
      state.candidate = c;
    });

    const currentCandidate = (): ArtifactCandidate | undefined => state.candidate;
    const iso = () => new Date(Date.now()).toISOString();
    type EmitExtra = { stage?: StageName; attempt?: number; approval?: Approval; waitingSince?: string; finish?: FinishReason; artifact?: ArtifactVersion };
    const emit = (name: HookEventName, extra: EmitExtra = {}) =>
      hooks.emit({ ...ctx, ...extra, name, at: iso(), eventId: `${ctx.runId}:${name}:${extra.stage ?? "-"}:${extra.attempt ?? 0}` });

    const finish = async (reason: FinishReason): Promise<PipelineResult> => {
      state.status = "finished";
      state.finish = reason;
      state.waitingSince = undefined;
      state.contract = undefined;
      state.candidate = undefined;
      await emit("run.finished", { finish: reason });
      await host.finish({ runId: ctx.runId, reason });
      return { finish: reason, state };
    };

    /** Run one stage until it is approved, or the run is cancelled or gives up. */
    const runStage = async (spec: StageSpec): Promise<{ kind: "approved"; approval: Approval } | { kind: "cancelled" | "timed-out" }> => {
      const remindMs = msToNumber(spec.remindAfter ?? pipeline.defaults.remindAfter);
      const timeoutMs = msToNumber(spec.gateTimeout ?? pipeline.defaults.gateTimeout);
      const contract = contractOf(spec, !snapshot);
      let note: string | undefined;
      for (;;) {
        // Counted across the whole run, so a loop back to this stage is a new attempt, not attempt 1
        // again: requestId and eventId stay unique, and a card from an earlier visit goes stale.
        const attempt = (attempts.get(spec.name) ?? 0) + 1;
        attempts.set(spec.name, attempt);
        state.stage = spec.name;
        state.attempt = attempt;
        state.waitingSince = undefined;
        state.candidate = undefined;
        state.contract = contract;
        await emit("stage.started", { stage: spec.name, attempt });
        const latest = latestArtifacts(artifacts);
        const fingerprint = await host.runStage({
          ctx, stage: spec.name, attempt, note, requestId: `${ctx.runId}:${spec.name}:${attempt}`,
          ...(snapshot ? { spec, pins: snapshot.pins, pin: snapshot.pin } : {}),
          ...(rules.length ? { rules } : {}),
          inputs: (spec.reads ?? []).flatMap((r) => (latest[r] ? [latest[r]!] : [])),
          feedback: feedbackLog.filter((f) => f.stage === spec.name),
          clarifications: [...clarifications],
        });
        state.turns!.push({ stage: spec.name, attempt, ...(fingerprint ?? {}) });

        const waitStart = Date.now();
        state.waitingSince = iso();
        const forThis = (a: Approval) => a.stage === spec.name && (a.attempt === undefined || a.attempt === attempt);
        // What the gate can act on now. Without `produces` that is every approve or reject, as before.
        const ready = (a: Approval) => {
          const c = state.candidate;
          if (a.decision === "answer") return !!c && c.questions.length > 0;
          if (a.decision === "approve" && spec.produces) return !!c && c.questions.length === 0;
          return true;
        };
        let approval: Approval | undefined;
        for (;;) {
          const left = timeoutMs - (Date.now() - waitStart);
          if (left <= 0) return { kind: "timed-out" };
          const arrived = await condition(() => cancelled || inbox.some(forThis), Math.min(remindMs, left));
          if (cancelled) return { kind: "cancelled" };
          if (arrived) {
            const pick = inbox.find((a) => forThis(a) && ready(a));
            if (!pick) {
              // e.g. an approve before any artifact was submitted: drop it and keep waiting.
              inbox.splice(0, inbox.length, ...inbox.filter((a) => !forThis(a)));
              continue;
            }
            approval = pick;
            // Everything else queued for this stage is a stale or duplicate card: drop it.
            inbox.splice(0, inbox.length, ...inbox.filter((a) => a.stage !== spec.name));
            break;
          }
          if (Date.now() - waitStart >= timeoutMs) return { kind: "timed-out" };
          await emit("gate.reminded", { stage: spec.name, attempt, waitingSince: state.waitingSince });
          await host.remind({ runId: ctx.runId, stage: spec.name, waitingSince: state.waitingSince });
        }

        // Read through a function: the artifact signal handler sets it, which TypeScript cannot see.
        const candidate = currentCandidate();
        if (approval.decision === "approve") {
          const effective: Approval = spec.produces ? { ...approval, outcome: approval.outcome ?? candidate?.outcome } : approval;
          state.history.push({ stage: spec.name, attempt, decision: "approve", by: approval.by, at: iso(), note: approval.note, outcome: effective.outcome });
          if (!spec.produces || !candidate) {
            await emit("stage.approved", { stage: spec.name, attempt, approval });
            return { kind: "approved", approval };
          }
          const name = candidate.artifact;
          const seq = artifacts.filter((v) => v.artifact === name).length + 1;
          const version: ArtifactVersion = {
            artifact: name, seq, stage: spec.name, attempt, content: candidate.content, hash: candidate.hash,
            outcome: effective.outcome, approvedBy: approval.by, at: iso(),
          };
          artifacts.push(version);
          state.candidate = undefined;
          if (spec.produces.commit) {
            const path = fillPath(spec.produces.commit, { runId: ctx.runId, artifact: name, stage: spec.name, seq });
            const res = await host.commit({
              runId: ctx.runId, requestId: `${ctx.runId}:commit:${name}:${seq}`, path, content: version.content,
              message: `factory: ${name} v${seq} (stage ${spec.name}, approved by ${approval.by})`,
            });
            version.commit = { path, ...(res ?? {}) };
          }
          await emit("stage.approved", { stage: spec.name, attempt, approval: effective, artifact: version });
          return { kind: "approved", approval: effective };
        }
        if (approval.decision === "answer") {
          const answers = approval.answers ?? [];
          candidate!.questions.forEach((question, i) => clarifications.push({ stage: spec.name, attempt, question, answer: answers[i] ?? "", by: approval!.by }));
          state.history.push({ stage: spec.name, attempt, decision: "answer", by: approval.by, at: iso() });
          await emit("stage.clarified", { stage: spec.name, attempt, approval });
          note = undefined;
          continue;
        }
        state.history.push({ stage: spec.name, attempt, decision: "reject", by: approval.by, at: iso(), note: approval.note, outcome: approval.outcome });
        feedbackLog.push({ kind: "rejected", stage: spec.name, attempt, by: approval.by, note: approval.note });
        await emit("stage.rejected", { stage: spec.name, attempt, approval });
        note = approval.note;
      }
    };

    await emit("run.started");
    let current: StageName = pipeline.stages[0]!;
    for (;;) {
      if (!pipeline.stages.includes(current)) return finish("not-in-pipeline");
      const { spec, def } = specOf(current);
      let approval: Approval;
      if (def?.skip?.(ctx)) {
        approval = { gateId: `skip:${current}`, stage: current, decision: "approve", by: "factory" };
        state.history.push({ stage: current, attempt: 0, decision: "skip", by: "factory", at: iso() });
        await emit("stage.skipped", { stage: current });
      } else {
        const result = await runStage(spec);
        if (result.kind !== "approved") return finish(result.kind);
        approval = result.approval;
      }
      const next: Next | undefined = def ? def.next(approval, ctx, latestArtifacts(artifacts)) : routeNext(spec.route, approval.outcome);
      if (next === undefined) return finish("no-route");
      if (typeof next !== "string") return finish(next.finish);
      if (attempts.has(next)) {
        // Going back to a stage already visited: its next prompt says why.
        feedbackLog.push({ kind: "sent-back", stage: next, attempt: attempts.get(current) ?? 0, by: approval.by, note: approval.note, outcome: approval.outcome, from: current });
      }
      current = next;
    }
  };
}
