/** A Temporal duration: milliseconds, or an `ms`-style string such as "24h" or "7d". */
export type Duration = number | string;

export type StageName = string;

/** Why a run ended. `done` and `cancelled` are built in; an app adds its own outcomes. */
export type FinishReason = "done" | "cancelled" | (string & {});

/** What follows an approved stage: another stage, or the end of the run. */
export type Next = StageName | { finish: FinishReason };

/** Where the agent works during a stage. The chat host decides what "sandbox" means. */
export type RunsIn = "host" | "sandbox";

/**
 * An approval as it reaches the workflow (signal).
 * `answer` replies to the open `[NEEDS CLARIFICATION]` questions of a submitted artifact:
 * the answers are recorded for the rest of the run and the stage runs again.
 */
export interface Approval {
  /** Unique per approval card; a repeated gateId is ignored. */
  gateId: string;
  stage: StageName;
  /** The attempt the card was posted for. When set, a card from an earlier attempt is ignored. */
  attempt?: number;
  decision: "approve" | "reject" | "answer";
  /** Chat user id of the starter or participant who clicked. */
  by: string;
  /** Set by a stage that classifies the work (e.g. triage) to steer `next`. Must be one of the stage's `outcomes` when it declares them. */
  outcome?: string;
  /** Reason given with a rejection; passed into the stage's next attempt. */
  note?: string;
  /** With `answer`: one answer per open question, in the order the artifact asked them. */
  answers?: string[];
}

/** How hard the model should think. Advisory, like `model`: sent to the host with each turn. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | (string & {});

/** What a stage hands to later stages: one Markdown document, written from a template. */
export interface Produces {
  /** Artifact name (e.g. `prd`). Later stages read it by this name. */
  artifact: string;
  /** Registered template name (`registry.template`, or a pack's `templates/<name>.md`). */
  template: string;
  /**
   * Repo path the host commits the approved artifact to, e.g. `docs/factory/{runId}/prd.md`.
   * `{runId}`, `{artifact}`, `{stage}` and `{seq}` are filled in. Omit to keep it only in the run.
   */
  commit?: string;
}

/**
 * The data part of a stage: everything except functions. A code registry adds `next`, `skip`
 * and `check` (StageDef); a pack stage is only this, with `route` instead of `next`.
 */
export interface StageSpec {
  name: StageName;
  runsIn: RunsIn;
  /** Overrides the pipeline default for this stage's gate. */
  remindAfter?: Duration;
  gateTimeout?: Duration;
  /** Names of skills (registered with `registry.skill`) whose text is prepended to this stage's prompt. */
  skills?: string[];
  /**
   * Model the stage should run on. Sent to the chat host as an optional `model` field in the
   * turn request; advisory until the host reads it (factory cannot enforce it).
   */
  model?: string;
  effort?: Effort;
  /** A persona (`registry.persona`, or a pack's `personas/<name>.md`): who the agent is in this stage. */
  persona?: string;
  /** The artifact this stage produces. The gate then approves that artifact, not just the turn. */
  produces?: Produces;
  /** Artifacts (by name) this stage receives: the latest approved version of each. */
  reads?: string[];
  /** Items the agent must answer pass/fail (with a note) when it submits the artifact. */
  checklist?: string[];
  /** The only outcomes an approval may carry. An outcome outside the list is refused at the API. */
  outcomes?: string[];
  /** At most `max` `[NEEDS CLARIFICATION: …]` questions per artifact (default 3). */
  clarify?: { max: number };
  /** Pack stages: what follows an approval, by outcome; `"*"` matches any outcome, including none. */
  route?: Record<string, Next>;
  /** Pack stages: the name of the instructions text (`stages/<name>.md`). Code stages use `registry.prompt`. */
  instructions?: string;
}

/** A stage registered in code: its data, plus the functions that steer the path. */
export interface StageDef extends Omit<StageSpec, "route" | "instructions"> {
  /**
   * Decision hook: true passes straight through this stage (no turn, no gate) to
   * what `next` returns for an automatic approval. Runs inside the workflow:
   * deterministic, plain data only. Changing it needs a new pipeline version.
   */
  skip?(ctx: RunContext): boolean;
  /**
   * Decides what follows an approval. Runs inside the Temporal workflow, so it
   * must be deterministic: no clock, randomness, I/O or environment reads.
   * `artifacts` holds the latest approved version of each artifact.
   */
  next(approval: Approval, ctx: RunContext, artifacts: ArtifactMap): Next;
  /** Extra checks on a submitted artifact; each string is a problem that blocks it. Runs in the API process. */
  check?(submission: ArtifactSubmission): string[];
}

