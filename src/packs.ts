/**
 * Workflow packs: a method (stages, personas, templates, instructions, skills, routing) as a
 * folder, no TypeScript needed. Node-only: re-exported from ./server, never from the root.
 *
 *   my-method/
 *     factory.yaml          pipelines, stages, routing tables, project rules
 *     personas/<name>.md    who the agent is in a stage (a Hermes SOUL.md works as is)
 *     templates/<name>.md   artifact templates; `*(mandatory)*` headings must be filled
 *     stages/<name>.md      step-by-step instructions for each stage
 *     skills/<name>/SKILL.md
 *
 * A pack pipeline becomes a PipelineSnapshot (plain data) that `POST /runs` copies into the run,
 * so the workflow routes from the definition the run started with, whatever happens to the files.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isSafeRepoPath } from "./artifacts.js";
import { DEFAULT_SKILL_LIMITS, loadOne, readSafe, SkillError, type SkillLimits } from "./skills.js";
import type { Duration, LoadedSkill, LoadedText, Next, PipelineSnapshot, RunsIn, StageSpec } from "./types.js";

/** A pack definition error. Always fails worker start. */
export class PackError extends Error {}

/** A pack folder, optionally with overlay folders whose files and `factory.yaml` entries win over it. */
export interface PackSpec {
  dir: string;
  overlays?: string[];
}

export interface LoadPackOptions {
  /** Relative pack and overlay paths resolve against it (default: the current directory). */
  root?: string;
  limits?: Partial<SkillLimits>;
}

export interface LoadedPack {
  name: string;
  description?: string;
  pipelines: PipelineSnapshot[];
  /** Keyed `persona:<pack>/<name>`, `template:<pack>/<name>`, `instructions:<pack>/<name>`. */
  texts: Map<string, LoadedText>;
  /** Keyed `<pack>/<name>`. */
  skills: Map<string, LoadedSkill>;
  warnings: string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULTS = { remindAfter: "24h", gateTimeout: "7d" };
const YAML_EXT = new Set([".yaml", ".yml"]);
const MD_EXT = new Set([".md", ".txt"]);

type Raw = Record<string, any>;

/** JSON with sorted keys and no undefined, so the same definition always hashes the same. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Raw).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isFinish = (v: unknown): v is { finish: string } => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && isStr((v as Raw).finish);

/** `next:` in factory.yaml: a stage name, `{ finish: reason }`, or a table from outcome to either ("*" = any). */
function parseRoute(v: unknown, at: string, problems: string[]): Record<string, Next> {
  if (isStr(v)) return { "*": v };
  if (isFinish(v)) return { "*": { finish: v.finish } };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, Next> = {};
    for (const [k, x] of Object.entries(v as Raw)) {
      if (isStr(x)) out[k] = x;
      else if (isFinish(x)) out[k] = { finish: x.finish };
      else problems.push(`${at}: next.${k} must be a stage name or { finish: <reason> }`);
    }
    if (Object.keys(out).length === 0) problems.push(`${at}: next is empty`);
    return out;
  }
  problems.push(`${at}: next is required (a stage name, { finish: <reason> }, or a table by outcome)`);
  return {};
}

/** Overlay merge: per-stage fields and per-pipeline entries from later layers win. */
function merge(base: Raw, over: Raw): Raw {
  const out: Raw = { ...base };
  for (const k of ["description", "pin", "rules"]) if (over[k] !== undefined) out[k] = over[k];
  if (over.stages) {
    out.stages = { ...(base.stages ?? {}) };
    for (const [n, s] of Object.entries(over.stages as Raw)) out.stages[n] = { ...(out.stages[n] ?? {}), ...(s as Raw) };
  }
  if (over.pipelines) {
    const byName = new Map<string, Raw>(((base.pipelines ?? []) as Raw[]).map((p) => [p.name, p]));
    for (const p of over.pipelines as Raw[]) byName.set(p.name, p);
    out.pipelines = [...byName.values()];
  }
  return out;
}

