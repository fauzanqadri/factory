# 02. Registry

An app describes its work by registering stages, pipelines and prompts. The workflow is a generic loop that reads them. Adding a stage, reordering, or giving one kind of work a shorter path is a registration, not a change to the workflow.

## API (`src/registry.ts`, implemented)

```ts
const registry = createRegistry();

registry.stage({ name, runsIn, remindAfter?, gateTimeout?, next });
registry.pipeline({ name, version, stages, defaults: { remindAfter, gateTimeout } });
registry.prompt(stageName, (input) => string);
registry.on(event, options?, handler);  // event hooks (below)

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

`validate()` lists every pipeline stage that is unregistered or has no prompt, and every hook whose `stage` or `pipeline` filter names something unregistered. A worker should refuse to start when it returns anything.

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

## Hooks

Hooks extend a run without touching the engine. There are two kinds, split by where they run.

### Event hooks (side effects)

The workflow calls one activity, `emit(event)`, at fixed points of every run. The app registers handlers for those events. The emit activity runs them with `dispatchEvent` (`src/hooks.ts`, implemented).

```ts
registry.on("stage.started",  async (e) => tracker.addLabel(e.ticketRef, `stage:${e.stage}`));
registry.on("stage.approved", async (e) => metrics.count("stage_approved", { stage: e.stage }));
registry.on("stage.approved", { stage: "triage", pipeline: "support" }, async (e) => chat.postInfo(e));
registry.on("run.finished",   { mode: "required" }, async (e) => tracker.comment(e.ticketRef, `Finished: ${e.finish}`));
```

| Event | Emitted | Payload adds |
|---|---|---|
| `run.started` | after the run starts | |
| `stage.started` | before the stage turn, on every attempt | `stage`, `attempt` |
| `stage.skipped` | when a stage's `skip` returned true | `stage` |
| `stage.approved` | when an approval arrives | `stage`, `attempt`, `approval` |
| `stage.rejected` | when a rejection arrives | `stage`, `attempt`, `approval` (with the note) |
| `gate.reminded` | when `remindAfter` fires | `stage`, `waitingSince` |
| `run.finished` | before the finish callback | `finish` |

Every event also carries the run's facts (`RunContext`), an `eventId` (`<runId>:<name>:<stage>:<attempt>`) and `at`.

Rules:
- **Filters.** `stage` and `pipeline` options limit a handler to some stages or pipelines. Handlers run in registration order.
- **Modes.** `best-effort` (default) logs an error and moves on. `required` makes the emit activity fail, so Temporal retries it and the run waits until the handler succeeds. Required handlers run before best-effort ones, so a retry caused by a required failure never repeats a best-effort side effect.
- **Idempotency.** Activities run at least once, so a handler can see the same event twice. Use `eventId` as the idempotency key for anything external.
- **Deploy freely.** The workflow emits the same events whatever handlers exist, so adding or removing a handler needs no new pipeline version and does not affect running runs.

### Decision hooks (shape the path)

`skip(ctx)` and `next(approval, ctx)` live on the stage and run inside the workflow. They must be pure functions of plain data. A stage whose `skip` returns true has no turn and no gate: the run emits `stage.skipped` and moves to what `next` returns for an automatic approval. Changing a decision hook needs a new pipeline version, like changing the stage order.

```ts
registry.stage({
  name: "planning", runsIn: "host",
  skip: (ctx) => ctx.ticketRef?.startsWith("HOTFIX-") ?? false,
  next: () => "building",
});
```

| To | Use |
|---|---|
| Call a tracker, chat, metrics, an LLM, anything with I/O | An event hook |
| Change which stage runs next, or skip one | A decision hook, in a new pipeline version |

## Three rules from Temporal

| Rule | Why |
|---|---|
| **Build the registry with static code** at module top level. Do not read files, env vars or the network while registering | Workflow code replays from history and must make the same decisions every time |
| **`next` must be deterministic**: no clock, randomness, I/O or env | It runs inside the workflow |
| **Never edit a registered version.** Change stage order or `next` logic by registering `name@version+1`. New runs pick the latest. Running runs keep the version pinned at start | A running run replays against the version it started with. Editing it in place breaks replay. Delete an old version only once no run uses it; the dashboard shows the version of each run |

## Prompts live outside the workflow

The workflow sends only `{ stage, attempt, note }` to the activity that starts a turn. That activity calls `registry.getPrompt(stage)` and builds the text from the run's facts. Prompt wording changes often, and activities may change between deploys without affecting replay. Changing a prompt therefore needs no new pipeline version.
