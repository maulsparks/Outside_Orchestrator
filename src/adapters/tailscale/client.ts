import crypto from "node:crypto";

export interface TailscaleClientOptions {
  clientId?: string;
  clientSecret?: string;
  tailnet?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface TailscaleDevice {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  tags?: string[];
  authorized: boolean;
  isExternal: boolean;
  advertisedRoutes?: string[];
  primaryRoutes?: string[];
  exitNode?: boolean;
  exitNodeOption?: boolean;
  expires?: string;
}

export interface CreateAuthKeyParams {
  tags: string[];
  ephemeral?: boolean;
  preauthorized?: boolean;
  expirySeconds?: number;
}

export interface AuthKeyResult {
  key: string;
  id: string;
  expires: string;
}

export const FORBIDDEN_SANDBOX_TAGS = [
  "tag:edge-control-prod",
  "tag:deployment-controller",
  "tag:private-compute-prod"
];

/**
 * Tailscale Control-Plane API Adapter (ISSUE-10 / AC 4, AC 13, AC 14, AC 15)
 * Manages dynamic ephemeral node auth keys and deauthorization / deletion.
 */
export class TailscaleClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tailnet: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(options: TailscaleClientOptions = {}) {
    this.clientId = options.clientId ?? (process.env.TAILSCALE_CLIENT_ID || "");
    this.clientSecret = options.clientSecret ?? (process.env.TAILSCALE_CLIENT_SECRET || "");
    this.tailnet = options.tailnet ?? (process.env.TAILSCALE_TAILNET || "-");
    this.baseUrl = (options.baseUrl ?? "https://api.tailscale.com").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Exchanges OAuth client ID and secret for an access token.
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.tokenExpiresAt > now + 60000) {
      return this.cachedToken;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("Tailscale OAuth credentials (clientId & clientSecret) are required");
    }

    const params = new URLSearchParams();
    params.append("client_id", this.clientId);
    params.append("client_secret", this.clientSecret);

    const res = await this.fetchFn(`${this.baseUrl}/api/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TailscaleOAuthError: Failed to obtain token (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.cachedToken = data.access_token;
    const expiresInSec = data.expires_in ?? 3600;
    this.tokenExpiresAt = now + expiresInSec * 1000;

    return this.cachedToken;
  }

  private async getAuthHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders
    };
  }

  /**
   * Fetches active tailnet ACL policy and verifies against expected policy SHA256.
   */
  async validateAclPolicy(expectedPolicySha: string): Promise<{ valid: boolean; activeSha: string; etag: string }> {
    const headers = await this.getAuthHeaders();
    const res = await this.fetchFn(`${this.baseUrl}/api/v2/tailnet/${this.tailnet}/acl`, {
      method: "GET",
      headers
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TailscalePolicyError: Failed to fetch ACL policy (${res.status}): ${err}`);
    }

    const etag = res.headers.get("etag") || "";
    const bodyText = await res.text();
    const activeSha = crypto.createHash("sha256").update(bodyText, "utf8").digest("hex");

    return {
      valid: activeSha === expectedPolicySha,
      activeSha,
      etag
    };
  }

  /**
   * Creates an ephemeral, single-use auth key strictly scoped to tag:factory-sandbox.
   * Prohibits assigning any control-plane or private-compute tags.
   */
  async createSandboxAuthKey(params: CreateAuthKeyParams): Promise<AuthKeyResult> {
    for (const tag of params.tags) {
      if (FORBIDDEN_SANDBOX_TAGS.includes(tag)) {
        throw new Error(`ForbiddenTagError: Sandbox key cannot be granted control-plane tag '${tag}'`);
      }
    }

    if (!params.tags.includes("tag:factory-sandbox")) {
      throw new Error("InvalidTagError: Sandbox auth key must include 'tag:factory-sandbox'");
    }

    const payload = {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: params.ephemeral !== false,
            preauthorized: params.preauthorized !== false,
            tags: params.tags
          }
        }
      },
      expirySeconds: params.expirySeconds ?? 3600
    };

    const headers = await this.getAuthHeaders();
    const res = await this.fetchFn(`${this.baseUrl}/api/v2/tailnet/${this.tailnet}/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TailscaleKeyCreationError: Failed to create sandbox key (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { key: string; id: string; expires?: string };
    return {
      key: data.key,
      id: data.id,
      expires: data.expires ?? new Date(Date.now() + (params.expirySeconds ?? 3600) * 1000).toISOString()
    };
  }

  /**
   * Fetches device details from tailnet inventory.
   */
  async getDevice(deviceId: string): Promise<TailscaleDevice | null> {
    const headers = await this.getAuthHeaders();
    const res = await this.fetchFn(`${this.baseUrl}/api/v2/device/${deviceId}`, {
      method: "GET",
      headers
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TailscaleDeviceQueryError: Failed to get device ${deviceId} (${res.status}): ${err}`);
    }

    return res.json() as Promise<TailscaleDevice>;
  }

  /**
   * Deauthorizes / expires a device immediately.
   */
  async deauthorizeNode(deviceId: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const res = await this.fetchFn(`${this.baseUrl}/api/v2/device/${deviceId}/expire`, {
      method: "POST",
      headers
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`TailscaleDeauthError: Failed to expire device ${deviceId} (${res.status}): ${err}`);
    }
  }

  /**
   * Completely deletes a device from the tailnet inventory.
   */
  async deleteDevice(deviceId: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const res = await this.fetchFn(`${this.baseUrl}/api/v2/device/${deviceId}`, {
      method: "DELETE",
      headers
    });

    if (!res.ok && res.status !== 404) {
      const err = await res.text();
      throw new Error(`TailscaleDeleteDeviceError: Failed to delete device ${deviceId} (${res.status}): ${err}`);
    }
  }
}
