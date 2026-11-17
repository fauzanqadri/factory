# 04. HTTP contract

Status: implemented. The factory API is `createApi` in `src/server.ts`; the callbacks are called by `src/activities.ts`.

Two directions, each with its own bearer token. The framework never calls the sandbox.

## Chat host to factory (the factory API)

Bearer: `FACTORY_API_TOKEN`.

| Call | Body | Result |
|---|---|---|
| `POST /runs` | `StartRun`: `pipeline, pipelineVersion?, channelId, threadTs, sessionId, starter, ticketRef?, request` | `201 { runId, pipeline, pipelineVersion, definitionHash? }`. `400` for a missing field. `409` when the thread already has a running run. `422` for an unknown pipeline or version. For a pack pipeline the run gets a copy of its definition, and `definitionHash` identifies it ([09](09-methods-and-packs.md#snapshots-and-pinning)) |
| `POST /runs/:runId/artifacts` | `{ stage, attempt, content, outcome?, checklist?: [{ item, pass, note? }] }` | The agent's submit tool calls this. `202 { hash, questions, approvable }` when the artifact meets its stage's contract. `422 { problems }` when it does not: give the problems back to the agent to fix in the same turn. `409` when the run is not at that stage and attempt, or the stage produces no artifact. `400` for a malformed body |
| `GET /runs/:runId/artifacts` | | `{ artifacts, candidate }`: every approved version in order, and the artifact waiting at the gate |
| `GET /runs/:runId/artifacts/:name[?seq=n]` | | The latest approved version of that artifact (or version `n`); `404` if none |
| `POST /runs/:runId/approvals` | `Approval`: `gateId, stage, attempt?, decision (approve \| reject \| answer), by, outcome?, note?, answers?` | `202`. `404` for an unknown run. Idempotent on `gateId`. When `attempt` is set, a card from an earlier attempt is ignored, so send it. For the stage and attempt the run is at: `422` for an outcome outside the stage's `outcomes`, or a missing one the stage requires; `409` to approve before an artifact was submitted, or while it has open questions; `answer` needs one non-empty answer per open question (`400` otherwise) |
| `POST /runs/:runId/cancel` | `{ by }` | `202` |
| `GET /runs/:runId` | | `RunState` (the `state` query), including the current stage's `contract`, the `candidate`, approved `artifacts`, `clarifications` and per-turn fingerprints (`turns`) |
| `GET /healthz` | | `200`, no auth |

`pipelineVersion` defaults to the latest registered version at start, and is then pinned for the run.

## factory to chat host (the host's callback API)

Bearer: `FACTORY_CALLBACK_TOKEN`, at least 32 characters. The host should mount these only where it handles chat, and return `404` when the token is not configured.

| Call | Body | Host must |
|---|---|---|
| `POST {host}/workflow/v1/turns` | `{ runId, stage, attempt, prompt, requestId, model?, effort?, context?, promptHash?, artifact? }` | Run `prompt` as a turn for the run, record `stage`, and return `200`. A repeated `requestId` returns `200` without a second turn. `prompt` already includes the text of the stage's skills ([02](02-registry.md#skills-and-model)). `model` and `effort` are advisory: use them if the host can, ignore them otherwise. With `context: "fresh"` (a method stage), see below |
| `POST {host}/workflow/v1/runs/:runId/remind` | `{ stage, waitingSince }` | Post a short nudge in the thread |
| `POST {host}/workflow/v1/runs/:runId/finish` | `{ reason }` | Post a closing line, mark the run finished |
| `POST {host}/workflow/v1/runs/:runId/commit` | `{ requestId, path, content, message }` | Write `content` to `path` in the run's repo and commit it with `message`. Return `200 { sha }`, or `200 { skipped: "<why>" }` when the run has no repo. Idempotent on `requestId`: a repeat returns the first result. factory only sends relative paths without `..` (checked at load and before the call), and the host should still keep the write inside the repo |

### A method-stage turn

A turn with `context: "fresh"` comes from a stage that uses the method layer ([09](09-methods-and-packs.md)). Its prompt is self-contained, and the host must:
1. **Run it in a fresh agent context.** The context holds only `prompt`: no thread history, no host persona, no persistent memory, no skills the agent wrote for itself. Post the work in the thread for people, but do not feed the thread back in.
2. **Offer a submit tool** when `artifact` is present (`{ name, checklist?, outcomes?, outcomeRequired? }`). The tool takes `{ content, outcome?, checklist: [{ item, pass, note? }] }` and posts it to `POST /runs/:runId/artifacts` with the turn's `stage` and `attempt`. On `422`, it returns the problems to the agent as the tool's error, so the agent fixes them in the same turn.
3. **Show the artifact on the approval card**, with the checklist answers and any open questions. When there are questions, the card asks for answers (`decision: "answer"`) instead of offering approve.

`promptHash` is the sha256 of `prompt`, for the host's logs.

## Rules

- **The approval check belongs to the host.** factory trusts that `by` was checked against the run's starter and participants before the call.
- **Signal before resolving the card.** The host sends the approval to factory first and only then marks its card decided. If the call fails (including a `409` or `422`), the card stays clickable and shows the reason, so an approval is never recorded on the card but lost to the run.
- **All calls time out in 15 s** and are retried by the caller. Every call is idempotent: on `gateId`, `requestId`, or the run's own state. A repeated artifact submission replaces the candidate with the same content.
