export type ClientRole = "service_role" | "authenticated" | "anon";

export interface SupabaseClientOptions {
  supabaseUrl?: string;
  apiKey?: string;
  authToken?: string;
  role: ClientRole;
}

export interface QueryOptions {
  select?: string;
  eq?: Record<string, string | number | boolean>;
  order?: string;
  limit?: number;
}

export class SupabaseRestClient {
  readonly baseUrl: string;
  readonly role: ClientRole;
  private readonly apiKey: string;
  private readonly authToken: string;

  constructor(options: SupabaseClientOptions) {
    const rawUrl = options.supabaseUrl ?? process.env.SUPABASE_URL ?? "https://sbauhlhgqxzwyxrqujsr.supabase.co";
    this.baseUrl = rawUrl.replace(/\/$/, "");
    this.role = options.role;
    this.apiKey = options.apiKey ?? (process.env.SUPABASE_ANON_KEY || "");
    this.authToken = options.authToken ?? this.apiKey;
  }

  isServiceRole(): boolean {
    return this.role === "service_role";
  }

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "apikey": this.apiKey,
      "Authorization": `Bearer ${this.authToken}`,
      ...extraHeaders
    };
  }

  async select<T = unknown>(table: string, options: QueryOptions = {}): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    if (options.select) {
      url.searchParams.set("select", options.select);
    } else {
      url.searchParams.set("select", "*");
    }

    if (options.eq) {
      for (const [key, value] of Object.entries(options.eq)) {
        url.searchParams.set(key, `eq.${value}`);
      }
    }

    if (options.order) {
      url.searchParams.set("order", options.order);
    }

    if (options.limit !== undefined) {
      url.searchParams.set("limit", String(options.limit));
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.getHeaders()
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Supabase SELECT failed on table ${table} (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<T[]>;
  }

  async insert<T = unknown>(table: string, records: Record<string, unknown> | Array<Record<string, unknown>>): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.getHeaders({ "Prefer": "return=representation" }),
      body: JSON.stringify(records)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Supabase INSERT failed on table ${table} (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<T[]>;
  }

  async update<T = unknown>(
    table: string,
    filters: Record<string, string | number | boolean>,
    data: Record<string, unknown>
  ): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(filters)) {
      url.searchParams.set(key, `eq.${value}`);
    }

    const res = await fetch(url.toString(), {
      method: "PATCH",
      headers: this.getHeaders({ "Prefer": "return=representation" }),
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Supabase UPDATE failed on table ${table} (${res.status}): ${errorText}`);
    }

    return res.json() as Promise<T[]>;
  }

  async delete(table: string, filters: Record<string, string | number | boolean>): Promise<void> {
    const url = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [key, value] of Object.entries(filters)) {
      url.searchParams.set(key, `eq.${value}`);
    }

    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.getHeaders()
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Supabase DELETE failed on table ${table} (${res.status}): ${errorText}`);
    }
  }
}

/**
 * Returns an administrative client backed by the master service_role key.
 * Strictly prohibited from ordinary phase execution loops.
 */
export function getAdminClient(): SupabaseRestClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for admin client");
  }

  return new SupabaseRestClient({
    apiKey: serviceKey,
    authToken: serviceKey,
    role: "service_role"
  });
}

/**
 * Returns a runtime client authenticated via a short-lived claim-scoped JWT.
 * Restricted strictly by PostgreSQL Row Level Security (RLS).
 */
export function getScopedClient(runJwt: string): SupabaseRestClient {
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY is required for scoped runtime client");
  }

  return new SupabaseRestClient({
    apiKey: anonKey,
    authToken: runJwt,
    role: "authenticated"
  });
}

/**
 * Invariant guard asserting that the client is not using broad service_role credentials.
 */
export function assertNotServiceRole(client: SupabaseRestClient): void {
  if (client.isServiceRole()) {
    throw new Error("Security Violation: Master service_role credentials are prohibited in runtime phase loops");
  }
}
