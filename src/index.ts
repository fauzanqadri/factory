// The package root. An app's registry imports createRegistry from here and is bundled into
// Temporal's workflow sandbox, so nothing reachable from this file may import node:*.
// Node-only exports (startFactory, the skills and pack loaders) live in ./server.
export { createRegistry, type Registry } from "./registry.js";
export { dispatchEvent, type DispatchResult } from "./hooks.js";
export { makeActivities, type ActivityDeps, type FactoryActivities, type HostConfig, type RunStageInput } from "./activities.js";
export { renderSkills } from "./render-skills.js";
export {
  checkArtifact, contractOf, fillPath, isMethodStage, isSafeRepoPath, latestArtifacts, openQuestions, parseTemplate, routeNext,
  DEFAULT_CLARIFY_MAX, MAX_ARTIFACT_BYTES, type CheckInput, type CheckResult, type TemplateSection,
} from "./artifacts.js";
export { assemblePrompt, fillInstructions, sha256Hex, type PromptParts } from "./assemble.js";
export type * from "./types.js";
