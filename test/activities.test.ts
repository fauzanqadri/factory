import { describe, expect, test } from "vitest";
import { makeActivities } from "../src/activities";
import { registry } from "./fixtures/registry";

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
});
