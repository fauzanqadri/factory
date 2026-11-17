import { ApplicationFailure } from "@temporalio/common";
import { contractOf, isMethodStage, isSafeRepoPath } from "./artifacts.js";
import { assemblePrompt, fillInstructions, sha256Hex } from "./assemble.js";
import { dispatchEvent } from "./hooks.js";
import type { Registry } from "./registry.js";
import type {
  ArtifactVersion, Clarification, Feedback, FinishReason, HookEvent, LoadedSkill, LoadedText, RunContext, StageName,
  StageSpec, TurnFingerprint,
} from "./types.js";

export interface HostConfig {
  /** Chat host base URL, e.g. https://host.example (callbacks go to /workflow/v1/...). */
  url: string;
  /** Bearer the host expects (FACTORY_CALLBACK_TOKEN), at least 32 characters. */
  token: string;
  timeoutMs?: number;
}

/** What the workflow sends to start one stage turn. */
export interface RunStageInput {
  ctx: RunContext;
  stage: StageName;
  attempt: number;
  /** The last rejection note (what an app's prompt function has always received). */
  note?: string;
  requestId: string;
  /** A pack stage, from the run's snapshot. Absent for a code stage, which is read from the registry. */
  spec?: StageSpec;
  /** Project rules: skills applied to every stage of the pipeline. */
  rules?: string[];
  /** Approved artifacts the stage reads. */
  inputs?: ArtifactVersion[];
  feedback?: Feedback[];
  clarifications?: Clarification[];
  /** File hashes from the run's snapshot, and what to do when one changed. */
  pins?: Record<string, string>;
  pin?: "record" | "strict";
}

export interface FactoryActivities {
  /** Build the stage prompt and ask the host to run it as a turn. Idempotent on requestId at the host. Returns what produced the prompt. */
  runStage(input: RunStageInput): Promise<TurnFingerprint>;
  /** Run the app's hooks for one event (required first, then best-effort). */
  emit(event: HookEvent): Promise<void>;
  remind(input: { runId: string; stage: StageName; waitingSince?: string }): Promise<void>;
  finish(input: { runId: string; reason: FinishReason }): Promise<void>;
  /** Ask the host to commit an approved artifact to the run's repo. Idempotent on requestId at the host. */
  commit(input: { runId: string; requestId: string; path: string; content: string; message: string }): Promise<{ sha?: string; skipped?: string }>;
}

export interface ActivityDeps {
  fetch?: typeof fetch;
  log?: (msg: string) => void;
  /** Loaded skills: registry skills by name, pack skills by `<pack>/<name>`. */
  skills?: Map<string, LoadedSkill>;
  /** Loaded personas, templates and pack instructions, keyed `<kind>:<name>`. */
  texts?: Map<string, LoadedText>;
}

/**
 * The activities a worker registers. They run outside the workflow sandbox, so they
 * may do I/O and may change between deploys (prompts, hook handlers).
 */
