export interface LeaseState {
  runId: string;
  fencingToken: number;
  expiresAtIso: string;
}

export function assertLeaseFresh(lease: LeaseState, nowIso: string): void {
  if (new Date(lease.expiresAtIso).getTime() <= new Date(nowIso).getTime()) {
    throw new Error("lease expired");
  }
}
