export interface CreateVmConfig {
  runId: string;
  armId?: string;
  cpuMillis?: number;
  memoryMb?: number;
  ttlSeconds?: number;
  setupScript?: string;
  noEmail?: boolean;
}

export interface ExeDevVm {
  vmName: string;
  runId: string;
  armId?: string;
  cpuCores: number;
  memoryGb: number;
  status: "provisioned" | "running" | "stopped" | "terminated";
  createdAt: string;
}

export interface ExeDevVmStatus {
  vmName: string;
  status: string;
  ipAddresses?: string[];
  rawOutput?: string;
}

export interface ExeDevClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * ExeDev Provisioning Client Adapter (ISSUE-09 / AC 3, AC 11, AC 20)
 * Operates strictly on Tier 1 Edge/Control Plane.
 * EXEDEV_API_KEY is never placed inside sandbox VMs or logs.
 */
export class ExeDevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ExeDevClientOptions = {}) {
    this.apiKey = options.apiKey ?? (process.env.EXEDEV_API_KEY || "");
    this.baseUrl = (options.baseUrl ?? process.env.EXEDEV_BASE_URL ?? "https://exe.dev").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private assertApiKey(): void {
    if (!this.apiKey) {
      throw new Error("EXEDEV_API_KEY is required for exe.dev VM provisioning");
    }
  }

  /**
   * Provisions a disposable VM for a run or tournament arm.
   */
  async createSandboxVm(config: CreateVmConfig): Promise<ExeDevVm> {
    this.assertApiKey();

    const vmName = config.armId ? `sbx-${config.runId}-${config.armId}` : `sbx-${config.runId}`;
    const cpuCores = Math.max(1, Math.ceil((config.cpuMillis ?? 2000) / 1000));
    const memoryGb = Math.max(1, Math.ceil((config.memoryMb ?? 2048) / 1024));

    let command = `new --name=${vmName} --cpu=${cpuCores} --memory=${memoryGb}`;
    if (config.noEmail) {
      command += " --no-email";
    }
    if (config.setupScript) {
      command += ` --setup-script="${config.setupScript}"`;
    }
    const res = await this.fetchFn(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "text/plain"
      },
      body: command
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ExeDevProvisioningError: Failed to create VM ${vmName} (${res.status}): ${err}`);
    }

    return {
      vmName,
      runId: config.runId,
      armId: config.armId,
      cpuCores,
      memoryGb,
      status: "provisioned",
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Queries status of an existing VM.
   */
  async getVmStatus(vmName: string): Promise<ExeDevVmStatus> {
    this.assertApiKey();

    const res = await this.fetchFn(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "text/plain"
      },
      body: `status ${vmName}`
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ExeDevStatusError: Failed to get VM status for ${vmName} (${res.status}): ${err}`);
    }

    const output = await res.text();
    return {
      vmName,
      status: output.includes("running") ? "running" : "stopped",
      rawOutput: output
    };
  }

  /**
   * Executes a remote command inside the VM.
   */
  async execCommand(
    vmName: string,
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.assertApiKey();

    const res = await this.fetchFn(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "text/plain"
      },
      body: `exec ${vmName} -- ${command}`
    });

    const text = await res.text();
    return {
      stdout: text,
      stderr: res.ok ? "" : text,
      exitCode: res.ok ? 0 : 1
    };
  }

  /**
   * Destroys the disposable VM and its persistent disk cleanly.
   */
  async destroySandboxVm(vmName: string): Promise<void> {
    this.assertApiKey();

    const res = await this.fetchFn(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "text/plain"
      },
      body: `rm ${vmName}`
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ExeDevTeardownError: Failed to destroy VM ${vmName} (${res.status}): ${err}`);
    }
  }

  /**
   * Clones canonical repository parent Git SHA into the VM clean-room tree.
   * Strips host credentials and history not needed for execution.
   */
  async cloneRepositoryToVm(vmName: string, repoUrl: string, commitSha: string): Promise<void> {
    const cloneCmd = `git clone --depth 1 ${repoUrl} /workspace/repo && cd /workspace/repo && git checkout ${commitSha}`;
    const result = await this.execCommand(vmName, cloneCmd);
    if (result.exitCode !== 0) {
      throw new Error(`ExeDevGitCloneError: Failed to clone repository at ${commitSha}: ${result.stderr}`);
    }
  }

  /**
   * Lists all VMs for the account.
   */
  async listVms(): Promise<Array<{ name: string; raw: string }>> {
    this.assertApiKey();

    const res = await this.fetchFn(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "text/plain"
      },
      body: "ls"
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ExeDevListError: Failed to list VMs (${res.status}): ${err}`);
    }

    const output = await res.text();
    const lines = output.split("\n").map(l => l.trim()).filter(Boolean);
    return lines.map(line => {
      const parts = line.split(/\s+/);
      return {
        name: parts[0] || line,
        raw: line
      };
    });
  }
}


