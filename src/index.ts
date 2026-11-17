// The package root. An app's registry imports createRegistry from here and is bundled into
// Temporal's workflow sandbox, so nothing reachable from this file may import node:*.
// Node-only exports (startFactory, the skills loader) live in ./server.
export { createRegistry, type Registry } from "./registry.js";
export { dispatchEvent, type DispatchResult } from "./hooks.js";
export { makeActivities, type FactoryActivities, type HostConfig } from "./activities.js";
export { renderSkills } from "./render-skills.js";
export type * from "./types.js";
