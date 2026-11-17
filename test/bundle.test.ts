import { fileURLToPath } from "node:url";
import { bundleWorkflowCode, DefaultLogger } from "@temporalio/worker";
import { expect, test } from "vitest";

// Temporal's bundler rejects Node builtins, so anything an app's workflows file can reach
// through the package root must stay free of node:* imports (node-only code lives in ./server).
test("a workflows file that imports from the package root bundles", async () => {
  const errors: string[] = [];
  const logger = new DefaultLogger("ERROR", (entry) => errors.push(entry.message));
  const workflowsPath = fileURLToPath(new URL("./fixtures/root-workflows.ts", import.meta.url));
  const bundled = await bundleWorkflowCode({ workflowsPath, logger }).catch((e: Error) => {
    throw new Error(`${e.message}\n${errors.join("\n")}`);
  });
  expect(bundled.code.length).toBeGreaterThan(0);
});
