import { isSafeRepoPath } from "./artifacts.js";
import type { HookEventName, HookHandler, HookOptions, PipelineDef, PromptFn, RegisteredHook, SkillDecl, SkillOptions, SkillSource, StageDef, StageName, TextDecl } from "./types.js";

// This module is bundled into Temporal's workflow sandbox: no node:* imports here.
// Skill files are read by ./skills.js, which only the worker side imports.
export interface Registry {
  stage(def: StageDef): void;
  /** Declare a skill folder. Files are read (and checked) at worker start by `loadSkills`. */
  skill(name: string, source: SkillSource, options?: SkillOptions): void;
  /** Declare a persona: one Markdown file (a Hermes SOUL.md, a BMAD agent file, plain text). Read at worker start. */
  persona(name: string, source: SkillSource): void;
  /** Declare an artifact template: one Markdown file whose `*(mandatory)*` headings an artifact must fill. */
  template(name: string, source: SkillSource): void;
  getSkillDecls(): SkillDecl[];
  getTextDecls(): TextDecl[];
  getStages(): StageDef[];
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
  const skills = new Map<string, SkillDecl>();
  const texts = new Map<string, TextDecl>();
  const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);
  const key = (name: string, version: number) => `${name}@${version}`;
  const checkName = (kind: string, name: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`${kind} name "${name}" must be letters, digits, ".", "_" or "-"`);
  };
  const checkSource = (label: string, source: SkillSource, pathRequired: boolean) => {
    const hasPkg = "package" in source && typeof source.package === "string" && source.package !== "";
    const hasPath = "path" in source && typeof source.path === "string" && source.path !== "";
    if (!hasPkg && !hasPath) throw new Error(`${label}: give a path, or a package (with an optional path inside it)`);
    if ("package" in source && !hasPkg) throw new Error(`${label}: package must be a non-empty string`);
    if (pathRequired && !hasPath) throw new Error(`${label}: give the path of the file (inside the package, for a package source)`);
  };
  const addText = (kind: TextDecl["kind"], name: string, source: SkillSource) => {
    checkName(kind, name);
    const k = `${kind}:${name}`;
    if (texts.has(k)) throw new Error(`${kind} "${name}" is already registered`);
    checkSource(`${kind} "${name}"`, source, true);
    texts.set(k, { kind, name, source });
  };

  return {
    stage(def) {
      if (stages.has(def.name)) throw new Error(`stage "${def.name}" is already registered`);
      if (def.clarify && (!Number.isInteger(def.clarify.max) || def.clarify.max < 0)) throw new Error(`stage "${def.name}": clarify.max must be a whole number, 0 or more`);
      if (def.produces?.commit !== undefined && !isSafeRepoPath(def.produces.commit)) throw new Error(`stage "${def.name}": produces.commit must be a path inside the repo (relative, no "..")`);
      stages.set(def.name, def);
    },
    skill(name, source, options = {}) {
      checkName("skill", name);
      if (skills.has(name)) throw new Error(`skill "${name}" is already registered`);
      checkSource(`skill "${name}"`, source, false);
      skills.set(name, { name, source, options });
    },
    persona(name, source) {
      addText("persona", name, source);
    },
    template(name, source) {
      addText("template", name, source);
    },
    getSkillDecls() {
      return [...skills.values()];
    },
    getTextDecls() {
      return [...texts.values()];
    },
    getStages() {
      return [...stages.values()];
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
      for (const s of stages.values()) {
        for (const k of s.skills ?? []) if (!skills.has(k)) problems.push(`stage "${s.name}" uses unregistered skill "${k}"`);
        if (s.persona && !texts.has(`persona:${s.persona}`)) problems.push(`stage "${s.name}" uses unregistered persona "${s.persona}"`);
        if (s.produces && !texts.has(`template:${s.produces.template}`)) problems.push(`stage "${s.name}" uses unregistered template "${s.produces.template}"`);
        if (s.outcomes && s.outcomes.length === 0) problems.push(`stage "${s.name}" declares an empty outcomes list (omit it to allow any outcome)`);
        if (s.checklist && !s.produces) problems.push(`stage "${s.name}" has a checklist but produces no artifact to answer it with`);
      }
      for (const p of pipelines.values()) {
        const at = `pipeline "${key(p.name, p.version)}"`;
        for (const k of p.skills ?? []) if (!skills.has(k)) problems.push(`${at} uses unregistered skill "${k}" as a project rule`);
        const produced = new Set(p.stages.flatMap((n) => { const st = stages.get(n); return st?.produces ? [st.produces.artifact] : []; }));
        for (const s of p.stages) {
          const st = stages.get(s);
          if (!st) problems.push(`${at} uses unregistered stage "${s}"`);
          else {
            if (!prompts.has(s)) problems.push(`stage "${s}" (${at}) has no prompt`);
            for (const r of st.reads ?? []) if (!produced.has(r)) problems.push(`stage "${s}" (${at}) reads "${r}", which no stage of the pipeline produces`);
          }
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
