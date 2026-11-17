import { describe, expect, test } from "vitest";
import { assemblePrompt, checkArtifact, contractOf, fillPath, isSafeRepoPath, openQuestions, parseTemplate, routeNext, sha256Hex } from "../src";
import type { ArtifactVersion, LoadedSkill, LoadedText } from "../src/types";

const template = [
  "# Brief",
  "## Problem *(mandatory)*",
  "<!-- What is wrong today. -->",
  "## Goals *(mandatory)*",
  "## Scope *(mandatory)*",
  "### In",
  "### Out",
  "## Notes",
  "<!-- optional -->",
].join("\n");

const good = [
  "# Brief",
  "## Problem",
  "Refunds take a week.",
  "## Goals",
  "- G-1: a refund closes in a day",
  "## Scope",
  "### In",
  "Card refunds.",
].join("\n");

describe("templates and checks", () => {
  test("parseTemplate reads headings and the *(mandatory)* marker", () => {
    expect(parseTemplate(template).filter((s) => s.mandatory).map((s) => s.title)).toEqual(["problem", "goals", "scope"]);
  });

  test("a filled artifact passes; a section counts as filled through its sub-sections", () => {
    expect(checkArtifact({ content: good, template })).toEqual({ problems: [], questions: [] });
  });

  test("missing and empty mandatory sections, leftover guidance and placeholders are problems", () => {
    const bad = ["## Problem", "<!-- What is wrong today. -->", "## Goals", "[GOAL_ONE] and {{goal}}"].join("\n");
    expect(checkArtifact({ content: bad, template }).problems).toEqual([
      'mandatory section "problem" is empty',
      'mandatory section "scope" is missing',
      "template guidance comments are still in the artifact: remove them",
      "unfilled placeholders: [GOAL_ONE], {{goal}}",
    ]);
  });

  test("headings inside a fenced code block do not count as sections", () => {
    const fenced = "## Goals\n- G-1\n```md\n## Problem\nnot really\n```\n## Scope\nall";
    expect(checkArtifact({ content: fenced, template }).problems).toEqual(['mandatory section "problem" is missing']);
  });

  test("open questions up to the limit are accepted (not approvable); over the limit is a problem", () => {
    const q = `${good}\n[NEEDS CLARIFICATION: which cards?] [NEEDS CLARIFICATION: which currency?]`;
    expect(openQuestions(q)).toEqual(["which cards?", "which currency?"]);
    expect(checkArtifact({ content: q, template, clarifyMax: 2 })).toEqual({ problems: [], questions: ["which cards?", "which currency?"] });
    expect(checkArtifact({ content: q, template, clarifyMax: 1 }).problems[0]).toMatch(/^2 \[NEEDS CLARIFICATION\] questions; the limit is 1/);
  });

  test("checklist: every item answered, a fail needs a note", () => {
    const checklist = ["goals are measurable", "scope has an Out"];
    expect(checkArtifact({ content: good, checklist, answers: [{ item: "goals are measurable", pass: false }] }).problems).toEqual([
      'checklist item fails without a note: "goals are measurable"',
      'checklist item not answered: "scope has an Out"',
    ]);
    const answered = [{ item: "goals are measurable", pass: true }, { item: "scope has an Out", pass: false, note: "nothing is out yet" }];
    expect(checkArtifact({ content: good, checklist, answers: answered }).problems).toEqual([]);
  });

  test("outcome must be in the list, and present when required; size and emptiness are checked", () => {
    expect(checkArtifact({ content: good, outcomes: ["ready", "none-left"], outcome: "Ready" }).problems).toEqual(['outcome "Ready" is not one of: ready, none-left']);
    expect(checkArtifact({ content: good, outcomes: ["ready"], outcomeRequired: true }).problems).toEqual(["an outcome is required: one of ready"]);
    expect(checkArtifact({ content: "x".repeat(20), maxBytes: 10 }).problems[0]).toMatch(/over the 10 byte limit/);
    expect(checkArtifact({ content: "  " }).problems).toEqual(["the artifact is empty"]);
  });
});