/** Load, check and snapshot one pack. Throws PackError (definition) or SkillError (unsafe file). */
export async function loadPack(spec: string | PackSpec, options: LoadPackOptions = {}): Promise<LoadedPack> {
  const root = options.root ?? process.cwd();
  const limits = { ...DEFAULT_SKILL_LIMITS, ...options.limits };
  const ps = typeof spec === "string" ? { dir: spec } : spec;
  const layers: string[] = [];
  for (const d of [ps.dir, ...(ps.overlays ?? [])]) {
    try { layers.push(await realpath(path.resolve(root, d))); }
    catch { throw new PackError(`pack folder ${path.resolve(root, d)} does not exist`); }
  }
  const label = `pack ${path.basename(layers[0]!)}`;

  // factory.yaml: required in the base, optional in overlays.
  let raw: Raw | undefined;
  for (const [i, layer] of layers.entries()) {
    let yamlFile: string | undefined;
    for (const f of ["factory.yaml", "factory.yml"]) {
      const r = await readSafe(layer, path.join(layer, f), limits.maxFileBytes, label, YAML_EXT);
      if (r.kind === "ok") { yamlFile = r.content; break; }
    }
    if (yamlFile === undefined) {
      if (i === 0) throw new PackError(`${label}: factory.yaml is missing`);
      continue;
    }
    let parsed: unknown;
    try { parsed = parseYaml(yamlFile); }
    catch (e) { throw new PackError(`${label}: factory.yaml in ${layer} is not valid YAML: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PackError(`${label}: factory.yaml must be a mapping`);
    raw = raw ? merge(raw, parsed as Raw) : (parsed as Raw);
  }
  raw = raw!;

  const problems: string[] = [];
  const pack = raw.name;
  if (!isStr(pack) || !NAME.test(pack)) throw new PackError(`${label}: name must be letters, digits, ".", "_" or "-"`);
  const at = `pack "${pack}"`;
  const pin = raw.pin ?? "record";
  if (pin !== "record" && pin !== "strict") problems.push(`${at}: pin must be "record" or "strict"`);
  const stagesRaw = raw.stages as Raw | undefined;
  if (!stagesRaw || typeof stagesRaw !== "object" || Array.isArray(stagesRaw) || Object.keys(stagesRaw).length === 0) throw new PackError(`${at}: stages must be a mapping with at least one stage`);
  const rules = raw.rules ?? [];
  if (!strList(rules)) problems.push(`${at}: rules must be a list of skill names`);

  const q = (n: string) => `${pack}/${n}`;
  const texts = new Map<string, LoadedText>();
  const skills = new Map<string, LoadedSkill>();
  const warnings: string[] = [];

  /** The file from the topmost layer that has it. */
  const find = async (rel: string): Promise<{ layer: string; abs: string } | undefined> => {
    for (const layer of [...layers].reverse()) {
      const abs = path.join(layer, rel);
      if (await lstat(abs).then(() => true, () => false)) return { layer, abs };
    }
    return undefined;
  };
  const text = async (kind: LoadedText["kind"], dir: string, name: string, where: string): Promise<string | undefined> => {
    const key = `${kind}:${q(name)}`;
    if (texts.has(key)) return key;
    if (!NAME.test(name)) { problems.push(`${where}: ${kind} name "${name}" must be letters, digits, ".", "_" or "-"`); return undefined; }
    const rel = `${dir}/${name}.md`;
    const f = await find(rel);
    if (!f) { problems.push(`${where}: ${rel} does not exist`); return undefined; }
    const r = await readSafe(f.layer, f.abs, limits.maxFileBytes, `${at} (${where})`, MD_EXT);
    if (r.kind !== "ok") { problems.push(`${where}: ${rel} ${r.kind === "missing" ? "does not exist" : `cannot be loaded (${r.reason})`}`); return undefined; }
    texts.set(key, { kind, name: q(name), hash: sha256(r.content), content: r.content });
    return key;
  };
  const skillNames = new Set<string>();
  for (const s of Object.values(stagesRaw)) if (strList((s as Raw)?.skills)) for (const k of (s as Raw).skills) skillNames.add(k);
  if (strList(rules)) for (const k of rules) skillNames.add(k);
  const skill = async (name: string, where: string): Promise<string | undefined> => {
    if (skills.has(q(name))) return q(name);
    if (!NAME.test(name)) { problems.push(`${where}: skill name "${name}" must be letters, digits, ".", "_" or "-"`); return undefined; }
    const f = await find(`skills/${name}/SKILL.md`);
    if (!f) { problems.push(`${where}: skills/${name}/SKILL.md does not exist`); return undefined; }
    const loaded = await loadOne({ name, source: { path: path.dirname(f.abs) }, options: {} }, f.layer, limits, (m) => warnings.push(`${at}: ${m}`), skillNames);
    skills.set(q(name), loaded);
    return q(name);
  };

  // Stages: check fields, load their files, qualify names.
  const specs = new Map<string, StageSpec>();
  for (const [name, s0] of Object.entries(stagesRaw)) {
    const where = `stage "${name}"`;
    if (!NAME.test(name)) { problems.push(`${at}: stage name "${name}" must be letters, digits, ".", "_" or "-"`); continue; }
    const s = (s0 ?? {}) as Raw;
    const runsIn: RunsIn = s.runsIn ?? "host";
    if (runsIn !== "host" && runsIn !== "sandbox") problems.push(`${where}: runsIn must be host or sandbox`);
    const spec: StageSpec = { name, runsIn, route: parseRoute(s.next, where, problems) };
    for (const k of ["model", "effort"] as const) if (s[k] !== undefined) { if (isStr(s[k])) spec[k] = s[k]; else problems.push(`${where}: ${k} must be a string`); }
    for (const k of ["remindAfter", "gateTimeout"] as const) if (s[k] !== undefined) spec[k] = s[k] as Duration;
    spec.instructions = await text("instructions", "stages", isStr(s.instructions) ? s.instructions : name, where);
    if (s.persona !== undefined) {
      if (isStr(s.persona)) spec.persona = await text("persona", "personas", s.persona, where);
      else problems.push(`${where}: persona must be a name (personas/<name>.md)`);
    }
    if (s.skills !== undefined) {
      if (!strList(s.skills)) problems.push(`${where}: skills must be a list of names`);
      else spec.skills = (await Promise.all(s.skills.map((k) => skill(k, where)))).filter(isStr);
    }
    if (s.produces !== undefined) {
      const p = s.produces as Raw;
      if (!p || !isStr(p.artifact) || !NAME.test(p.artifact)) problems.push(`${where}: produces.artifact must be a name`);
      else {
        const template = await text("template", "templates", isStr(p.template) ? p.template : p.artifact, where);
        if (p.commit !== undefined && !(isStr(p.commit) && isSafeRepoPath(p.commit))) problems.push(`${where}: produces.commit must be a path inside the repo (relative, no "..")`);
        if (template) spec.produces = { artifact: p.artifact, template: template.slice("template:".length), ...(isStr(p.commit) ? { commit: p.commit } : {}) };
      }
    }
    if (s.reads !== undefined) { if (strList(s.reads)) spec.reads = s.reads; else problems.push(`${where}: reads must be a list of artifact names`); }
    if (s.checklist !== undefined) {
      if (!strList(s.checklist)) problems.push(`${where}: checklist must be a list of strings`);
      else if (!s.produces) problems.push(`${where}: a checklist needs an artifact to answer it with (produces)`);
      else spec.checklist = s.checklist;
    }
    if (s.clarify !== undefined) {
      const max = typeof s.clarify === "number" ? s.clarify : (s.clarify as Raw)?.max;
      if (!Number.isInteger(max) || max < 0) problems.push(`${where}: clarify.max must be a whole number, 0 or more`);
      else spec.clarify = { max };
    }
    const routed = Object.keys(spec.route!).filter((k) => k !== "*");
    if (s.outcomes !== undefined) {
      if (!strList(s.outcomes) || s.outcomes.length === 0) problems.push(`${where}: outcomes must be a non-empty list`);
      else {
        spec.outcomes = s.outcomes;
        for (const o of s.outcomes) if (!(o in spec.route!) && !("*" in spec.route!)) problems.push(`${where}: outcome "${o}" has no route (add it to next, or add "*")`);
        for (const k of routed) if (!s.outcomes.includes(k)) problems.push(`${where}: next routes "${k}", which is not in outcomes`);
      }
    } else if (routed.length) {
      spec.outcomes = routed; // the routing table is the list of outcomes
    }
    specs.set(name, spec);
  }
  const ruleKeys = strList(rules) ? (await Promise.all(rules.map((k) => skill(k, `${at} rules`)))).filter(isStr) : [];

  // Pipelines (default: one pipeline named after the pack, stages in file order).
  const rawPipes: Raw[] = raw.pipelines ?? [{ name: pack, stages: Object.keys(stagesRaw) }];
  if (!Array.isArray(rawPipes) || rawPipes.length === 0) throw new PackError(`${at}: pipelines must be a non-empty list`);
  const pipelines: PipelineSnapshot[] = [];
  const seen = new Set<string>();
  for (const p of rawPipes) {
    const pat = `pipeline "${p?.name}"`;
    if (!isStr(p?.name) || !NAME.test(p.name)) { problems.push(`${at}: every pipeline needs a name`); continue; }
    if (seen.has(p.name)) problems.push(`${at}: ${pat} is defined twice`);
    seen.add(p.name);
    const version = p.version ?? 1;
    if (!Number.isInteger(version) || version < 1) problems.push(`${pat}: version must be a positive integer`);
    if (!strList(p.stages) || p.stages.length === 0) { problems.push(`${pat}: stages must be a non-empty list`); continue; }
    const names: string[] = p.stages;
    const missing = names.filter((n) => !specs.has(n));
    for (const n of missing) problems.push(`${pat}: stage "${n}" is not defined under stages`);
    if (missing.length) continue;
    const produced = new Set(names.flatMap((n) => (specs.get(n)!.produces ? [specs.get(n)!.produces!.artifact] : [])));
    for (const n of names) {
      const sp = specs.get(n)!;
      for (const target of Object.values(sp.route ?? {})) if (typeof target === "string" && !names.includes(target)) problems.push(`${pat}: stage "${n}" routes to "${target}", which is not in the pipeline`);
      for (const r of sp.reads ?? []) if (!produced.has(r)) problems.push(`${pat}: stage "${n}" reads "${r}", which no stage of the pipeline produces`);
      const bytes = [sp.persona ? texts.get(sp.persona)?.content.length ?? 0 : 0, ...[...(sp.skills ?? []), ...ruleKeys].map((k) => skills.get(k)?.files.reduce((m, f) => m + Buffer.byteLength(f.content), 0) ?? 0)].reduce((a, b) => a + b, 0);
      if (bytes > limits.maxStageBytes) problems.push(`${pat}: stage "${n}" carries ${bytes} bytes of persona and skills, over the ${limits.maxStageBytes} byte stage budget`);
    }
    const stages = names.map((n) => specs.get(n)!);
    const pins: Record<string, string> = {};
    const pinText = (key: string | undefined) => { if (key && texts.has(key)) pins[key] = texts.get(key)!.hash; };
    for (const sp of stages) {
      pinText(sp.persona);
      pinText(sp.instructions);
      if (sp.produces) pinText(`template:${sp.produces.template}`);
      for (const k of sp.skills ?? []) if (skills.has(k)) pins[`skill:${k}`] = skills.get(k)!.hash;
    }
    for (const k of ruleKeys) pins[`skill:${k}`] = skills.get(k)!.hash;
    const defaults = { ...DEFAULTS, ...(p.defaults ?? {}) };
    // Stage references are stored without their kind prefix: persona "roles/analyst", instructions "roles/analyst".
    const snapStages = stages.map((sp) => ({
      ...sp,
      persona: sp.persona?.slice("persona:".length),
      instructions: sp.instructions?.slice("instructions:".length),
    }));
    const body = { name: p.name, version, stages: snapStages, defaults, rules: ruleKeys, pins, pin };
    pipelines.push({ pack, ...body, hash: sha256(stable(body)) } as PipelineSnapshot);
  }
  if (problems.length) throw new PackError(`${at} is not consistent:\n- ${problems.join("\n- ")}`);
  return { name: pack, description: isStr(raw.description) ? raw.description : undefined, pipelines, texts, skills, warnings };
}

/** Load several packs; pipeline names must be unique across them. */
export async function loadPacks(specs: Array<string | PackSpec>, options: LoadPackOptions = {}): Promise<LoadedPack[]> {
  const packs: LoadedPack[] = [];
  const owner = new Map<string, string>();
  for (const s of specs) {
    const p = await loadPack(s, options);
    if (packs.some((x) => x.name === p.name)) throw new PackError(`pack "${p.name}" is loaded twice`);
    for (const pl of p.pipelines) {
      const prev = owner.get(pl.name);
      if (prev) throw new PackError(`pipeline "${pl.name}" is defined by both pack "${prev}" and pack "${p.name}"`);
      owner.set(pl.name, p.name);
    }
    packs.push(p);
  }
  return packs;
}

export { SkillError };
