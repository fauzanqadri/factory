# 09. Methods: artifacts, personas and packs

Status: implemented (`src/artifacts.ts`, `src/assemble.ts`, `src/packs.ts`, `packs/roles/`), tested in `test/artifacts.test.ts`, `test/packs.test.ts` and the "method layer" tests of `workflow.test.ts`, `server.test.ts` and `activities.test.ts`.

## Why

Two runs started with the same request used to end differently. The Temporal engine was never the cause: given the same approvals it always takes the same path. The variation came from the agent turn, which factory did not control:

| Cause | Effect |
|---|---|
| A stage turn was injected into the chat thread | The agent's context was the whole thread: side chatter, rejected drafts, whatever the host's compaction kept |
| A stage produced nothing factory kept | No artifact, no template, no check: the agent chose the format and the scope each time |
| `outcome` was an unchecked string | `"Code"` instead of `"code"` sent a run down another path |
| Only the last rejection note reached the prompt | A loop back carried no reason at all |
| Nothing recorded what produced a turn | Two runs could not be compared |

The sampling knob is not an answer: current Claude models reject `temperature`, `top_p` and `top_k`, and even when they existed, 0 did not give identical output. GitHub Spec Kit and the BMAD Method get consistent results without them, from structure:
- every step runs in a **fresh context**: Spec Kit runs each step as its own headless process, BMAD hands a subagent a spec that is "its sole source of truth";
- **named artifacts** are passed forward;
- **templates** have mandatory sections;
- **ambiguity is capped and recorded**: at most 3 `[NEEDS CLARIFICATION]` markers, and nothing leaves draft while a question is open;
- a **checklist runs before handoff**;
- **roles** have scoped jobs, and **project rules** apply to every step.

factory adopts all of this. Because its gates and routing are code, it enforces in code what those methods ask for in prose; Spec Kit, for example, has no script that checks for leftover clarification markers.

## What becomes deterministic

| Level | How | Guarantee |
|---|---|---|
| **Path** | Allowed `outcomes`, checked at the API; pack routing tables are data | Full: the same approvals give the same stages and finish |
| **Shape** | Template sections, placeholders, checklist and size, checked in code before a person sees the artifact | Full |
| **Context** | The prompt is assembled from approved artifacts, clarifications and feedback only, and the host runs it in a fresh context | Full on factory's side; the host must honour `context: "fresh"` ([05](05-chat-host.md)) |
| **Definition** | A pack pipeline is copied into the run at start (a snapshot) | Full: a run replays the definition it started with |
| **Content** | All of the above narrow it; each turn's fingerprint (prompt hash, file hashes, model, effort) makes it measurable | Statistical: the model still samples |

## The building blocks

A stage uses the method layer when it has `produces`, `persona`, `reads`, or (pack stages) instructions. Such a stage:
- **produces one artifact** (`produces: { artifact, template, commit? }`): a Markdown document written from a template;
- **reads** the latest approved version of earlier artifacts (`reads: [...]`);
- has a **persona**: one Markdown file saying who the agent is in this stage. A Hermes `SOUL.md`, a BMAD agent file or plain text all work;
- may have a **checklist** the agent answers pass or fail (with a note for a fail) when it submits;
- may list its **outcomes**: an approval or artifact with any other outcome is refused;
- caps **clarifications** (`clarify: { max }`, default 3);
- may set **effort**, which is advisory like `model`;
- gets the pipeline's **project rules** (`PipelineDef.skills`, or `rules:` in a pack): skills applied to every stage.

### The prompt

The prompt is built in a fixed order, so the same run state always gives the same prompt (`assemblePrompt`):

1. project rules
2. the persona
3. the stage's skills
4. the stage's instructions (a `registry.prompt` function, or a pack's `stages/<name>.md`)
5. the request
6. approved inputs (each in an `<artifact>` block)
7. clarifications so far
8. feedback: every rejection of this stage, and every time a later stage sent the run back here, with the note and outcome
9. the output contract: the template, the clarification rule, the checklist, the outcomes, and "submit with the tool"

Its sha256 is sent to the host as `promptHash` and recorded in `RunState.turns`. Stages that do not use the method layer keep the earlier prompt shape exactly.

