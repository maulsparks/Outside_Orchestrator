export interface MockVmInstance {
  name: string;
  cpu: number;
  memory: number;
  status: "running" | "stopped" | "terminated";
  createdAt: number;
}

/**
 * Mock ExeDev Server & Fetch Harness (ISSUE-17)
 * In-memory simulation of https://exe.dev/exec commands (`new`, `status`, `exec`, `rm`).
 */
export class MockExeDevHarness {
  private readonly vms = new Map<string, MockVmInstance>();
  public shouldFailCreate = false;
  public shouldFailDestroy = false;

  createFetch(): typeof fetch {
    return async (url, init) => {
      const auth = init?.headers ? (init.headers as Record<string, string>)["Authorization"] : undefined;
      if (!auth || !auth.startsWith("Bearer ")) {
        return new Response("Unauthorized", { status: 401 });
      }

      const body = String(init?.body || "");

      // 1. new --name=sbx-... --cpu=... --memory=...
      if (body.startsWith("new ")) {
        if (this.shouldFailCreate) {
          return new Response("CapacityExceededError: No available nodes", { status: 503 });
        }
        const nameMatch = body.match(/--name=([^\s]+)/);
        const cpuMatch = body.match(/--cpu=([^\s]+)/);
        const memMatch = body.match(/--memory=([^\s]+)/);

        const name = nameMatch ? nameMatch[1] : `sbx-${Date.now()}`;
        const cpu = cpuMatch ? Number(cpuMatch[1]) : 2;
        const memory = memMatch ? Number(memMatch[1]) : 2;

        this.vms.set(name, {
          name,
          cpu,
          memory,
          status: "running",
          createdAt: Date.now()
        });

        return new Response(`VM ${name} created successfully`, { status: 200 });
      }

      // 2. status <name>
      if (body.startsWith("status ")) {
        const name = body.replace("status ", "").trim();
        const vm = this.vms.get(name);
        if (!vm) {
          return new Response("VM not found", { status: 404 });
        }
        return new Response(`status: ${vm.status}`, { status: 200 });
      }

      // 3. rm <name>
      if (body.startsWith("rm ")) {
        if (this.shouldFailDestroy) {
          return new Response("ProviderDestroyError", { status: 500 });
        }
        const name = body.replace("rm ", "").trim();
        this.vms.delete(name);
        return new Response(`VM ${name} destroyed`, { status: 200 });
      }

      // 4. exec <name> -- <command>
      if (body.startsWith("exec ")) {
        return new Response("Command executed successfully", { status: 200 });
      }

      return new Response("Unknown command", { status: 400 });
    };
  }

  getVm(name: string): MockVmInstance | undefined {
    return this.vms.get(name);
  }

  hasVm(name: string): boolean {
    return this.vms.has(name);
  }

  clear(): void {
    this.vms.clear();
    this.shouldFailCreate = false;
    this.shouldFailDestroy = false;
  }
}
