import { describe, expect, test } from "vitest";
import { makeActivities } from "../src/activities";
import { createRegistry } from "../src/registry";
import { registry } from "./fixtures/registry";
import { sha256Hex } from "../src/assemble";
import type { LoadedSkill, LoadedText, StageSpec } from "../src/types";

const ctx = { runId: "run-C-1", pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: "1", starter: "U1", request: "x" };
const host = { url: "https://host.test", token: "t".repeat(32) };

function recorder(status = 200, reply?: unknown) {
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response(reply === undefined ? null : JSON.stringify(reply), { status });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

describe("activities", () => {
  test("runStage builds the prompt from the registry and posts the turn with requestId and bearer", async () => {
    const r = recorder();
    await makeActivities(registry, host, { fetch: r.fetch }).runStage({ ctx, stage: "triage", attempt: 2, note: "again", requestId: "run-C-1:triage:2" });
    expect(r.seen).toEqual([{
      url: "https://host.test/workflow/v1/turns",
      auth: `Bearer ${host.token}`,
      body: { runId: "run-C-1", stage: "triage", attempt: 2, prompt: "triage#2 note=again", requestId: "run-C-1:triage:2" },
    }]);
  });

  test("remind and finish post to the run's callback paths", async () => {
    const r = recorder();
    const a = makeActivities(registry, host, { fetch: r.fetch });
    await a.remind({ runId: "run-C-1", stage: "triage", waitingSince: "2026-10-25T00:00:00Z" });
    await a.finish({ runId: "run-C-1", reason: "done" });
    expect(r.seen.map((s) => [s.url, s.body])).toEqual([
      ["https://host.test/workflow/v1/runs/run-C-1/remind", { stage: "triage", waitingSince: "2026-10-25T00:00:00Z" }],
      ["https://host.test/workflow/v1/runs/run-C-1/finish", { reason: "done" }],
    ]);
  });

  test("a non-2xx answer throws so Temporal retries", async () => {
    const r = recorder(503);
    await expect(makeActivities(registry, host, { fetch: r.fetch }).finish({ runId: "run-C-1", reason: "done" })).rejects.toThrow("503");
  });
  describe("skills and model", () => {
    const skill: LoadedSkill = { name: "tdd", description: "write tests first", hash: "h", files: [{ path: "SKILL.md", content: "RED GREEN REFACTOR" }, { path: "eval.md", content: "CHECK" }] };
    const withSkills = () => {
      const r = createRegistry();
      r.stage({ name: "build", runsIn: "sandbox", skills: ["tdd"], model: "fast-model", next: () => ({ finish: "done" }) });
      r.stage({ name: "plain", runsIn: "host", next: () => ({ finish: "done" }) });
      r.prompt("build", () => "BUILD IT");
      r.prompt("plain", () => "JUST PLAIN");
      return r;
    };

    test("a stage with skills posts the skill text before the prompt, and its model", async () => {
      const r = recorder();
      await makeActivities(withSkills(), host, { fetch: r.fetch, skills: new Map([["tdd", skill]]) }).runStage({ ctx, stage: "build", attempt: 1, requestId: "q" });
      const { prompt, model } = r.seen[0]!.body;
      expect(model).toBe("fast-model");
      expect(prompt.endsWith("\n\nBUILD IT")).toBe(true);
      expect(prompt.indexOf("### tdd/SKILL.md")).toBeLessThan(prompt.indexOf("### tdd/eval.md"));
      expect(prompt).toContain("RED GREEN REFACTOR");
    });

    test("a stage without skills or model posts exactly what it did before", async () => {
      const r = recorder();
      await makeActivities(withSkills(), host, { fetch: r.fetch }).runStage({ ctx, stage: "plain", attempt: 1, requestId: "q" });
      expect(r.seen[0]!.body).toEqual({ runId: "run-C-1", stage: "plain", attempt: 1, prompt: "JUST PLAIN", requestId: "q" });
    });

    test("skills that were not loaded fail without a retry and post nothing", async () => {
      const r = recorder();
      await expect(makeActivities(withSkills(), host, { fetch: r.fetch }).runStage({ ctx, stage: "build", attempt: 1, requestId: "q" })).rejects.toMatchObject({ nonRetryable: true });
      expect(r.seen).toEqual([]);
    });
  });

  describe("method layer", () => {
    const text = (kind: LoadedText["kind"], name: string, content: string): [string, LoadedText] => [`${kind}:${name}`, { kind, name, hash: `hash-${name}`, content }];
    const texts = new Map([
      text("persona", "pm", "You are the PM."),
      text("template", "prd", "## Summary *(mandatory)*"),
      text("persona", "roles/qa", "You are QA."),
      text("template", "roles/qa-gate", "## Verdict *(mandatory)*"),
      text("instructions", "roles/qa", "Review the story for {{request}} (attempt {{attempt}})."),
    ]);
    const codeRegistry = () => {
      const r = createRegistry();
      r.stage({ name: "pm", runsIn: "host", persona: "pm", effort: "high", reads: ["brief"], checklist: ["FRs have IDs"], outcomes: ["ok"], produces: { artifact: "prd", template: "prd" }, next: () => ({ finish: "done" }) });
      r.prompt("pm", (i) => `Write the PRD (inputs: ${Object.keys(i.artifacts ?? {}).join(",")})`);
      return r;
    };
    const brief = { artifact: "brief", seq: 1, stage: "analyst", attempt: 1, content: "## Problem\nslow", hash: "b", approvedBy: "U2", at: "t" };

    test("a method stage posts a self-contained prompt, a fresh context and its artifact contract, and returns its fingerprint", async () => {
      const r = recorder();
      const fp = await makeActivities(codeRegistry(), host, { fetch: r.fetch, texts }).runStage({ ctx, stage: "pm", attempt: 1, requestId: "q", inputs: [brief] });
      const body = r.seen[0]!.body;
      expect(body).toMatchObject({ context: "fresh", effort: "high", artifact: { name: "prd", checklist: ["FRs have IDs"], outcomes: ["ok"], outcomeRequired: true } });
      expect(body.prompt).toContain("You are the PM.");
      expect(body.prompt).toContain("Write the PRD (inputs: brief)");
      expect(body.prompt).toContain('<artifact name="brief" version="1"');
      expect(body.promptHash).toBe(await sha256Hex(body.prompt));
      expect(fp).toEqual({ promptHash: body.promptHash, persona: "hash-pm", template: "hash-prd", skills: {}, effort: "high" });
    });

    test("a pack stage uses its instructions file with placeholders filled, and reports files that changed since the run started", async () => {
      const spec: StageSpec = { name: "qa", runsIn: "sandbox", persona: "roles/qa", instructions: "roles/qa", produces: { artifact: "qa-gate", template: "roles/qa-gate" }, route: { pass: "story", fail: "dev" }, outcomes: ["pass", "fail"] };
      const pins = { "persona:roles/qa": "hash-roles/qa", "template:roles/qa-gate": "an-older-hash", "instructions:roles/qa": "hash-roles/qa" };
      const r = recorder();
      const a = makeActivities(createRegistry(), host, { fetch: r.fetch, texts });
      const fp = await a.runStage({ ctx, stage: "qa", attempt: 2, requestId: "q", spec, pins, pin: "record" });
      expect(r.seen[0]!.body.prompt).toContain("Review the story for x (attempt 2).");
      expect(fp.drift).toEqual(["template:roles/qa-gate"]);
      await expect(a.runStage({ ctx, stage: "qa", attempt: 2, requestId: "q", spec, pins, pin: "strict" })).rejects.toMatchObject({ nonRetryable: true });
      expect(r.seen).toHaveLength(1); // strict: nothing posted
    });

    test("a persona that was not loaded fails without a retry", async () => {
      const r = recorder();
      await expect(makeActivities(codeRegistry(), host, { fetch: r.fetch }).runStage({ ctx, stage: "pm", attempt: 1, requestId: "q" })).rejects.toMatchObject({ nonRetryable: true });
      expect(r.seen).toEqual([]);
    });

    test("commit posts the artifact to the run's commit callback and returns the host's sha", async () => {
      const r = recorder(200, { sha: "abc123" });
      const res = await makeActivities(registry, host, { fetch: r.fetch }).commit({ runId: "run-C-1", requestId: "run-C-1:commit:prd:1", path: "docs/prd.md", content: "# PRD", message: "m" });
      expect(res).toEqual({ sha: "abc123" });
      expect(r.seen[0]).toMatchObject({ url: "https://host.test/workflow/v1/runs/run-C-1/commit", body: { requestId: "run-C-1:commit:prd:1", path: "docs/prd.md", content: "# PRD", message: "m" } });
      await expect(makeActivities(registry, host, { fetch: r.fetch }).commit({ runId: "r", requestId: "q", path: "docs/../../etc/x", content: "", message: "m" })).rejects.toMatchObject({ nonRetryable: true });
      expect(r.seen).toHaveLength(1);
    });
  });
});
