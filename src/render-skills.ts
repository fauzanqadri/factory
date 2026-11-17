import type { LoadedSkill } from "./types.js";

// Reached from the package root, which an app's workflows file may bundle: no node:* imports.
// Loading skills from disk is ./skills.js (node-only).

/** The text prepended to a stage's prompt. Deterministic: skills in the order given, files as loaded. */
export function renderSkills(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const parts = ["The following skills apply to this stage. Follow them."];
  for (const s of skills) {
    parts.push(`## Skill: ${s.name}${s.description ? `\n${s.description}` : ""}`);
    for (const f of s.files) parts.push(`### ${s.name}/${f.path}\n\n${f.content.trimEnd()}`);
  }
  return parts.join("\n\n");
}
