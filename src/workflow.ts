/**
 * The pipeline workflow. This module is loaded into Temporal's workflow sandbox, so it
 * imports only the workflow SDK, the registry and types: no I/O, no Node APIs.
 * Date.now() is deterministic here (Temporal replaces it with workflow time).
 */
import { msToNumber } from "@temporalio/common";
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { FactoryActivities } from "./activities.js";
import type { Registry } from "./registry.js";
import type { Approval, FinishReason, HookEventName, PipelineDef, RunContext, RunState, StageDef, StageName, StartRun } from "./types.js";

export const approvalSignal = defineSignal<[Approval]>("approval");
export const cancelSignal = defineSignal<[{ by: string }]>("cancel");
export const stateQuery = defineQuery<RunState>("state");

/** What a run is started with: StartRun with the pipeline version already pinned. */
export type PipelineInput = StartRun & { pipelineVersion: number };

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
    const host = proxyActivities<Pick<FactoryActivities, "runStage" | "remind" | "finish">>(shortCall);
    const hooks = proxyActivities<Pick<FactoryActivities, "emit">>({ ...shortCall, startToCloseTimeout: "2m" });

    const pipeline = registry.getPipeline(input.pipeline, input.pipelineVersion);
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
    const state: RunState = { stage: pipeline.stages[0], attempt: 0, status: "running", history: [] };
    const seenGates = new Set<string>();
    const inbox: Approval[] = [];
    let cancelled = false;

    setHandler(stateQuery, () => state);
    setHandler(cancelSignal, () => { cancelled = true; });
    setHandler(approvalSignal, (a) => {
      if (seenGates.has(a.gateId)) return; // a repeated click or signal
      seenGates.add(a.gateId);
      inbox.push(a);
    });

    const iso = () => new Date(Date.now()).toISOString();
    const emit = (name: HookEventName, extra: { stage?: StageName; attempt?: number; approval?: Approval; waitingSince?: string; finish?: FinishReason } = {}) =>
      hooks.emit({ ...ctx, ...extra, name, at: iso(), eventId: `${ctx.runId}:${name}:${extra.stage ?? "-"}:${extra.attempt ?? 0}` });

    const finish = async (reason: FinishReason): Promise<PipelineResult> => {
      state.status = "finished";
      state.finish = reason;
      state.waitingSince = undefined;
      await emit("run.finished", { finish: reason });
      await host.finish({ runId: ctx.runId, reason });
      return { finish: reason, state };
    };

    /** Run one stage until it is approved, or the run is cancelled or gives up. */
    const runStage = async (def: StageDef, p: PipelineDef): Promise<{ kind: "approved"; approval: Approval } | { kind: "cancelled" | "timed-out" }> => {
      const remindMs = msToNumber(def.remindAfter ?? p.defaults.remindAfter);
      const timeoutMs = msToNumber(def.gateTimeout ?? p.defaults.gateTimeout);
      let note: string | undefined;
      for (let attempt = 1; ; attempt++) {
        state.stage = def.name;
        state.attempt = attempt;
        state.waitingSince = undefined;
        await emit("stage.started", { stage: def.name, attempt });
        await host.runStage({ ctx, stage: def.name, attempt, note, requestId: `${ctx.runId}:${def.name}:${attempt}` });

        const waitStart = Date.now();
        state.waitingSince = iso();
        let approval: Approval | undefined;
        for (;;) {
          const left = timeoutMs - (Date.now() - waitStart);
          if (left <= 0) return { kind: "timed-out" };
          const forThis = (a: Approval) => a.stage === def.name && (a.attempt === undefined || a.attempt === attempt);
          const arrived = await condition(() => cancelled || inbox.some(forThis), Math.min(remindMs, left));
          if (cancelled) return { kind: "cancelled" };
          if (arrived) {
            approval = inbox.find(forThis)!;
            // Everything else queued for this stage is a stale or duplicate card: drop it.
            inbox.splice(0, inbox.length, ...inbox.filter((a) => a.stage !== def.name));
            break;
          }
          if (Date.now() - waitStart >= timeoutMs) return { kind: "timed-out" };
          await emit("gate.reminded", { stage: def.name, attempt, waitingSince: state.waitingSince });
          await host.remind({ runId: ctx.runId, stage: def.name, waitingSince: state.waitingSince });
        }

        state.history.push({ stage: def.name, attempt, decision: approval.decision, by: approval.by, at: iso(), note: approval.note, outcome: approval.outcome });
        if (approval.decision === "approve") {
          await emit("stage.approved", { stage: def.name, attempt, approval });
          return { kind: "approved", approval };
        }
        await emit("stage.rejected", { stage: def.name, attempt, approval });
        note = approval.note;
      }
    };

    await emit("run.started");
    let current: StageName = pipeline.stages[0];
    for (;;) {
      if (!pipeline.stages.includes(current)) return finish("not-in-pipeline");
      const def = registry.getStage(current);
      let approval: Approval;
      if (def.skip?.(ctx)) {
        approval = { gateId: `skip:${current}`, stage: current, decision: "approve", by: "factory" };
        state.history.push({ stage: current, attempt: 0, decision: "skip", by: "factory", at: iso() });
        await emit("stage.skipped", { stage: current });
      } else {
        const result = await runStage(def, pipeline);
        if (result.kind !== "approved") return finish(result.kind);
        approval = result.approval;
      }
      const next = def.next(approval, ctx);
      if (typeof next !== "string") return finish(next.finish);
      current = next;
    }
  };
}
