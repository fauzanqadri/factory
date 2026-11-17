# 05. What a chat host provides

The chat host is where people and the agent meet. It owns the conversation, and factory owns the lifecycle. A host needs six things. The reference host is [slaude](https://github.com/barockok/slaude), a Slack-hosted Claude agent runtime. Support for factory is planned behind a feature flag; this document lists what it adds.

| Capability | What it means | In slaude |
|---|---|---|
| Start a run | A command such as `/workflow start <ticket or text>`, and a tool the agent can call when it recognises a request. Whoever triggered it is the starter | `/workflow start`, `start_workflow` tool, `workflow_threads` table |
| Participants | `/participant add|remove|list @user`. Only the starter (and the host's admins) may add or remove | `workflow_participants` table |
| Approval cards | The agent ends each stage with a card (Approve / Reject, plus a note or outcome). The card carries the stage and the attempt it was posted for, and sends both with the approval. A click from anyone who is not the starter or a participant is refused. For a stage with an artifact, the card shows the artifact, the checklist answers and any open questions; with open questions it asks for answers instead of offering approve. A `409` or `422` from factory is shown on the card | `request_stage_approval` tool; a button handler that checks the clicker, calls `POST /runs/:id/approvals`, then rewrites the card |
| Turn injection | The callback API in [04-http-contract.md](04-http-contract.md): run a stage, remind, finish, commit | `/workflow/v1/*` routes, bearer `FACTORY_CALLBACK_TOKEN` |
| Fresh context (method stages) | A turn with `context: "fresh"` runs in a new agent context holding only factory's prompt: no thread history, no host persona, no persistent memory, no self-written skills | A subagent or a new session per stage turn |
| Submit tool (method stages) | When the turn names an `artifact`, the agent submits it through a tool that posts to `POST /runs/:id/artifacts` and hands a `422`'s problems back to the agent | A `submit_artifact` tool with the stage's checklist and outcomes in its description |
| Commit | `POST /workflow/v1/runs/:id/commit` writes an approved artifact into the run's repo and commits it | Through the sandbox, on the run's branch; `{ skipped }` when the run has no sandbox |
| Thread context | The agent knows the run, its stage and the rules (end with a card; do not start the next stage on its own) | A `<workflow>` block in the system prompt |
| Sandbox switch (optional) | Stages marked `runsIn: "sandbox"` move the thread's tools into an isolated sandbox | `enter_sandbox` tool and `/sandbox on`, backed by a sandbox MCP server |

## Approval is its own permission

An approval card for a stage is not a tool permission prompt and not an admin approval. Its approver set is exactly the run's starter plus participants. Hosts often let anyone click a button they can see, so the check on the clicker must run before anything else happens.

## Feature flags

A host should be able to turn the integration off without removing its configuration.

| Flag | Off means |
|---|---|
| Workflows (`SLAUDE_WORKFLOW` in slaude) | The commands reply "not enabled", the tools are not offered, the callback routes return 404 |
| Sandbox (`SLAUDE_SANDBOX` in slaude) | No connection to the sandbox server even when its URL is configured |

## Why fresh context is required

A method stage's prompt already holds everything the agent needs: the persona, the instructions, the approved artifacts, the clarifications and the feedback ([09](09-methods-and-packs.md)). Anything else the host adds makes two runs of the same request see different inputs, and get different results:
- the thread's history (side chatter, rejected drafts);
- the host's own persona;
- memory from earlier sessions;
- skills the agent wrote for itself.

So the contract requires a fresh context. The thread stays where people read and approve the work.

## Other agent runtimes

Any runtime that provides the capabilities above can be the host. For example, a Hermes Agent adapter would:
- start each stage turn as a fresh session or subagent, with the stage's persona in place of the user's `SOUL.md`;
- turn off persistent memory and self-written skills for that session;
- expose the submit tool;
- implement the callback routes, including commit;
- post cards on whichever messaging platform the thread lives on.

The adapter belongs in the runtime or its own repo, not here.

