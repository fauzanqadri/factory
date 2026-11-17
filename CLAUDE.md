# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@fauzanqadri/factory`: a library for running work through stages with a human approval gate between each one, as a durable Temporal workflow driven from a chat thread (the chat host, e.g. slaude, runs agent turns and approval cards). Apps built on it register stages, pipelines, prompts, hooks and skills in a registry. The dashboard (`docs/06-dashboard.md`) is specified but not built.

## Commands

```
npm run build        # tsc -> dist/ (also runs on `npm install` via `prepare`, so git installs get dist)
npm run typecheck    # tsc --noEmit; tsconfig includes only src/, so test/ is not typechecked
npm test             # vitest run
npx vitest run test/workflow.test.ts            # one file
npx vitest run -t "name fragment"               # one test by name
```

Node >= 22, ESM (`"type": "module"`, NodeNext): relative imports in `src/` must use the `.js` extension. Tests import `../src/x` without an extension (vitest resolves them). No linter is configured.

## Tests

Tests run serially (`fileParallelism: false`) with long timeouts because `test/workflow.test.ts` boots Temporal's time-skipping test server (`@temporalio/testing`), which may download a binary on first run. Vitest's default include also collects tests inside git worktrees under `.claude/worktrees/`, so while one exists every suite runs twice, once against the worktree's code.

- `test/fixtures/registry.ts` and `workflows.ts` are a sample app (pipelines `ticket`, `support`, and `loop`, where `review` can send the run back to `draft`). `root-workflows.ts` instead imports from the package root the way an app does, and `bundle.test.ts` bundles it to prove the root stays sandbox-safe.
- `workflow.test.ts` runs the real workflow with fake activities and checks the recorded calls and events. `server.test.ts` drives `createApi` with a fake `WorkflowClientLike`. `activities.test.ts` injects a fake `fetch`.
- `skills.test.ts` builds throwaway app dirs in the OS tmpdir and also uses `test/fixtures/skills/`.

## Architecture

Package entry points (see `exports` in package.json): `.` (`src/index.ts`: registry, hooks, activities, `renderSkills`; sandbox-safe), `./workflow` (`src/workflow.ts`), `./server` (`src/server.ts`: node-only, including the skills loader). The split matters:

- **`src/workflow.ts` runs inside Temporal's deterministic workflow sandbox.** It may import only `@temporalio/workflow`/`common`, the registry and types: no Node APIs, no I/O. Anything from `activities.js` must be `import type`. Time via `Date.now()` is Temporal's workflow time. `makePipelineWorkflow(registry)` returns the workflow function; an app re-exports it as `pipelineWorkflow` from its own workflows file (the export name is the workflow type). It walks the pipeline: for each stage it runs `runStage` (activity -> host runs the agent turn), then waits at a gate (`condition` on the approval signal) with reminder and give-up timers; reject re-runs the stage with the note, approve calls the stage's `next()` to pick the following stage (an earlier one is allowed, so pipelines can loop) or `{ finish }`. `attempt` counts a stage's turns across the whole run, not per visit, so the turn `requestId` (`<runId>:<stage>:<attempt>`) and hook `eventId` stay unique when a loop revisits a stage, and cards from the earlier visit are stale. There is no `continue-as-new` yet, so a very long loop could hit Temporal's history limit. Signals: `approval`, `cancel`; query: `state`. Duplicate approvals are dropped by `gateId`; stale-stage approvals are discarded. Workflow id is `run-<channel>-<threadTs>` (one live run per thread).
- **`src/activities.ts`** (`makeActivities`) holds all I/O: calling back to the chat host over HTTP (`runStage` -> `POST /workflow/v1/turns`, `remind`, `finish`) and `emit`, which dispatches hooks. Activities run outside the sandbox, so prompts and hook handlers can change between deploys without breaking workflow replay. A non-2xx response throws so Temporal retries. Setup mistakes (e.g. a skill that was not loaded) throw `ApplicationFailure.nonRetryable`.
- **`src/skills.ts`**: node-only loader for per-stage skills, re-exported from `./server` (`renderSkills`, which is pure, lives in `src/render-skills.ts`) (`registry.skill()` declarations, `{ path }` or `{ package }` sources). Reference-driven: only files reachable from `SKILL.md` load, with path containment, no symlinks, size/depth caps (`DEFAULT_SKILL_LIMITS`) and an optional `skills.lock.json` hash check (`writeLock` writes it). `startFactory()` loads them; `runStage` prepends their text to the prompt (no host change needed). `model` on a stage is sent as an advisory field only. Details in `docs/02-registry.md`.
- **`src/registry.ts` / `src/hooks.ts`**: registry of stages (with `next`, optional `skip` decision hook, per-stage timers), versioned pipelines (a run pins `pipelineVersion`), prompts, and event hooks (`registry.on("stage.approved", ...)`). `dispatchEvent` runs hooks: "required" ones first and a failure throws (so the activity retries before any best-effort hook has run), then best-effort ones, whose errors are logged and collected. `validate()` lists inconsistencies (unregistered stages/skills, missing prompts, bad hook filters).
- **`src/server.ts`**: `createApi` (the HTTP API the chat host calls: start run, approval, cancel, state; bearer-token auth with timing-safe compare) and `startFactory()`, which validates the registry, loads skills, and runs the Temporal worker and the API in one process. Two tokens: `FACTORY_API_TOKEN` (host -> factory) and `FACTORY_CALLBACK_TOKEN` (factory -> host, at least 32 characters). Contract is in `docs/04-http-contract.md`.
- **`src/types.ts`**: shared types for all of the above.

## Sandbox and replay rules

- Everything reachable from an app's workflows file is bundled by Temporal's webpack bundler, which fails on Node builtins. `src/registry.ts`, `src/workflow.ts` and `src/types.ts` must stay free of `node:*` imports. The registry only records skill declarations; reading files belongs in `src/skills.ts`.
- The package root (`src/index.ts`) must stay sandbox-safe too: apps import `createRegistry` from it in their bundled `registry.ts`. Webpack resolves every re-export, used or not, so one `node:*` import anywhere under the root breaks every app's bundle. Put node-only exports in `src/server.ts`. `test/bundle.test.ts` catches a regression.
- The registry must be built by static module-top-level code so every replay sees the same stages and pipelines. `next` and `skip` run inside the workflow and must be deterministic. Changing them, or a pipeline's stage list, needs a new pipeline version: re-registering an existing `name@version` throws.
- Because the workflow module is replayed, changing its control flow (new awaits, reordered activities) is a Temporal versioning concern for in-flight runs.

Design docs in `docs/01..07-*.md` are the source of truth for behavior (concepts, registry, engine, HTTP contract, chat host, dashboard, building an app). `docs/08-status-and-notes.md` is a dated snapshot of where the work stopped. It also records the decision that Claude Code support should be a local runner with a state file, not Temporal.