/** One checklist item as the agent answered it. */
export interface ChecklistAnswer {
  item: string;
  pass: boolean;
  note?: string;
}

/** What the host posts when the agent submits a stage's artifact (`POST /runs/:id/artifacts`). */
export interface ArtifactSubmission {
  stage: StageName;
  attempt: number;
  content: string;
  outcome?: string;
  checklist?: ChecklistAnswer[];
}

/** A checked submission waiting at the gate. A later submission for the same attempt replaces it. */
export interface ArtifactCandidate {
  stage: StageName;
  attempt: number;
  artifact: string;
  content: string;
  /** sha256 of `content`. */
  hash: string;
  outcome?: string;
  checklist: ChecklistAnswer[];
  /** Open `[NEEDS CLARIFICATION]` questions. While any are open the candidate cannot be approved. */
  questions: string[];
}

/** An approved artifact version. Frozen: a later visit to the stage adds a new version. */
export interface ArtifactVersion {
  artifact: string;
  /** 1 for the first approved version of this artifact in the run, then 2, 3… */
  seq: number;
  stage: StageName;
  attempt: number;
  content: string;
  hash: string;
  outcome?: string;
  approvedBy: string;
  at: string;
  /** Set once the host committed it to the repo (`produces.commit`). */
  commit?: { path: string; sha?: string; skipped?: string };
}

/** The latest approved version of each artifact, by name. */
export type ArtifactMap = Record<string, ArtifactVersion>;

/** A question an artifact raised and the answer a person gave. Every later prompt in the run includes it. */
export interface Clarification {
  stage: StageName;
  attempt: number;
  question: string;
  answer: string;
  by: string;
}

/** Feedback a stage's prompt carries: every rejection of it, and every time a later stage sent the run back to it. */
export interface Feedback {
  kind: "rejected" | "sent-back";
  stage: StageName;
  /** The attempt that was rejected, or the attempt of the stage that sent the run back. */
  attempt: number;
  by: string;
  note?: string;
  outcome?: string;
  /** For `sent-back`: the stage whose approval routed the run back here. */
  from?: StageName;
}

/** What produced one turn, so two runs can be compared. Hashes are sha256 hex. */
export interface TurnFingerprint {
  promptHash: string;
  persona?: string;
  template?: string;
  instructions?: string;
  /** Skill name (including project rules) → content hash. */
  skills: Record<string, string>;
  model?: string;
  effort?: Effort;
  /** Pinned files (from the run's pack snapshot) whose content changed since the run started. */
  drift?: string[];
}

/** The contract of the stage a run is at: what the API checks a submission or an approval against. */
export interface StageContract {
  artifact?: string;
  template?: string;
  checklist?: string[];
  outcomes?: string[];
  /** An approval must end up with an outcome (its own or the artifact's). */
  outcomeRequired?: boolean;
  clarifyMax: number;
  /** Code stages only: the API may run the registry's `check`. */
  fromRegistry: boolean;
}

/** Facts a stage's `next` and an app's prompts may read. Plain data only. */
export interface RunContext {
  runId: string;
  pipeline: string;
  pipelineVersion: number;
  channelId: string;
  threadTs: string;
  starter: string;
  ticketRef?: string;
  request: string;
}

/** Points in a run where the workflow emits an event to registered handlers. */
export type HookEventName =
  | "run.started"
  | "stage.started"
  | "stage.skipped"
  | "stage.approved"
  | "stage.rejected"
  | "stage.clarified"
  | "gate.reminded"
  | "run.finished";

export interface HookEvent extends RunContext {
  name: HookEventName;
  /** Unique per emission (`<runId>:<name>:<stage>:<attempt>`); use it to make handlers idempotent. */
  eventId: string;
  /** ISO time the workflow emitted the event (workflow time, deterministic). */
  at: string;
  stage?: StageName;
  attempt?: number;
  approval?: Approval;
  waitingSince?: string;
  finish?: FinishReason;
  /** On `stage.approved` of a stage that produces an artifact: the frozen version (and its commit). */
  artifact?: ArtifactVersion;
}

/**
 * `best-effort` (default): errors are logged and never block the run.
 * `required`: an error fails the emit activity, Temporal retries it, and the run waits.
 */
export type HookMode = "best-effort" | "required";

export interface HookOptions {
  /** Only for these stages (default: every stage). */
  stage?: StageName | StageName[];
  /** Only for these pipelines (default: every pipeline). */
  pipeline?: string | string[];
  mode?: HookMode;
}

/** Event hook: runs in an activity, so it may do I/O. Activities run at least once: be idempotent on `eventId`. */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

