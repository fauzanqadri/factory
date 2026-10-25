import type { PipelineDef, PromptFn, StageDef, StageName } from "./types.js";

export interface Registry {
  stage(def: StageDef): void;
  pipeline(def: PipelineDef): void;
  prompt(stage: StageName, fn: PromptFn): void;
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
      return problems;
    },
  };
}
