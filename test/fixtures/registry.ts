import { createRegistry } from "../../src/registry";

export const registry = createRegistry();
const defaults = { remindAfter: "1h", gateTimeout: "3h" };

registry.stage({ name: "intake", runsIn: "host", next: () => "triage" });
registry.stage({
  name: "triage", runsIn: "host",
  next: (a) => (a.outcome && a.outcome !== "code" ? { finish: a.outcome } : "planning"),
});
registry.stage({ name: "planning", runsIn: "host", skip: (ctx) => ctx.ticketRef?.startsWith("HOTFIX-") ?? false, next: () => "building" });
registry.stage({ name: "building", runsIn: "sandbox", next: () => ({ finish: "done" }) });
for (const s of ["intake", "triage", "planning", "building"]) registry.prompt(s, (i) => `${i.stage}#${i.attempt}${i.note ? ` note=${i.note}` : ""}`);

registry.pipeline({ name: "ticket", version: 1, stages: ["intake", "triage", "planning", "building"], defaults });
registry.pipeline({ name: "support", version: 1, stages: ["intake", "triage"], defaults });

// A pipeline that loops: review can send the run back to draft.
registry.stage({ name: "draft", runsIn: "host", next: () => "review" });
registry.stage({ name: "review", runsIn: "host", next: (a) => (a.outcome === "revise" ? "draft" : { finish: "done" }) });
for (const s of ["draft", "review"]) registry.prompt(s, (i) => `${i.stage}#${i.attempt}${i.note ? ` note=${i.note}` : ""}`);
registry.pipeline({ name: "loop", version: 1, stages: ["draft", "review"], defaults });

// A method pipeline in code: specify produces a spec, plan reads it; plan's outcome "redo" sends the
// run back to specify. Templates and personas are only declared here (the registry does no I/O).
registry.persona("writer", { path: "personas/writer.md" });
registry.template("spec", { path: "templates/spec.md" });
registry.template("plan", { path: "templates/plan.md" });
registry.stage({ name: "specify", runsIn: "host", persona: "writer", produces: { artifact: "spec", template: "spec", commit: "docs/{runId}/spec-{seq}.md" }, next: () => "plan" });
registry.stage({
  name: "plan", runsIn: "host", reads: ["spec"], outcomes: ["ok", "redo"], produces: { artifact: "plan", template: "plan" },
  next: (a, _ctx, artifacts) => (a.outcome === "redo" ? "specify" : { finish: `done:${artifacts.spec?.seq}` }),
});
for (const s of ["specify", "plan"]) registry.prompt(s, (i) => `${i.stage}#${i.attempt}`);
registry.pipeline({ name: "spec", version: 1, stages: ["specify", "plan"], defaults });
