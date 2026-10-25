import type { HookEventName, HookHandler, HookOptions, PipelineDef, PromptFn, RegisteredHook, StageDef, StageName } from "./types.js";

export interface Registry {
  stage(def: StageDef): void;
  pipeline(def: PipelineDef): void;
  prompt(stage: StageName, fn: PromptFn): void;
  /** Register an event hook. Handlers run in registration order, in the emit activity. */
  on(event: HookEventName, handler: HookHandler): void;
  on(event: HookEventName, options: HookOptions, handler: HookHandler): void;
  /** Hooks that apply to one event at one stage of one pipeline, in registration order. */
  hooksFor(event: HookEventName, where: { stage?: StageName; pipeline: string }): RegisteredHook[];
  getStage(name: StageName): StageDef;
  /** A named version, or the highest registered version when `version` is omitted. */
  getPipeline(name: string, version?: number): PipelineDef;
  getPrompt(stage: StageName): PromptFn;
  /** Every problem with the registered set; empty when it is consistent. Call it at worker start. */
  validate(): string[];
}

/**
 * One registry per app. It must be built by static code (module top level) so the
 * workflow bundle sees the same stages and pipelines on every replay.
 */
export function createRegistry(): Registry {
  const stages = new Map<StageName, StageDef>();
  const pipelines = new Map<string, PipelineDef>();
  const prompts = new Map<StageName, PromptFn>();
  const hooks: RegisteredHook[] = [];
  const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  const key = (name: string, version: number) => `${name}@${version}`;

  return {
    stage(def) {
      if (stages.has(def.name)) throw new Error(`stage "${def.name}" is already registered`);
      stages.set(def.name, def);
    },
    pipeline(def) {
      if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`pipeline "${def.name}": version must be a positive integer`);
      if (def.stages.length === 0) throw new Error(`pipeline "${def.name}@${def.version}" has no stages`);
      const k = key(def.name, def.version);
      if (pipelines.has(k)) throw new Error(`pipeline "${k}" is already registered; add a new version instead of editing one`);
      pipelines.set(k, def);
    },
    prompt(stage, fn) {
      if (prompts.has(stage)) throw new Error(`prompt for "${stage}" is already registered`);
      prompts.set(stage, fn);
    },
    on(event: HookEventName, a: HookOptions | HookHandler, b?: HookHandler) {
      const [options, handler] = typeof a === "function" ? [{}, a] : [a, b];
      if (typeof handler !== "function") throw new Error(`hook for "${event}" needs a handler`);
      hooks.push({ event, options: { ...options, mode: options.mode ?? "best-effort" }, handler });
    },
    hooksFor(event, where) {
      return hooks.filter((h) => {
        if (h.event !== event) return false;
        const stages = list(h.options.stage);
        const pipes = list(h.options.pipeline);
        if (stages && (where.stage === undefined || !stages.includes(where.stage))) return false;
        if (pipes && !pipes.includes(where.pipeline)) return false;
        return true;
      });
    },
    getStage(name) {
      const s = stages.get(name);
      if (!s) throw new Error(`unknown stage "${name}"`);
      return s;
    },
    getPipeline(name, version) {
      if (version !== undefined) {
        const p = pipelines.get(key(name, version));
        if (!p) throw new Error(`unknown pipeline "${key(name, version)}"`);
        return p;
      }
      let latest: PipelineDef | undefined;
      for (const p of pipelines.values()) if (p.name === name && (!latest || p.version > latest.version)) latest = p;
      if (!latest) throw new Error(`unknown pipeline "${name}"`);
      return latest;
    },
    getPrompt(stage) {
      const fn = prompts.get(stage);
      if (!fn) throw new Error(`no prompt registered for stage "${stage}"`);
      return fn;
    },
    validate() {
      const problems: string[] = [];
      for (const p of pipelines.values()) {
        for (const s of p.stages) {
          if (!stages.has(s)) problems.push(`pipeline "${key(p.name, p.version)}" uses unregistered stage "${s}"`);
          else if (!prompts.has(s)) problems.push(`stage "${s}" (pipeline "${key(p.name, p.version)}") has no prompt`);
        }
      }
      const pipelineNames = new Set([...pipelines.values()].map((p) => p.name));
      for (const h of hooks) {
        for (const s of list(h.options.stage) ?? []) if (!stages.has(s)) problems.push(`hook on "${h.event}" filters on unregistered stage "${s}"`);
        for (const n of list(h.options.pipeline) ?? []) if (!pipelineNames.has(n)) problems.push(`hook on "${h.event}" filters on unregistered pipeline "${n}"`);
      }
      return problems;
    },
  };
}