### The checks

`POST /runs/:id/artifacts` runs `checkArtifact` against the run's own contract (`RunState.contract`):

| Check | Fails when |
|---|---|
| Mandatory sections | A heading marked `*(mandatory)*` in the template is missing, or it and its sub-sections are empty |
| Guidance | A `<!-- comment -->` from the template is still in the artifact |
| Placeholders | `[ALL_CAPS]` or `{{name}}` tokens are left |
| Clarifications | More `[NEEDS CLARIFICATION: …]` markers than `clarify.max` |
| Checklist | An item is unanswered, or fails without a note |
| Outcome | It is not in `outcomes`, or it is missing when the stage needs one |
| Size | Over 64 KB: long material (code, logs) belongs in the repo, linked |
| App check | A code stage's `check(submission)` returns problems |

A failure returns `422` with every problem; the host hands them to the agent, which fixes them in the same turn. A person never sees an artifact that fails its contract.

### The gate

1. The agent submits. A valid artifact becomes the run's **candidate** for this attempt. A later submission in the same turn replaces it; one for an earlier attempt is ignored.
2. The person then has three choices:
   - **answer**: when the artifact has open questions, it cannot be approved. The answers go into the run's clarifications (and every later prompt), and the stage runs again.
   - **reject** with a note: the stage runs again, with every note so far in its feedback.
   - **approve**: the candidate is frozen as a new version (`seq` 1, 2, …). If `produces.commit` is set, factory asks the host to commit it (`docs/factory/{runId}/prd.md`; `{runId}`, `{artifact}`, `{stage}`, `{seq}` are filled in), and the commit's sha is recorded. Then routing picks the next stage.

## Two ways to define a method

### In code

```ts
registry.persona("pm", { path: "personas/pm.md" });
registry.template("prd", { path: "templates/prd.md" });
registry.skill("house-rules", { path: "skills/house-rules" });
registry.stage({
  name: "pm", runsIn: "host", persona: "pm", effort: "high",
  reads: ["brief"],
  produces: { artifact: "prd", template: "prd", commit: "docs/factory/{runId}/prd.md" },
  checklist: ["Every FR has an ID and can be tested"],
  outcomes: ["ok", "needs-research"],
  next: (a, ctx, artifacts) => (a.outcome === "needs-research" ? "research" : "architect"),
});
registry.prompt("pm", () => "Write the PRD from the approved brief.");
registry.pipeline({ name: "plan", version: 1, stages: ["analyst", "pm", "architect", "research"], skills: ["house-rules"], defaults });
```

Personas and templates load at worker start with the same safety as skills (inside the app root or the package, no symlinks, size caps), and their hashes go into `skills.lock.json`.

### As a pack (no TypeScript)

A pack is a folder:

```
my-method/
  factory.yaml          pipelines, stages, routing, project rules
  personas/<name>.md    who the agent is in a stage
  templates/<name>.md   artifact templates
  stages/<name>.md      step-by-step instructions, with {{request}}-style placeholders
  skills/<name>/SKILL.md
```

```ts
import { rolesPack, startFactory } from "@fauzanqadri/factory/server";
await startFactory({ ..., packs: [rolesPack, "methods/my-method"] });
```

`factory.yaml`:

```yaml
name: my-method                # namespace: files are referred to as my-method/<name>
description: ...
pin: record                    # or strict (below)
rules: [house-rules]           # skills/<name>, applied to every stage

pipelines:                     # optional: default is one pipeline named after the pack, stages in file order
  - name: my-method
    version: 1
    stages: [plan, build]
    defaults: { remindAfter: 24h, gateTimeout: 7d }

stages:
  plan:
    runsIn: host               # or sandbox
    persona: planner           # personas/planner.md
    instructions: plan         # stages/plan.md (default: the stage name)
    skills: [estimation]
    effort: high
    model: some-model
    reads: [brief]
    produces: { artifact: plan, template: plan, commit: "docs/{runId}/plan.md" }  # template defaults to the artifact name
    checklist: [Every step has an owner]
    clarify: { max: 2 }
    next: build                # a stage, { finish: reason }, or a table by outcome:
  build:
    runsIn: sandbox
    next:
      shipped: { finish: done }
      blocked: plan
      "*": plan                # any other outcome, or none
```

