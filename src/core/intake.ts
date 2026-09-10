import type { FactoryRequest } from "../../contracts/interfaces.js";

export function validateRequestShape(input: FactoryRequest): void {
  if (!input.idempotency_key) throw new Error("missing idempotency_key");
  if (!input.tenant_id) throw new Error("missing tenant_id");
  if (!input.repository_id) throw new Error("missing repository_id");
  if (!input.parent_git_sha || input.parent_git_sha.length !== 40) {
    throw new Error("invalid parent_git_sha");
  }
}
