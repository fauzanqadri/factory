/**
 * Builds the text of a stage turn in a fixed order, so the same run state always gives the
 * same prompt. Pure (plus a hash through Web Crypto, no node:* import): safe in the workflow
 * bundle, which reaches it through the package root.
 */
import { renderSkills } from "./render-skills.js";
import type { ArtifactVersion, Clarification, Feedback, LoadedSkill, LoadedText, RunContext, StageName } from "./types.js";

export interface PromptParts {
  ctx: RunContext;
  stage: StageName;
  attempt: number;
  /** Project rules: skills applied to every stage of the pipeline. */
  rules?: LoadedSkill[];
  persona?: LoadedText;
  skills?: LoadedSkill[];
  /** The stage's own instructions (an app prompt function's result, or a pack's stages/<name>.md). */
  instructions: string;
  /** Approved artifacts the stage reads, in `reads` order. */
  inputs?: ArtifactVersion[];
  clarifications?: Clarification[];
  feedback?: Feedback[];
  output?: {
    artifact: string;
    template: string;
    checklist?: string[];
    outcomes?: string[];
    outcomeRequired?: boolean;
    clarifyMax: number;
  };
}

/** XML-style block; the body is left as is, so Markdown headings inside it stay inside it. */
const block = (tag: string, attrs: Record<string, string | number | undefined>, body: string) => {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "&quot;")}"`).join("");
  return `<${tag}${a}>\n${body.trimEnd()}\n</${tag}>`;
};

/**
 * A stage that uses the method layer (persona, artifacts, templates) gets the full, sectioned
 * prompt: it must be self-sufficient, because the host runs it in a fresh context with no thread
 * history. Any other stage keeps the earlier shape: project rules and skills, then its prompt.
 */
export function assemblePrompt(p: PromptParts, method: boolean): string {
  if (!method) {
    return [p.rules?.length ? renderSkills(p.rules) : "", p.skills?.length ? renderSkills(p.skills) : "", p.instructions].filter(Boolean).join("\n\n");
  }
  const out: string[] = [];
  out.push(`# Stage: ${p.stage} (attempt ${p.attempt})`);
  out.push("This turn is self-contained: everything you need is below. Do not rely on earlier conversation.");
  if (p.rules?.length) out.push(`## Project rules\n\n${renderSkills(p.rules)}`);
  if (p.persona) out.push(`## Your role\n\n${block("persona", { name: p.persona.name }, p.persona.content)}`);
  if (p.skills?.length) out.push(`## Skills\n\n${renderSkills(p.skills)}`);
  out.push(`## Instructions\n\n${p.instructions.trimEnd()}`);

  const req = [`Run: ${p.ctx.runId} (pipeline ${p.ctx.pipeline}@${p.ctx.pipelineVersion}), started by ${p.ctx.starter}.`];
  if (p.ctx.ticketRef) req.push(`Ticket: ${p.ctx.ticketRef}`);
  out.push(`## The request\n\n${req.join("\n")}\n\n${block("request", {}, p.ctx.request)}`);

  if (p.inputs?.length) {
    const docs = p.inputs.map((v) => block("artifact", { name: v.artifact, version: v.seq, stage: v.stage, "approved-by": v.approvedBy }, v.content));
    out.push(`## Approved inputs\n\nThese were approved by a person. Treat them as the source of truth; do not contradict them without saying so.\n\n${docs.join("\n\n")}`);
  }
  if (p.clarifications?.length) {
    out.push(`## Clarifications\n\nAnswers people gave earlier in this run. They override assumptions.\n\n${p.clarifications.map((c) => `- Q (${c.stage}): ${c.question}\n  A (${c.by}): ${c.answer}`).join("\n")}`);
  }
  if (p.feedback?.length) {
    const lines = p.feedback.map((f) =>
      f.kind === "rejected"
        ? `- Attempt ${f.attempt} was rejected by ${f.by}${f.note ? `: ${f.note}` : " (no note)"}`
        : `- ${f.from} sent the run back here${f.outcome ? ` (outcome ${f.outcome})` : ""}, by ${f.by}${f.note ? `: ${f.note}` : ""}`,
    );
    out.push(`## Feedback\n\nAddress every point below; do not repeat a rejected approach.\n\n${lines.join("\n")}`);
  }
  if (p.output) {
    const o = p.output;
    const rules = [
      `Write the \`${o.artifact}\` artifact from the template below. Keep its headings, fill every section marked *(mandatory)*, delete optional sections that do not apply (do not write "N/A"), and remove the guidance comments.`,
      `Do not guess. Where a decision needs information you do not have, write \`[NEEDS CLARIFICATION: <one question>]\` in place, at most ${o.clarifyMax} in total. For anything else, make an informed choice and record it as an assumption.`,
    ];
    if (o.checklist?.length) rules.push(`Before you submit, answer each checklist item pass or fail, with a note for every fail:\n${o.checklist.map((c) => `  - ${c}`).join("\n")}`);
    if (o.outcomes?.length) rules.push(`Set the outcome to ${o.outcomeRequired ? "exactly one" : "one, if it applies,"} of: ${o.outcomes.map((x) => `\`${x}\``).join(", ")}.`);
    rules.push("Submit the artifact with the submit tool. factory checks it and returns any problems; fix them and submit again in this same turn.");
    out.push(`## Output\n\n${rules.map((r, n) => `${n + 1}. ${r}`).join("\n")}\n\n${block("template", { artifact: o.artifact }, o.template)}`);
  }
  return out.join("\n\n");
}

/** sha256 hex through Web Crypto (global in Node 22; no node:* import, so the bundle stays clean). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fill `{{name}}` placeholders in pack instructions from the run's facts. Unknown names are left as they are. */
export function fillInstructions(text: string, vars: Record<string, string | number | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}