Routing rules:
- `next: <stage>` and `next: { finish: <reason> }` route every outcome.
- A table routes by outcome. Without `outcomes:`, the table's keys are the outcomes. Without a `"*"` route, an outcome is required, so a run can never stop for lack of one.
- Every declared outcome must have a route (or `"*"`), and every route must target a stage in the pipeline.

The loader reports every problem at once and refuses to start: a missing file, an unrouted outcome, a `reads` that no stage produces, a checklist with nothing to answer it, an over-budget stage.

### Snapshots and pinning

`POST /runs` copies a pack pipeline into the run as a `PipelineSnapshot`: the stages and routing as data, the project rules, and the hash of every file the pipeline uses (`pins`). The workflow routes from that copy. So:
- editing a pack never breaks a running run, and needs no version bump. New runs get the new definition, and `RunState.definitionHash` shows which one a run has;
- personas, templates and instructions are read when each turn runs. If one changed since the run started, the turn's fingerprint lists it under `drift`. With `pin: strict` the turn fails instead (no retry), and the run waits at the stage.

### Overlays

To change a shipped pack without copying it, layer a folder over it:

```ts
packs: [{ dir: rolesPack, overlays: ["methods/roles-local"] }]
```

Files in the overlay replace the pack's files of the same path (`templates/prd.md`, `skills/<name>/`). Its optional `factory.yaml` merges over the pack's: fields per stage, pipelines by name, and `rules`, `description` and `pin` when given.

## Bringing a method from elsewhere

| From | Becomes |
|---|---|
| A BMAD agent file | `personas/<role>.md` as is |
| A BMAD or Spec Kit template | `templates/<name>.md`; mark required headings `*(mandatory)*` |
| A BMAD workflow or Spec Kit command | `stages/<name>.md`, the numbered steps |
| A checklist file | `checklist:` items on the stage |
| Spec Kit's constitution | A skill listed in `rules:` |
| A Hermes Agent `SOUL.md` | `personas/<name>.md` as is; Hermes skills go in `skills/<name>/` (same `SKILL.md` format) |

A different agent runtime (for example Hermes Agent instead of slaude) plugs in as the chat host. [05](05-chat-host.md) lists what it must do. The part that matters most for consistency: a stage turn runs with the stage's persona in place of the runtime's own, and without the runtime's persistent memory or the skills it writes for itself. Otherwise the runtime drifts between runs, whatever factory does.

## The roles pack

`packs/roles/` (exported as `rolesPack`) is a role-based method in the same format users write, so it is also the example to copy. The wording is our own; the flow follows BMAD.

| Stage | Persona | Reads | Produces | Routes |
|---|---|---|---|---|
| `analyst` | analyst | the request | `brief` | → `pm` |
| `pm` | pm | brief | `prd` (FR/NFR IDs, stories with Given/When/Then) | → `architect` |
| `architect` | architect | brief, prd | `architecture` (components, interfaces, decisions, coverage) | → `story` |
| `story` | scrum-master | prd, architecture, the last story and QA gate | `story` (one story, quoted dev notes, progress) | `ready` → `dev`; `none-left` → finish `done` |
| `dev` (sandbox) | dev | story, QA gate | `dev-record` | → `qa` |
| `qa` (sandbox) | qa | story, dev-record, architecture | `qa-gate` | `fail` → `dev`; `pass` or `concerns` → `story` |

Artifacts are committed under `docs/factory/{runId}/` (stories, dev records and QA gates numbered by version). Add project rules with an overlay: `rules: [our-standards]` and `skills/our-standards/SKILL.md`.

## Limits

- **The model still samples.** Shape, path and context are fixed; wording varies. Use the turn fingerprints to compare runs. Measuring agreement over N runs of the same input belongs in the app or a separate tool, not this library.
- **History size.** Each turn's input carries the full text of the artifacts it reads (capped at 64 KB each). A long story loop grows the Temporal history. `continue-as-new` is not implemented yet ([08](08-status-and-notes.md)).
- **The host must cooperate.** Fresh context, the submit tool and the commit are the host's job; factory can only check what is submitted.
