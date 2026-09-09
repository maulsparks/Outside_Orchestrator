import { BoundaryEvidence } from "../../contracts/interfaces";

export function hasAdvisoryCollectionEvidence(events: BoundaryEvidence[]): boolean {
  return events.some((e) => e.event_type === "advisory_output_collected");
}
