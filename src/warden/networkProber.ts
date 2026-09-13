import net from "node:net";

export interface PortProbeResult {
  port: number;
  reachable: boolean;
  code?: string;
  error?: string;
}

export interface EndpointProbeSummary {
  targetIp: string;
  allUnreachable: boolean;
  probes: PortProbeResult[];
}

export type SocketConnector = (
  host: string,
  port: number,
  timeoutMs: number
) => Promise<{ reachable: boolean; code?: string; error?: string }>;

/**
 * Default TCP socket connector using Node's net module.
 */
export async function defaultSocketConnector(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ reachable: boolean; code?: string; error?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (reachable: boolean, code?: string, error?: string) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ reachable, code, error });
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      finalize(true);
    });

    socket.once("timeout", () => {
      finalize(false, "ETIMEDOUT", "Connection timed out");
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      finalize(false, err.code, err.message);
    });

    try {
      socket.connect(port, host);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      finalize(false, e.code ?? "ECONNFAILED", e.message);
    }
  });
}

/**
 * Post-Teardown Active Network Prober (ISSUE-15 / AC 11, AC 17)
 * Probes former sandbox endpoints to verify that all ports (default: preview 4501, broker 8787, SSH 22)
 * are completely closed/unreachable after teardown.
 */
export async function probeFormerSandboxEndpoints(
  targetIp: string,
  ports: number[] = [4501, 8787, 22],
  timeoutMs = 1500,
  connector: SocketConnector = defaultSocketConnector
): Promise<EndpointProbeSummary> {
  const probes: PortProbeResult[] = [];

  for (const port of ports) {
    const res = await connector(targetIp, port, timeoutMs);
    probes.push({
      port,
      reachable: res.reachable,
      code: res.code,
      error: res.error
    });
  }

  const allUnreachable = probes.every((p) => !p.reachable);

  return {
    targetIp,
    allUnreachable,
    probes
  };
}