export function makeActivities(registry: Registry, host: HostConfig, deps: ActivityDeps = {}): FactoryActivities {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => console.warn(m));

  const request = async (path: string, body: unknown) => {
    const res = await doFetch(new URL(path, host.url), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(host.timeoutMs ?? 15_000),
    });
    // Any non-2xx throws, so Temporal retries the activity with backoff.
    if (!res.ok) throw new Error(`chat host ${path} returned ${res.status}`);
    return res;
  };
  const post = async (path: string, body: unknown) => { await request(path, body); };
  // A setup mistake (something not loaded), not a transient failure: don't let Temporal retry it.
  const setup = (msg: string) => ApplicationFailure.nonRetryable(msg);

  return {
    async runStage({ ctx, stage, attempt, note, requestId, spec: packSpec, rules = [], inputs = [], feedback = [], clarifications = [], pins, pin }) {
      const spec: StageSpec = packSpec ?? registry.getStage(stage);
      const method = isMethodStage(spec);
      const skill = (name: string) => {
        const s = deps.skills?.get(name);
        if (!s) throw setup(`stage "${stage}" uses skill "${name}" but it was not loaded (use startFactory, or pass skills to makeActivities)`);
        return s;
      };
      const text = (kind: LoadedText["kind"], name: string) => {
        const t = deps.texts?.get(`${kind}:${name}`);
        if (!t) throw setup(`stage "${stage}" uses ${kind} "${name}" but it was not loaded (use startFactory, or pass texts to makeActivities)`);
        return t;
      };

      const ruleSkills = rules.map(skill);
      const stageSkills = (spec.skills ?? []).map(skill);
      const persona = spec.persona ? text("persona", spec.persona) : undefined;
      const template = spec.produces ? text("template", spec.produces.template) : undefined;
      let instructions: string;
      let instructionsText: LoadedText | undefined;
      if (spec.instructions) {
        instructionsText = text("instructions", spec.instructions);
        instructions = fillInstructions(instructionsText.content, { ...ctx, stage, attempt });
      } else {
        const artifacts = Object.fromEntries(inputs.map((v) => [v.artifact, v]));
        instructions = registry.getPrompt(stage)({ ...ctx, stage, attempt, note, artifacts, feedback, clarifications });
      }

      const contract = contractOf(spec, !packSpec);
      const prompt = assemblePrompt({
        ctx, stage, attempt, rules: ruleSkills, persona, skills: stageSkills, instructions, inputs, clarifications, feedback,
        output: spec.produces && template ? {
          artifact: spec.produces.artifact, template: template.content, checklist: spec.checklist,
          outcomes: contract.outcomes, outcomeRequired: contract.outcomeRequired, clarifyMax: contract.clarifyMax,
        } : undefined,
      }, method);
      const promptHash = await sha256Hex(prompt);

      const skillHashes: Record<string, string> = {};
      rules.forEach((n, i) => { skillHashes[n] = ruleSkills[i]!.hash; });
      (spec.skills ?? []).forEach((n, i) => { skillHashes[n] = stageSkills[i]!.hash; });
      const fingerprint: TurnFingerprint = {
        promptHash,
        ...(persona ? { persona: persona.hash } : {}),
        ...(template ? { template: template.hash } : {}),
        ...(instructionsText ? { instructions: instructionsText.hash } : {}),
        skills: skillHashes,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
      };
      if (pins) {
        const now: Record<string, string | undefined> = {
          ...(spec.persona ? { [`persona:${spec.persona}`]: persona?.hash } : {}),
          ...(spec.instructions ? { [`instructions:${spec.instructions}`]: instructionsText?.hash } : {}),
          ...(spec.produces ? { [`template:${spec.produces.template}`]: template?.hash } : {}),
          ...Object.fromEntries(Object.entries(skillHashes).map(([k, h]) => [`skill:${k}`, h])),
        };
        const drift = Object.entries(now).filter(([k, h]) => pins[k] !== undefined && pins[k] !== h).map(([k]) => k);
        if (drift.length && pin === "strict") throw setup(`stage "${stage}": ${drift.join(", ")} changed since the run started (pin: strict)`);
        if (drift.length) fingerprint.drift = drift;
      }

      const body: Record<string, unknown> = { runId: ctx.runId, stage, attempt, prompt, requestId, ...(spec.model ? { model: spec.model } : {}) };
      if (method) {
        // The method layer's turn contract: a fresh context and a submit tool for the artifact.
        Object.assign(body, {
          context: "fresh",
          promptHash,
          ...(spec.effort ? { effort: spec.effort } : {}),
          ...(spec.produces ? {
            artifact: {
              name: spec.produces.artifact,
              ...(spec.checklist?.length ? { checklist: spec.checklist } : {}),
              ...(contract.outcomes ? { outcomes: contract.outcomes, outcomeRequired: contract.outcomeRequired } : {}),
            },
          } : {}),
        });
      } else if (spec.effort) {
        body.effort = spec.effort;
      }
      await post("/workflow/v1/turns", body);
      return fingerprint;
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
    async commit({ runId, requestId, path, content, message }) {
      // The run id is part of most paths; refuse anything that would leave the repo.
      if (!isSafeRepoPath(path)) throw setup(`commit path "${path}" is not inside the repo`);
      const res = await request(`/workflow/v1/runs/${encodeURIComponent(runId)}/commit`, { requestId, path, content, message });
      const body = (await res.json().catch(() => ({}))) as { sha?: unknown; skipped?: unknown };
      return {
        ...(typeof body.sha === "string" ? { sha: body.sha } : {}),
        ...(typeof body.skipped === "string" ? { skipped: body.skipped } : {}),
      };
    },
  };
}
