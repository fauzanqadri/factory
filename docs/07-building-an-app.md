# 07. Building an app on factory

Status: the registry is implemented. The worker, API and dashboard helpers named below are specified, not built.

An app is its own repo. It depends on `@fauzanqadri/factory`, describes its work in a registry, and runs one process that is the Temporal worker, the HTTP API and the dashboard together.

## Layout

```
my-app/
  src/
    registry.ts     stages, pipelines (static code only)
    prompts.ts      registry.prompt(...) for each stage
    hooks.ts        registry.on(...) event hooks (tracker, chat, metrics)
    workflows.ts    export const pipelineWorkflow = makePipelineWorkflow(registry)
    main.ts         startFactory({ registry, workflowsPath, ... })
  test/
  Dockerfile
```

## Steps

1. **Register stages and pipelines** in `src/registry.ts` ([02-registry.md](02-registry.md)). Keep the module free of I/O: it is bundled into the workflow.
2. **Register a prompt for every stage** in `src/prompts.ts`. Prompts may read the run's facts, the attempt and the last rejection note, and may change freely between deploys.
3. **Export the workflow** in `src/workflows.ts`. It is the only file the Temporal bundler loads:
   ```ts
   import { makePipelineWorkflow } from "@fauzanqadri/factory/workflow";
   import { registry } from "./registry";
   export const pipelineWorkflow = makePipelineWorkflow(registry);
   ```
4. **Start the process** in `src/main.ts`:
   ```ts
   import { startFactory } from "@fauzanqadri/factory/server";
   import { registry } from "./registry";
   import "./prompts";
   await startFactory({ registry, workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)) });
   ```
   `startFactory` runs `registry.validate()` and refuses to start on any problem. It then starts the worker, the API and the dashboard on one port.
5. **Test the app's paths** with `@temporalio/testing` (time skipping). For each pipeline, approve, reject and time out each stage, and check the finish reason.

## Configuration (env only, one image for every environment)

| Env | Meaning |
|---|---|
| `PORT` | API and dashboard |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | Temporal connection |
| `FACTORY_API_TOKEN` | Bearer the chat host sends |
| `CHAT_HOST_URL`, `FACTORY_CALLBACK_TOKEN` | Where and how factory calls the chat host back |
| `TEMPORAL_UI_URL`, `CHAT_THREAD_URL`, `TICKET_URL` | Dashboard links (templates with `{channelId}`, `{threadTs}`, `{ticketRef}`) |

## Changing an app safely

| Change | How |
|---|---|
| Prompt wording | Edit the prompt and deploy. Running runs pick it up on their next stage |
| Event hooks | Add, change or remove handlers and deploy. No new pipeline version |
| A `skip` rule | A decision hook: register a new pipeline version |
| A new stage, a different order, different `next` logic | Register the stage, then a new pipeline version. New runs use it; running runs finish on their old version |
| Removing an old pipeline version | Only after the dashboard shows no running run on it |
| Gate timers | Part of the pipeline version (or the stage), so register a new version |
