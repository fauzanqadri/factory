import { describe, expect, test } from "vitest";
import { makeActivities } from "../src/activities";
import { createRegistry } from "../src/registry";
import { registry } from "./fixtures/registry";
import type { LoadedSkill } from "../src/types";

const ctx = { runId: "run-C-1", pipeline: "ticket", pipelineVersion: 1, channelId: "C", threadTs: "1", starter: "U1", request: "x" };
const host = { url: "https://host.test", token: "t".repeat(32) };

function recorder(status = 200) {
  const seen: Array<{ url: string; auth: string | null; body: any }> = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
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
});
