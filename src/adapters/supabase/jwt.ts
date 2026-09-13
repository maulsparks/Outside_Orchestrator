import crypto from "node:crypto";

export interface MintRunJwtParams {
  runId: string;
  tenantId: string;
  workspaceId?: string;
  ttlSeconds?: number;
  secret?: string;
  projectRef?: string;
}

export interface RunJwtPayload {
  iss: string;
  ref?: string;
  aud: string;
  role: string;
  run_id: string;
  tenant_id: string;
  workspace_id?: string;
  iat: number;
  exp: number;
}

/**
 * Mints a cryptographically secure, short-lived (default 15-minute) claim-scoped JWT
 * for runtime sandbox/phase execution under Supabase Row Level Security (RLS).
 */
export function mintRunJwt(params: MintRunJwtParams): string {
  const secret = params.secret ?? process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is required to mint run JWT");
  }

  const projectRef = params.projectRef ?? process.env.SUPABASE_PROJECT_REF ?? "sbauhlhgqxzwyxrqujsr";
  const ttlSeconds = params.ttlSeconds ?? 900; // 15 minutes by default
  const now = Math.floor(Date.now() / 1000);

  const payload: RunJwtPayload = {
    iss: "supabase",
    ref: projectRef,
    aud: "authenticated",
    role: "authenticated",
    run_id: params.runId,
    tenant_id: params.tenantId,
    iat: now,
    exp: now + ttlSeconds
  };

  if (params.workspaceId) {
    payload.workspace_id = params.workspaceId;
  }

  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Decodes and verifies a run JWT using SUPABASE_JWT_SECRET.
 */
export function verifyRunJwt(token: string, secretOverride?: string): RunJwtPayload {
  const secret = secretOverride ?? process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is required to verify run JWT");
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT: invalid segment count");
  }

  const [headerB64, bodyB64, sig] = parts;
  const signingInput = `${headerB64}.${bodyB64}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");

  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    throw new Error("Invalid JWT signature");
  }

  const payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf-8")) as RunJwtPayload;
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp && payload.exp < now) {
    throw new Error("JWT has expired");
  }

  return payload;
}
