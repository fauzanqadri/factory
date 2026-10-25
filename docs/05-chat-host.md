# 05. What a chat host provides

The chat host is where people and the agent meet. It owns the conversation, and factory owns the lifecycle. A host needs six things. The reference host is [slaude](https://github.com/barockok/slaude), a Slack-hosted Claude agent runtime. Support for factory is planned behind a feature flag; this document lists what it adds.

| Capability | What it means | In slaude |
|---|---|---|
| Start a run | A command such as `/workflow start <ticket or text>`, and a tool the agent can call when it recognises a request. Whoever triggered it is the starter | `/workflow start`, `start_workflow` tool, `workflow_threads` table |
| Participants | `/participant add|remove|list @user`. Only the starter (and the host's admins) may add or remove | `workflow_participants` table |
| Approval cards | The agent ends each stage with a card (Approve / Reject, plus a note or outcome). A click from anyone who is not the starter or a participant is refused | `request_stage_approval` tool; a button handler that checks the clicker, calls `POST /runs/:id/approvals`, then rewrites the card |
| Turn injection | The callback API in [04-http-contract.md](04-http-contract.md): run a stage, remind, finish | `/workflow/v1/*` routes, bearer `FACTORY_CALLBACK_TOKEN` |
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
