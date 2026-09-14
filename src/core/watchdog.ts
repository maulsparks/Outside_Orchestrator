import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemdWatchdogOptions {
  notifySocket?: string;
  systemdNotifyPath?: string;
  execFn?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Systemd Watchdog & Readiness Provider (Tier 1 Process Hardening)
 * Notifies systemd of boot readiness and emits periodic heartbeats (WATCHDOG=1)
 * to satisfy WatchdogSec enforcement. Fails closed and auto-recovers on event loop deadlock.
 */
export class SystemdWatchdog {
  private readonly notifySocket?: string;
  private readonly systemdNotifyPath: string;
  private readonly execFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  private timer: NodeJS.Timeout | null = null;

  constructor(options?: SystemdWatchdogOptions) {
    this.notifySocket = options?.notifySocket ?? process.env.NOTIFY_SOCKET;
    this.systemdNotifyPath = options?.systemdNotifyPath ?? "/usr/bin/systemd-notify";
    this.execFn = options?.execFn ?? ((file, args) => execFileAsync(file, args));
  }

  /**
   * Returns true if running under a systemd service manager with NOTIFY_SOCKET configured.
   */
  isAvailable(): boolean {
    return Boolean(this.notifySocket);
  }

  /**
   * Notifies systemd that daemon initialization and state recovery is complete.
   */
  async notifyReady(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      await this.execFn(this.systemdNotifyPath, ["--ready"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a single heartbeat pulse to systemd (WATCHDOG=1).
   */
  async notifyWatchdog(): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      await this.execFn(this.systemdNotifyPath, ["--watchdog"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts periodic watchdog heartbeats.
   * Default interval is 10 seconds (suitable for WatchdogSec=30s).
   */
  startWatchdog(intervalMs: number = 10000): void {
    if (!this.isAvailable() || this.timer) return;
    this.timer = setInterval(() => {
      this.notifyWatchdog().catch(() => {});
    }, intervalMs);
    this.timer.unref();
  }

  /**
   * Stops active watchdog heartbeat timer.
   */
  stopWatchdog(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