export interface RegisteredHook {
  event: HookEventName;
  options: Required<Pick<HookOptions, "mode">> & Omit<HookOptions, "mode">;
  handler: HookHandler;
}

/**
 * Where a skill folder (or a persona/template file) comes from: a path under the app root, or an
 * npm package. For a package, `path` is the folder or file inside it; a skill without `path` uses
 * package.json's "skill" field (default "skill/").
 */
export type SkillSource = { path: string } | { package: string; path?: string };

/** A persona or template: one Markdown file. */
export interface TextDecl {
  kind: "persona" | "template";
  name: string;
  source: SkillSource;
}

/** A persona, template or pack instructions file after loading. */
export interface LoadedText {
  kind: "persona" | "template" | "instructions";
  name: string;
  /** sha256 of `content`. */
  hash: string;
  content: string;
}

export interface SkillOptions {
  /** Extra files (relative to the skill folder) to load although nothing references them. */
  include?: string[];
}

export interface SkillDecl {
  name: string;
  source: SkillSource;
  options: SkillOptions;
}

/** A skill after loading: SKILL.md first, then every file reachable from it. */
export interface LoadedSkill {
  name: string;
  description: string;
  /** sha256 over the sorted (path, content) pairs. */
  hash: string;
  files: Array<{ path: string; content: string }>;
}

export interface PipelineDef {
  name: string;
  /** Pinned into each run at start. Change order or `next` logic by adding a version, never by editing one. */
  version: number;
  /** Stages a run may visit; the first is where it starts. */
  stages: StageName[];
  defaults: { remindAfter: Duration; gateTimeout: Duration };
  /** Project rules: skills applied to every stage of this pipeline, before the stage's own. */
  skills?: string[];
}

/**
 * A pack pipeline as data, copied into the run when it starts. The workflow routes from this
 * copy, so a run replays exactly the definition it started with, even after the pack changes.
 */
export interface PipelineSnapshot {
  /** The pack it came from. Persona, template, instructions and skill names below are `<pack>/<name>`. */
  pack: string;
  name: string;
  version: number;
  /** sha256 over the stages, defaults, rules and pins. */
  hash: string;
  /** The pipeline's stages in order; the first is where a run starts. */
  stages: StageSpec[];
  defaults: { remindAfter: Duration; gateTimeout: Duration };
  /** Project rules: skills applied to every stage. */
  rules: string[];
  /** Content hash of every file the pipeline uses, keyed `persona:<name>`, `template:<name>`, `instructions:<name>`, `skill:<name>`. */
  pins: Record<string, string>;
  /** `record` (default): a file that changed mid-run is noted in the turn fingerprint. `strict`: the turn fails instead. */
  pin: "record" | "strict";
}

export interface PromptInput extends RunContext {
  stage: StageName;
  attempt: number;
  /** The rejection note when this attempt follows a reject. */
  note?: string;
  /** The latest approved version of each artifact the stage reads. */
  artifacts?: ArtifactMap;
  /** Every rejection of this stage in the run, and every send-back to it. */
  feedback?: Feedback[];
  /** Every question answered so far in the run. */
  clarifications?: Clarification[];
}

/** Builds the text of a stage turn. Runs in an activity, so it may change freely between deploys. */
export type PromptFn = (input: PromptInput) => string;

/** Input to start a run (what the chat host sends). */
export interface StartRun {
  pipeline: string;
  pipelineVersion?: number;
  channelId: string;
  threadTs: string;
  sessionId: string;
  starter: string;
  ticketRef?: string;
  request: string;
}

/** What the dashboard reads from a run (workflow query). */
export interface RunState {
  stage: StageName;
  attempt: number;
  status: "running" | "finished";
  finish?: FinishReason;
  /** ISO time the current gate started waiting, when waiting. */
  waitingSince?: string;
  history: Array<{ stage: StageName; attempt: number; decision: "approve" | "reject" | "answer" | "skip"; by: string; at: string; note?: string; outcome?: string }>;
  pipeline?: string;
  pipelineVersion?: number;
  /** The pack snapshot's hash, for a run started from a pack. */
  definitionHash?: string;
  /** What the current stage must produce and may be approved with. */
  contract?: StageContract;
  /** The checked artifact waiting at the current gate. */
  candidate?: ArtifactCandidate;
  /** Every approved artifact version, in order. */
  artifacts?: ArtifactVersion[];
  clarifications?: Clarification[];
  /** One entry per stage turn: what produced it. */
  turns?: Array<{ stage: StageName; attempt: number } & Partial<TurnFingerprint>>;
}
