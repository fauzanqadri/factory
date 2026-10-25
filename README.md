# factory

A small framework for running work through **stages with a human approval between each one**, on top of [Temporal](https://temporal.io), driven from a chat thread where an AI agent does the work.

An app built on factory registers its stages and pipelines in a registry. The framework provides:
- the Temporal workflow that walks a pipeline;
- the approval gates and their timers;
- an HTTP API for the chat host;
- a dashboard.

The chat host (the reference is [slaude](https://github.com/barockok/slaude)) runs the agent turns and shows the approval cards.

Status: design and skeleton. The registry and types are implemented and tested. The engine, HTTP API and dashboard are specified in `docs/` and not built yet.

## Why

AI agents can take a ticket from intake to a pull request, but a team still wants a person to say "yes, go on" between the steps. Doing that inside one chat session breaks down:
- approvals wait hours or days;
- the agent's pod restarts;
- nobody can see which tickets are stuck where.

factory moves the lifecycle into a durable Temporal workflow. The chat thread keeps the conversation, the work and the approvals.

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
```

[docs/07-building-an-app.md](docs/07-building-an-app.md) covers the worker entry point and deployment.

## Documents

| File | Question it answers |
|---|---|
| [01-concepts.md](docs/01-concepts.md) | What a stage, pipeline, gate and run are, and who does what (framework, app, chat host, sandbox) |
| [02-registry.md](docs/02-registry.md) | How an app registers stages, pipelines and prompts; versioning and determinism rules |
| [03-engine.md](docs/03-engine.md) | What one run looks like inside Temporal, step by step, with failure cases |
| [04-http-contract.md](docs/04-http-contract.md) | The calls between the chat host and the framework, with auth and idempotency |
| [05-chat-host.md](docs/05-chat-host.md) | What a chat host must provide (starter, participants, approval cards, turn injection) and how slaude does it |
| [06-dashboard.md](docs/06-dashboard.md) | The monitoring page |
| [07-building-an-app.md](docs/07-building-an-app.md) | How an app repo uses the framework, from registry to running worker |

## Repo layout

```
src/
  types.ts       stage, pipeline, approval and run types
  registry.ts    createRegistry(): stages, pipelines, prompts (implemented)
  index.ts       public exports
test/
  registry.test.ts
docs/            design (above), diagrams in docs/diagrams
```

## Development

```sh
npm install
npm test
npm run typecheck
```