describe("routing and contracts", () => {
  test("routeNext uses the outcome's route, then *, else nothing", () => {
    const route = { pass: "story", fail: "dev", "*": { finish: "done" } };
    expect(routeNext(route, "fail")).toBe("dev");
    expect(routeNext(route, "other")).toEqual({ finish: "done" });
    expect(routeNext({ pass: "story" }, undefined)).toBeUndefined();
    expect(routeNext({ constructor: "x" } as never, "toString")).toBeUndefined();
  });

  test("commit paths must stay inside the repo", () => {
    expect(["docs/{runId}/prd.md", "a/b.c.md", "x..y.md"].every(isSafeRepoPath)).toBe(true);
    expect(["", "/etc/passwd", "../x.md", "docs/../../x", "C:/x", "a\\..\\b", "a\0b"].some(isSafeRepoPath)).toBe(false);
  });

  test("fillPath fills known names only", () => {
    expect(fillPath("docs/{runId}/{artifact}-{seq}{ext}", { runId: "run-C-1", artifact: "prd", seq: 2 })).toBe("docs/run-C-1/prd-2{ext}");
  });

  test("contractOf: a pack route without * requires an outcome; with * it does not", () => {
    const base = { name: "qa", runsIn: "host" as const, produces: { artifact: "gate", template: "t" } };
    expect(contractOf({ ...base, outcomes: ["pass", "fail"], route: { pass: "a", fail: "b" } }, false)).toMatchObject({ outcomeRequired: true, clarifyMax: 3, artifact: "gate" });
    expect(contractOf({ ...base, outcomes: ["pass"], route: { pass: "a", "*": "b" } }, false).outcomeRequired).toBe(false);
    expect(contractOf({ ...base }, true).outcomeRequired).toBe(false);
  });
});

describe("prompt assembly", () => {
  const ctx = { runId: "run-C-1", pipeline: "roles", pipelineVersion: 1, channelId: "C", threadTs: "1", starter: "U1", request: "Refunds are slow", ticketRef: "T-9" };
  const skill = (name: string, body: string): LoadedSkill => ({ name, description: "", hash: "h", files: [{ path: "SKILL.md", content: body }] });
  const persona: LoadedText = { kind: "persona", name: "roles/pm", hash: "p", content: "You are the PM." };
  const input: ArtifactVersion = { artifact: "brief", seq: 1, stage: "analyst", attempt: 2, content: "## Problem\nslow", hash: "b", approvedBy: "U2", at: "t" };

  test("a stage outside the method layer keeps the old shape: rules, skills, then the prompt", () => {
    expect(assemblePrompt({ ctx, stage: "s", attempt: 1, instructions: "DO IT" }, false)).toBe("DO IT");
    const p = assemblePrompt({ ctx, stage: "s", attempt: 1, skills: [skill("tdd", "RED")], instructions: "DO IT" }, false);
    expect(p.endsWith("\n\nDO IT")).toBe(true);
    expect(p).toContain("RED");
  });

  test("a method stage gets every part, always in the same order", () => {
    const p = assemblePrompt({
      ctx, stage: "pm", attempt: 3, rules: [skill("house", "HOUSE RULES")], persona, skills: [skill("prd", "PRD SKILL")],
      instructions: "Write the PRD.", inputs: [input],
      clarifications: [{ stage: "pm", attempt: 1, question: "Which cards?", answer: "Visa only", by: "U2" }],
      feedback: [
        { kind: "rejected", stage: "pm", attempt: 2, by: "U3", note: "too vague" },
        { kind: "sent-back", stage: "pm", attempt: 1, by: "U4", outcome: "redo", from: "architect", note: "split S-2" },
      ],
      output: { artifact: "prd", template: "## Summary *(mandatory)*", checklist: ["FRs have IDs"], outcomes: ["ok"], outcomeRequired: true, clarifyMax: 2 },
    }, true);
    const order = ["# Stage: pm (attempt 3)", "## Project rules", "HOUSE RULES", "## Your role", "You are the PM.", "## Skills", "PRD SKILL", "## Instructions", "## The request", "Refunds are slow", "## Approved inputs", '<artifact name="brief" version="1"', "## Clarifications", "Visa only", "## Feedback", "too vague", "architect sent the run back here (outcome redo)", "## Output", "at most 2", "FRs have IDs", "exactly one of: `ok`", '<template artifact="prd">'];
    let at = -1;
    for (const part of order) {
      const i = p.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
    expect(p).toContain("Ticket: T-9");
  });

  test("the same parts always give the same prompt and hash", async () => {
    const parts = { ctx, stage: "pm", attempt: 1, persona, instructions: "x", inputs: [input] };
    expect(assemblePrompt(parts, true)).toBe(assemblePrompt({ ...parts }, true));
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
