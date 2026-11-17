/**
 * Artifacts: templates, the checks a submitted artifact must pass before a person sees it,
 * and routing for pack stages. Pure functions with no I/O, so this module is safe in the
 * workflow sandbox (the package root re-exports it).
 */
import type { ArtifactMap, ArtifactVersion, ChecklistAnswer, Next, StageContract, StageSpec } from "./types.js";

/** Default byte limit for one artifact. Large outputs (code, logs) belong in the repo, linked from the artifact. */
export const MAX_ARTIFACT_BYTES = 64 * 1024;
/** Default number of open `[NEEDS CLARIFICATION]` questions an artifact may carry. */
export const DEFAULT_CLARIFY_MAX = 3;

const MANDATORY = /\s*\*?\(mandatory\)\*?\s*/i;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const CLARIFY = /\[NEEDS CLARIFICATION:\s*([^\]]+?)\s*\]/g;
// [FEATURE_NAME]-style placeholders and {{var}} left from a template.
const PLACEHOLDER = /\[[A-Z][A-Z0-9_]{2,}\]|\{\{[^}]*\}\}/g;
const COMMENT = /<!--([\s\S]*?)-->/g;
const FENCE = /^(`{3,}|~{3,})/;

export interface TemplateSection {
  title: string;
  level: number;
  mandatory: boolean;
}

interface Section extends TemplateSection {
  body: string;
}

const norm = (s: string) => s.replace(MANDATORY, " ").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Headings of a Markdown text with the text under each, skipping fenced code blocks. */
function sections(text: string): Section[] {
  const out: Section[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(FENCE);
    if (f) fence = fence === undefined ? f[1] : line.startsWith(fence) ? undefined : fence;
    const h = fence === undefined ? line.match(HEADING) : null;
    if (h) out.push({ title: norm(h[2]!), level: h[1]!.length, mandatory: MANDATORY.test(h[2]!), body: "" });
    else if (out.length) out[out.length - 1]!.body += line + "\n";
  }
  return out;
}

/** The headings of a template; a heading marked `*(mandatory)*` must appear, non-empty, in the artifact. */
export function parseTemplate(template: string): TemplateSection[] {
  return sections(template).map(({ title, level, mandatory }) => ({ title, level, mandatory }));
}

/** The open questions in an artifact: the text of each `[NEEDS CLARIFICATION: …]` marker. */
export function openQuestions(content: string): string[] {
  return [...content.matchAll(CLARIFY)].map((m) => m[1]!.trim());
}

export interface CheckInput {
  content: string;
  /** The template text; its mandatory sections and guidance comments are checked. */
  template?: string;
  checklist?: string[];
  answers?: ChecklistAnswer[];
  outcomes?: string[];
  outcome?: string;
  outcomeRequired?: boolean;
  clarifyMax?: number;
  maxBytes?: number;
}

export interface CheckResult {
  /** Each problem blocks the artifact; the host hands them back to the agent to fix. */
  problems: string[];
  /** Open questions; the artifact is accepted but cannot be approved until they are answered. */
  questions: string[];
}

/** Check a submitted artifact against its stage's contract. Deterministic: same input, same result. */
export function checkArtifact(i: CheckInput): CheckResult {
  const problems: string[] = [];
  const content = i.content ?? "";
  const max = i.maxBytes ?? MAX_ARTIFACT_BYTES;
  const bytes = new TextEncoder().encode(content).length;
  if (content.trim() === "") problems.push("the artifact is empty");
  if (bytes > max) problems.push(`the artifact is ${bytes} bytes, over the ${max} byte limit: move long material (code, logs) into the repo and link it`);

  if (i.template) {
    const have = sections(content);
    for (const t of parseTemplate(i.template)) {
      if (!t.mandatory) continue;
      const at = have.findIndex((s) => s.title === t.title);
      if (at < 0) { problems.push(`mandatory section "${t.title}" is missing`); continue; }
      // A section counts as filled when it, or any sub-section under it, has text.
      let body = have[at]!.body;
      for (let k = at + 1; k < have.length && have[k]!.level > have[at]!.level; k++) body += have[k]!.body;
      if (body.replace(COMMENT, "").trim() === "") problems.push(`mandatory section "${t.title}" is empty`);
    }
    const guidance = new Set([...i.template.matchAll(COMMENT)].map((m) => m[1]!.trim()).filter(Boolean));
    if ([...content.matchAll(COMMENT)].some((m) => guidance.has(m[1]!.trim()))) problems.push("template guidance comments are still in the artifact: remove them");
  }

  const placeholders = [...new Set([...content.replace(CLARIFY, "").matchAll(PLACEHOLDER)].map((m) => m[0]))];
  if (placeholders.length) problems.push(`unfilled placeholders: ${placeholders.join(", ")}`);

  const questions = openQuestions(content);
  const clarifyMax = i.clarifyMax ?? DEFAULT_CLARIFY_MAX;
  if (questions.length > clarifyMax) {
    problems.push(`${questions.length} [NEEDS CLARIFICATION] questions; the limit is ${clarifyMax}: keep the ones that matter most (scope, then security, then user experience, then technical detail), make an informed choice for the rest and record it as an assumption`);
  }

  for (const item of i.checklist ?? []) {
    const a = (i.answers ?? []).find((x) => x.item === item);
    if (!a || typeof a.pass !== "boolean") problems.push(`checklist item not answered: "${item}"`);
    else if (!a.pass && !a.note?.trim()) problems.push(`checklist item fails without a note: "${item}"`);
  }

  if (i.outcome !== undefined && i.outcomes?.length && !i.outcomes.includes(i.outcome)) {
    problems.push(`outcome "${i.outcome}" is not one of: ${i.outcomes.join(", ")}`);
  }
  if (i.outcome === undefined && i.outcomeRequired) problems.push(`an outcome is required: one of ${(i.outcomes ?? []).join(", ")}`);
  return { problems, questions };
}

/** What follows an approval of a pack stage: the route for its outcome, else `"*"`. */
export function routeNext(route: Record<string, Next> | undefined, outcome: string | undefined): Next | undefined {
  if (!route) return undefined;
  if (outcome !== undefined && Object.prototype.hasOwnProperty.call(route, outcome)) return route[outcome];
  return route["*"];
}

/** Fill `{runId}`, `{artifact}`, `{stage}`, `{seq}` in a commit path. Unknown names are left as they are. */
export function fillPath(pattern: string, vars: Record<string, string | number>): string {
  return pattern.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A repo-relative path that stays inside the repo: not absolute, no `..` segment, no NUL. */
export function isSafeRepoPath(p: string): boolean {
  return p.trim() !== "" && !p.includes("\0") && !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes("..");
}

/** The latest approved version of each artifact. */
export function latestArtifacts(versions: ArtifactVersion[]): ArtifactMap {
  const out: ArtifactMap = {};
  for (const v of versions) out[v.artifact] = v;
  return out;
}

/** True for a stage that uses the method layer: its prompt is assembled and its turn runs in a fresh context. */
export function isMethodStage(spec: Pick<StageSpec, "produces" | "persona" | "reads" | "instructions">): boolean {
  return Boolean(spec.produces || spec.persona || spec.reads?.length || spec.instructions);
}

/** The contract the API checks submissions and approvals against for a stage. */
export function contractOf(spec: StageSpec, fromRegistry: boolean): StageContract {
  const outcomes = spec.outcomes?.length ? spec.outcomes : undefined;
  // A pack route without "*" cannot route a missing outcome; a code stage that lists outcomes wants one.
  const outcomeRequired = outcomes !== undefined && (fromRegistry || !spec.route || !("*" in spec.route));
  return {
    artifact: spec.produces?.artifact,
    template: spec.produces?.template,
    checklist: spec.checklist?.length ? spec.checklist : undefined,
    outcomes,
    outcomeRequired,
    clarifyMax: spec.clarify?.max ?? DEFAULT_CLARIFY_MAX,
    fromRegistry,
  };
}
