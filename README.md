# factory

A small framework for running work through **stages with a human approval between each one**, on top of [Temporal](https://temporal.io), driven from a chat thread where an AI agent does the work.

An app built on factory registers its stages and pipelines in a registry. The framework provides:
- the Temporal workflow that walks a pipeline;
- the approval gates and their timers;
- an HTTP API for the chat host;
- a dashboard.

The chat host (the reference is [slaude](https://github.com/barockok/slaude)) runs the agent turns and shows the approval cards.

Status: the registry, hooks, the pipeline workflow, its activities, per-stage skills, the method layer (artifacts, templates, personas, checklists, clarifications), workflow packs with the bundled roles pack, the HTTP API and `startFactory()` are implemented and tested (88 tests, including the workflow against Temporal's time-skipping test server). The dashboard is specified in `docs/06-dashboard.md` and not built yet.

## Why

AI agents can take a ticket from intake to a pull request, but a team still wants a person to say "yes, go on" between the steps. Doing that inside one chat session breaks down:
- approvals wait hours or days;
- the agent's pod restarts;
- nobody can see which tickets are stuck where.

factory moves the lifecycle into a durable Temporal workflow. The chat thread keeps the conversation, the work and the approvals.

Runs should also give the same kind of result every time. Like GitHub Spec Kit and the BMAD Method, factory gets that from structure, not sampling:
- each stage writes one artifact from a template, and the artifact is checked in code before a person sees it;
- approved artifacts are handed to later stages, and each turn runs in a fresh context;
- open questions are capped, answered and recorded;
- outcomes come from a fixed list.

A method can be written in code or brought as a folder (a pack): a `factory.yaml` with personas, templates and instructions. [docs/09](docs/09-methods-and-packs.md) explains it, and the bundled roles pack (analyst → pm → architect → story → dev → qa) is an example to copy.

## How it fits together

```
 ┌────────────┐  start / approval / cancel  ┌──────────────┐   tool calls   ┌─────────────┐
 │  factory   │◀────────────────────────────│  chat host   │───────────────▶│  sandbox    │
 │  (worker + │────────────────────────────▶│ (agent turns │  (optional)    │ (code runs) │
 │  HTTP API) │   "run stage X in thread"   │  + approvals)│                └─────────────┘
 └─────┬──────┘                             └──────────────┘
       ▼
   Temporal  ◀── dashboard reads from here
```

The framework never talks to the sandbox. The chat host is the only part that talks to both.

## Concepts in one table

| Term | Meaning |
|---|---|
| Stage | One step of work done by the agent in one turn, ending with an approval card |
| Pipeline | An ordered list of stages plus defaults (reminder, give-up time), registered under a name and version |
| Registry | Where an app registers its stages, pipelines and prompts |
| Run | One execution of the pipeline workflow for one chat thread |
| Starter / participant | The person who started the run, and the people they added. Only they may approve |
| Gate | The wait after a stage for an approval signal, with a reminder timer and a give-up timer |
| Skill | A folder of instructions (`SKILL.md` plus the files it references) the app owns and attaches to stages; its text is prepended to the stage prompt |
| Hook | Event hooks (`registry.on("stage.approved", handler)`) for side effects at fixed points; decision hooks (`skip`, `next`) for the path |
| Artifact | The document a stage produces from a template; checked, frozen on approval, committed, passed to later stages |
| Persona | Who the agent is in a stage: one Markdown file (a Hermes `SOUL.md` or a BMAD agent file works as is) |
| Pack | A method as a folder (`factory.yaml`, personas, templates, stage instructions, skills); its pipeline is copied into each run |

## An app in a few lines

```ts
import { createRegistry } from "@fauzanqadri/factory";

export const registry = createRegistry();

registry.stage({ name: "intake",   runsIn: "host", next: () => "triage" });
registry.stage({ name: "triage",   runsIn: "host",
  next: (a) => (a.outcome && a.outcome !== "code" ? { finish: a.outcome } : "planning") });
registry.stage({ name: "planning", runsIn: "host",    next: () => "building" });
registry.stage({ name: "building", runsIn: "sandbox", next: () => "review" });
registry.stage({ name: "review",   runsIn: "sandbox", next: () => ({ finish: "done" }) });

registry.pipeline({
  name: "ticket", version: 1,
  stages: ["intake", "triage", "planning", "building", "review"],
  defaults: { remindAfter: "24h", gateTimeout: "7d" },
});

registry.prompt("triage", (ctx) => `Triage ${ctx.ticketRef ?? "the request"}. End with an approval card.`);

registry.on("stage.approved", async (e) => tracker.addLabel(e.ticketRef, `approved:${e.stage}`));
```

[docs/07-building-an-app.md](docs/07-building-an-app.md) covers the worker entry point and deployment.

## Documents

| File | Question it answers |
|---|---|
| [01-concepts.md](docs/01-concepts.md) | What a stage, pipeline, gate and run are, and who does what (framework, app, chat host, sandbox) |
| [02-registry.md](docs/02-registry.md) | How an app registers stages, pipelines, prompts and hooks; versioning and determinism rules |
| [03-engine.md](docs/03-engine.md) | What one run looks like inside Temporal, step by step, with failure cases |
| [04-http-contract.md](docs/04-http-contract.md) | The calls between the chat host and the framework, with auth and idempotency |
| [05-chat-host.md](docs/05-chat-host.md) | What a chat host must provide (starter, participants, approval cards, turn injection) and how slaude does it |
| [06-dashboard.md](docs/06-dashboard.md) | The monitoring page |
| [07-building-an-app.md](docs/07-building-an-app.md) | How an app repo uses the framework, from registry to running worker |
| [08-status-and-notes.md](docs/08-status-and-notes.md) | Where the work stopped: unpublished branches, the loop fix, the method layer, and the Claude Code decision |
| [09-methods-and-packs.md](docs/09-methods-and-packs.md) | Why runs varied, and how artifacts, templates, personas, checklists and packs make them consistent; the pack format and the roles pack |

## Repo layout

```
src/
  types.ts       stage, pipeline, approval and run types
  registry.ts    createRegistry(): stages, pipelines, prompts, hooks
  hooks.ts       dispatchEvent(): runs event hooks, required first
  workflow.ts    makePipelineWorkflow(): the Temporal workflow (import from "@fauzanqadri/factory/workflow")
  activities.ts  makeActivities(): runStage, emit, remind, finish, commit (calls the chat host)
  artifacts.ts   checkArtifact(), routeNext(), contractOf(): template checks and pack routing (pure)
  assemble.ts    assemblePrompt(), sha256Hex(): the stage prompt in a fixed order (pure)
  render-skills.ts  renderSkills(): the skills text prepended to a stage's prompt
  skills.ts      loadSkills(), writeLock(): reads and checks skills, personas and templates (node-only, exported from "@fauzanqadri/factory/server")
  packs.ts       loadPack(): reads a factory.yaml folder into pipeline snapshots (node-only)
  server.ts      createApi() and startFactory(): HTTP API + worker in one process; rolesPack
  index.ts       public exports; sandbox-safe, so an app's registry can import from it
packs/roles/     the bundled roles pack (factory.yaml, personas, templates, stages)
test/
  registry.test.ts, hooks.test.ts, activities.test.ts, server.test.ts, skills.test.ts, artifacts.test.ts, packs.test.ts
  workflow.test.ts   the engine against the time-skipping test server
  bundle.test.ts     a workflows file importing from the package root bundles (no node:* reachable)
  fixtures/          a sample registry and workflows files, skill folders
docs/            design (above), diagrams in docs/diagrams
```

## Development

```sh
npm install
npm test
npm run typecheck
```
