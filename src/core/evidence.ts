import type { BoundaryEvidence } from "../../contracts/interfaces.js";

export function hasAdvisoryCollectionEvidence(events: BoundaryEvidence[]): boolean {
  return events.some((e) => e.event_type === "advisory_output_collected");
}
