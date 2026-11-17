# 08. Status and notes

A snapshot for whoever picks this project up again (written 2026-11-14, updated 2026-11-17, method layer added the same day). The other docs describe behavior; this one records where the work stopped and why.

## Where things stand

| Piece | State |
|---|---|
| Registry, hooks, workflow engine, activities, HTTP API, `startFactory` | Built and tested (`docs/01..05`, `07`) |
| Per-stage skills loader (`src/skills.ts`) and the advisory stage `model` | Built and tested; on `main` ([02](02-registry.md#skills-and-model)) |
| Loop fix: `attempt` counts a stage's turns across the run | Built and tested; on `main` ([03](03-engine.md)) |
| Method layer: artifacts, templates, personas, checklists, clarifications, allowed outcomes, project rules, turn fingerprints, commit callback | Built and tested; on `main` ([09](09-methods-and-packs.md)) |
| Workflow packs (`factory.yaml` folders, snapshots, overlays) and the roles pack | Built and tested; on `main` ([09](09-methods-and-packs.md#as-a-pack-no-typescript)) |
| Host support for method stages (fresh context, submit tool, commit) | Specified in [04](04-http-contract.md#a-method-stage-turn) and [05](05-chat-host.md); not in slaude yet. A Hermes Agent adapter is a possible second host |
| Dashboard | Specified in [06](06-dashboard.md), not built |
| A chat host in this repo | None. The reference host is slaude, and its factory support is planned ([05](05-chat-host.md)) |
| Claude Code support | Not built; see the decision below |

**Merged.** `feat/skills-loader` and `fix/loop-attempts` (stacked on it) were fast-forwarded into `main` on 2026-11-17. The branches and the `.claude/worktrees/loop-visits` worktree were then deleted.
## The loop bug (fixed)

`next()` may return any stage in the pipeline, including an earlier one, so a pipeline can loop (review sends the run back to draft). `attempt` used to restart at 1 on every visit, so the second visit reused the first visit's turn `requestId` and hook `eventId`. The chat host drops a repeated `requestId` as a Temporal retry, so the revisit never ran a turn, and a card from the first visit was accepted as current. `attempt` is now counted per stage across the whole run. Runs that never loop behave exactly as before.

Still open: the workflow has no `continue-as-new`, so a very long loop could hit Temporal's history size limit. The method layer makes this more pressing: each turn's input carries the full text of the artifacts it reads (up to 64 KB each), so a long story → dev → qa loop in the roles pack grows the history faster. Continue-as-new would carry `artifacts`, `clarifications`, the feedback log and the attempt counters across.

## Why the method layer (2026-11-17)

Runs gave different results for the same request. The engine was deterministic, but the agent's context was the chat thread, a stage produced nothing factory checked, outcomes were free strings, and feedback was lost. The research (GitHub Spec Kit `main`, BMAD Method v6.12/v7 alpha, Hermes Agent) found that those methods get consistent results from structure, not sampling: a fresh context per step, named artifacts, templates, capped clarifications, checklists, roles. Current Claude models no longer accept `temperature`. [09](09-methods-and-packs.md) records the design. Decisions taken:
- artifacts live in the run (factory is no longer stateless about content) and are committed to the repo on approval;
- fresh context is required of the host for method stages;
- methods are bring-your-own (packs), and the roles pack is one example;
- measuring agreement over N runs stays out of the library.

## Claude Code: decision and options

**Conclusion.** factory (Temporal, the HTTP API, the chat-host callbacks) solves a problem that only exists when the agent runs on a server and the people are elsewhere. In Claude Code the agent and the person share a machine and a session, and the workflow does no work of its own: it only holds state (stage, attempt, history), waits at gates and calls `next()`. A state file does that job locally, so Claude Code should not go through Temporal.

**Why a skill alone is not enough for the existing engine.** The workflow pushes each stage by POSTing the prompt to `{host}/workflow/v1/turns`, and `remind` and `finish` use the same callback API. Claude Code cannot accept inbound HTTP, so something would have to answer those calls and queue them. A small bridge CLI was sketched for that and deliberately **not** built: with local state, it is unnecessary machinery.

**The plan to revisit** (a local runner, not the bridge):
- A small local CLI loads the app's registry and keeps one JSON file per run (for example `.factory/runs/<id>.json`) with the same shape as `RunState`.
- `start`, `current` (prints the stage prompt, reusing `registry.getPrompt` and the skills text, and applying `skip`), `approve [--outcome]`, `reject --note`, `state`. Event hooks can still fire from the CLI.
- A Claude Code skill drives the loop: run `current`, do the work, ask the person with `AskUserQuestion`, then `approve` or `reject`. The state is on disk, so closing the session loses nothing and a resume is just `current` again.
- Reminders and give-up timers reduce to a stored `waitingSince` checked at resume.

**Open decision.** Is it one pipeline definition that runs in both Slack (Temporal) and Claude Code, or is Claude Code a separate use?
- *Shared registry, different runner:* define stages, `next`, prompts and skills once; Temporal and the local runner both execute them. The transition logic lives in `src/workflow.ts` (replay rules apply). Start by writing the local runner separately, then extract a pure `step(state, approval)` both can call once the semantics settle.
- *Skill only:* the pipeline is a Markdown skill, Claude keeps `.factory/state.json` itself, and approval is `AskUserQuestion`. Cheapest, but routing, `skip` rules and hooks become prose rather than enforced logic.

Longer term this points at splitting the package into a core state machine plus separate Temporal and local runners.
