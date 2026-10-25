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
