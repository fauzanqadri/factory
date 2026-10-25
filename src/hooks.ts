import type { Registry } from "./registry.js";
import type { HookEvent } from "./types.js";

export interface DispatchResult {
  ran: number;
  /** Best-effort handlers that threw; logged, never rethrown. */
  failed: Array<{ index: number; error: string }>;
}

/**
 * Runs every hook registered for `event`. This is the body of the engine's emit
 * activity. Required handlers run first and a failure throws, so Temporal retries
 * the activity before any best-effort handler has run: a retry never repeats a
 * best-effort side effect that already happened. Best-effort handlers then run
 * one by one; their errors are collected and returned.
 */
export async function dispatchEvent(
  registry: Registry,
  event: HookEvent,
  log: (msg: string) => void = () => {},
): Promise<DispatchResult> {
  const all = registry.hooksFor(event.name, { stage: event.stage, pipeline: event.pipeline });
  const required = all.filter((h) => h.options.mode === "required");
  const bestEffort = all.filter((h) => h.options.mode === "best-effort");
  for (const h of required) await h.handler(event);
  const failed: DispatchResult["failed"] = [];
  for (const [i, h] of bestEffort.entries()) {
    try {
      await h.handler(event);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ index: i, error });
      log(`hook ${event.name} (${event.eventId}) failed: ${error}`);
    }
  }
  return { ran: all.length, failed };
}
