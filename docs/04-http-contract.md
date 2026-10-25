# 04. HTTP contract

Status: specified, not built.

Two directions, each with its own bearer token. The framework never calls the sandbox.

## Chat host to factory (the factory API)

Bearer: `FACTORY_API_TOKEN`.

| Call | Body | Result |
|---|---|---|
| `POST /runs` | `StartRun`: `pipeline, pipelineVersion?, channelId, threadTs, sessionId, starter, ticketRef?, request` | `201 { runId }`. `409` when the thread already has a running run. `422` for an unknown pipeline |
| `POST /runs/:runId/approvals` | `Approval`: `gateId, stage, decision, by, outcome?, note?` | `202`. Idempotent on `gateId` |
| `POST /runs/:runId/cancel` | `{ by }` | `202` |
| `GET /runs/:runId` | | `RunState` (the `state` query) |
| `GET /healthz` | | `200`, no auth |

`pipelineVersion` defaults to the latest registered version at start, and is then pinned for the run.

## factory to chat host (the host's callback API)

Bearer: `FACTORY_CALLBACK_TOKEN`, at least 32 characters. The host should mount these only where it handles chat, and return `404` when the token is not configured.

| Call | Body | Host must |
|---|---|---|
| `POST {host}/workflow/v1/turns` | `{ runId, stage, attempt, prompt, requestId }` | Inject `prompt` as a turn in the run's thread, record `stage`, and return `200`. A repeated `requestId` returns `200` without a second turn |
| `POST {host}/workflow/v1/runs/:runId/remind` | `{ stage, waitingSince }` | Post a short nudge in the thread |
| `POST {host}/workflow/v1/runs/:runId/finish` | `{ reason }` | Post a closing line, mark the run finished |

## Rules

- **The approval check belongs to the host.** factory trusts that `by` was checked against the run's starter and participants before the call.
- **Signal before resolving the card.** The host sends the approval to factory first and only then marks its card decided. If the call fails, the card stays clickable, so an approval is never recorded on the card but lost to the run.
- **All calls time out in 15 s** and are retried by the caller. Every call is idempotent: on `gateId`, `requestId`, or the run's own state.
