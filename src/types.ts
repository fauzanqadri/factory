/** A Temporal duration: milliseconds, or an `ms`-style string such as "24h" or "7d". */
export type Duration = number | string;

export type StageName = string;

/** Why a run ended. `done` and `cancelled` are built in; an app adds its own outcomes. */
export type FinishReason = "done" | "cancelled" | (string & {});

/** What follows an approved stage: another stage, or the end of the run. */
export type Next = StageName | { finish: FinishReason };

/** Where the agent works during a stage. The chat host decides what "sandbox" means. */
export type RunsIn = "host" | "sandbox";

/** An approval as it reaches the workflow (signal). */
export interface Approval {
  /** Unique per approval card; a repeated gateId is ignored. */
  gateId: string;
  stage: StageName;
  decision: "approve" | "reject";
  /** Chat user id of the starter or participant who clicked. */
  by: string;
  /** Set by a stage that classifies the work (e.g. triage) to steer `next`. */
  outcome?: string;
  /** Reason given with a rejection; passed into the stage's next attempt. */
  note?: string;
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

export interface StageDef {
  name: StageName;
  runsIn: RunsIn;
  /** Overrides the pipeline default for this stage's gate. */
  remindAfter?: Duration;
  gateTimeout?: Duration;
  /**
   * Decides what follows an approval. Runs inside the Temporal workflow, so it
   * must be deterministic: no clock, randomness, I/O or environment reads.
   */
  next(approval: Approval, ctx: RunContext): Next;
}

export interface PipelineDef {
  name: string;
  /** Pinned into each run at start. Change order or `next` logic by adding a version, never by editing one. */
  version: number;
  /** Stages a run may visit; the first is where it starts. */
  stages: StageName[];
  defaults: { remindAfter: Duration; gateTimeout: Duration };
}

export interface PromptInput extends RunContext {
  stage: StageName;
  attempt: number;
  /** The rejection note when this attempt follows a reject. */
  note?: string;
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
  history: Array<{ stage: StageName; attempt: number; decision: "approve" | "reject"; by: string; at: string; note?: string; outcome?: string }>;
}
