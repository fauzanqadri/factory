# 02. Registry

An app describes its work by registering stages, pipelines and prompts. The workflow is a generic loop that reads them. Adding a stage, reordering, or giving one kind of work a shorter path is a registration, not a change to the workflow.

## API (`src/registry.ts`, implemented)

```ts
const registry = createRegistry();

registry.stage({ name, runsIn, remindAfter?, gateTimeout?, next });
registry.pipeline({ name, version, stages, defaults: { remindAfter, gateTimeout } });
registry.prompt(stageName, (input) => string);

registry.getStage(name);
registry.getPipeline(name, version?);   // latest version when omitted
registry.getPrompt(stageName);
registry.validate();                    // [] when every pipeline stage exists and has a prompt
```

Registration throws on:
- a duplicate stage or prompt;
- a pipeline with no stages;
- a version that is not a positive integer;
- a `name@version` registered twice.

`validate()` lists every pipeline stage that is unregistered or has no prompt. A worker should refuse to start when it returns anything.

## Example: three pipelines from one set of stages

```ts
registry.stage({ name: "intake",       runsIn: "host",    next: () => "triage" });
registry.stage({ name: "triage",       runsIn: "host",
  next: (a) => (a.outcome && a.outcome !== "code" ? { finish: a.outcome } : "planning") });
registry.stage({ name: "planning",     runsIn: "host",    next: () => "building" });
registry.stage({ name: "building",     runsIn: "sandbox", next: () => "review" });
registry.stage({ name: "review",       runsIn: "sandbox", next: () => ({ finish: "done" }) });
registry.stage({ name: "draft-ticket", runsIn: "host",    next: () => "triage" });

const defaults = { remindAfter: "24h", gateTimeout: "7d" };
registry.pipeline({ name: "ticket",  version: 1, stages: ["intake", "triage", "planning", "building", "review"], defaults });
registry.pipeline({ name: "support", version: 1, stages: ["intake", "triage"], defaults });
registry.pipeline({ name: "request", version: 1, stages: ["draft-ticket", "triage", "planning", "building", "review"], defaults });
```

`stages` lists where a run may go and where it starts. `next` decides the actual path. A run on `support@1` that reaches `triage` with outcome `code` would ask for `planning`. That stage is not in `support@1`, so the engine finishes the run with reason `not-in-pipeline` instead of leaving it. Keep `next` and `stages` consistent.

## Three rules from Temporal

| Rule | Why |
|---|---|
| **Build the registry with static code** at module top level. Do not read files, env vars or the network while registering | Workflow code replays from history and must make the same decisions every time |
| **`next` must be deterministic**: no clock, randomness, I/O or env | It runs inside the workflow |
| **Never edit a registered version.** Change stage order or `next` logic by registering `name@version+1`. New runs pick the latest. Running runs keep the version pinned at start | A running run replays against the version it started with. Editing it in place breaks replay. Delete an old version only once no run uses it; the dashboard shows the version of each run |

## Prompts live outside the workflow

The workflow sends only `{ stage, attempt, note }` to the activity that starts a turn. That activity calls `registry.getPrompt(stage)` and builds the text from the run's facts. Prompt wording changes often, and activities may change between deploys without affecting replay. Changing a prompt therefore needs no new pipeline version.
