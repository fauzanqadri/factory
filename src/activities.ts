import { ApplicationFailure } from "@temporalio/common";
import { dispatchEvent } from "./hooks.js";
import type { Registry } from "./registry.js";
import { renderSkills } from "./skills.js";
import type { FinishReason, HookEvent, LoadedSkill, RunContext, StageName } from "./types.js";

export interface HostConfig {
  /** Chat host base URL, e.g. https://host.example (callbacks go to /workflow/v1/...). */
  url: string;
  /** Bearer the host expects (FACTORY_CALLBACK_TOKEN), at least 32 characters. */
  token: string;
  timeoutMs?: number;
}

export interface FactoryActivities {
  /** Build the stage prompt and ask the host to run it as a turn. Idempotent on requestId at the host. */
  runStage(input: { ctx: RunContext; stage: StageName; attempt: number; note?: string; requestId: string }): Promise<void>;
  /** Run the app's hooks for one event (required first, then best-effort). */
  emit(event: HookEvent): Promise<void>;
  remind(input: { runId: string; stage: StageName; waitingSince?: string }): Promise<void>;
  finish(input: { runId: string; reason: FinishReason }): Promise<void>;
}

/**
 * The activities a worker registers. They run outside the workflow sandbox, so they
 * may do I/O and may change between deploys (prompts, hook handlers).
 */
export function makeActivities(
  registry: Registry,
  host: HostConfig,
  deps: { fetch?: typeof fetch; log?: (msg: string) => void; skills?: Map<string, LoadedSkill> } = {},
): FactoryActivities {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => console.warn(m));

  const post = async (path: string, body: unknown) => {
    const res = await doFetch(new URL(path, host.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(host.timeoutMs ?? 15_000),
    });
    // Any non-2xx throws, so Temporal retries the activity with backoff.
    if (!res.ok) throw new Error(`chat host ${path} returned ${res.status}`);
  };

  return {
    async runStage({ ctx, stage, attempt, note, requestId }) {
      const def = registry.getStage(stage);
      let prompt = registry.getPrompt(stage)({ ...ctx, stage, attempt, note });
      if (def.skills?.length) {
        const loaded = def.skills.map((name) => {
          const s = deps.skills?.get(name);
          // A setup mistake (skills not loaded), not a transient failure: don't let Temporal retry it.
          if (!s) throw ApplicationFailure.nonRetryable(`stage "${stage}" uses skill "${name}" but it was not loaded (use startFactory, or pass skills to makeActivities)`);
          return s;
        });
        prompt = `${renderSkills(loaded)}\n\n${prompt}`;
      }
      await post("/workflow/v1/turns", { runId: ctx.runId, stage, attempt, prompt, requestId, ...(def.model ? { model: def.model } : {}) });
    },
    async emit(event) {
      await dispatchEvent(registry, event, log);
    },
    async remind({ runId, stage, waitingSince }) {
      await post(`/workflow/v1/runs/${encodeURIComponent(runId)}/remind`, { stage, waitingSince });
    },
    async finish({ runId, reason }) {
      await post(`/workflow/v1/runs/${encodeURIComponent(runId)}/finish`, { reason });
    },
  };
}
