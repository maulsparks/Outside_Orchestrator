/**
 * Outside Orchestrator Prometheus & Telemetry Metrics Subsystem
 *
 * Governed by:
 * - Outside Orchestrator Role Contract v2 §6.4 (tag:monitoring telemetry ingestion)
 * - Acceptance Criteria 13, 14, 20
 *
 * Implements a lightweight, zero-dependency OpenMetrics / Prometheus text
 * exposition format collector on the Tier 1 Edge/Control Plane.
 */

export type MetricLabels = Record<string, string | number>;

function serializeLabels(labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) {
    return "";
  }
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => {
      const sanitizedVal = String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      return `${key}="${sanitizedVal}"`;
    });
  return `{${pairs.join(",")}}`;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  inc(labels?: MetricLabels, value: number = 1): void {
    if (value < 0) {
      throw new Error(`Counter ${this.name} cannot be incremented by negative value: ${value}`);
    }
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  get(labels?: MetricLabels): number {
    const key = serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labels, val] of this.values.entries()) {
        lines.push(`${this.name}${labels} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, number>();

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  set(value: number, labels?: MetricLabels): void {
    const key = serializeLabels(labels);
    this.values.set(key, value);
  }

  inc(labels?: MetricLabels, value: number = 1): void {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + value);
  }

  dec(labels?: MetricLabels, value: number = 1): void {
    const key = serializeLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - value);
  }

  get(labels?: MetricLabels): number {
    const key = serializeLabels(labels);
    return this.values.get(key) || 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);

    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labels, val] of this.values.entries()) {
        lines.push(`${this.name}${labels} ${val}`);
      }
    }
    return lines.join("\n");
  }
}

export interface HistogramOptions {
  buckets?: number[];
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  private readonly series = new Map<
    string,
    {
      count: number;
      sum: number;
      bucketCounts: Map<number, number>;
    }
  >();

  constructor(name: string, help: string, options: HistogramOptions = {}) {
    this.name = name;
    this.help = help;
    // Default duration buckets in seconds
    this.buckets = (options.buckets ?? [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]).sort(
      (a, b) => a - b
    );
  }

  observe(value: number, labels?: MetricLabels): void {
    const baseLabels = serializeLabels(labels);
    let s = this.series.get(baseLabels);
    if (!s) {
      s = {
        count: 0,
        sum: 0,
        bucketCounts: new Map<number, number>()
      };
      for (const b of this.buckets) {
        s.bucketCounts.set(b, 0);
      }
      this.series.set(baseLabels, s);
    }

    s.count++;
    s.sum += value;

    for (const b of this.buckets) {
      if (value <= b) {
        s.bucketCounts.set(b, (s.bucketCounts.get(b) || 0) + 1);
      }
    }
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);

    if (this.series.size === 0) {
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket{le="${b}"} 0`);
      }
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
    } else {
      for (const [baseLabels, s] of this.series.entries()) {
        const rawLabelMap = baseLabels ? baseLabels.slice(1, -1) : "";
        const labelPrefix = rawLabelMap ? `${rawLabelMap},` : "";

        let cumulative = 0;
        for (const b of this.buckets) {
          cumulative = s.bucketCounts.get(b) || 0;
          lines.push(`${this.name}_bucket{${labelPrefix}le="${b}"} ${cumulative}`);
        }
        lines.push(`${this.name}_bucket{${labelPrefix}le="+Inf"} ${s.count}`);
        const sumLabelSuffix = rawLabelMap ? `{${rawLabelMap}}` : "";
        lines.push(`${this.name}_sum${sumLabelSuffix} ${s.sum}`);
        lines.push(`${this.name}_count${sumLabelSuffix} ${s.count}`);
      }
    }
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  registerCounter(name: string, help: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name, help);
      this.counters.set(name, c);
    }
    return c;
  }

  registerGauge(name: string, help: string): Gauge {
    let g = this.gauges.get(name);
    if (!g) {
      g = new Gauge(name, help);
      this.gauges.set(name, g);
    }
    return g;
  }

  registerHistogram(name: string, help: string, options?: HistogramOptions): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name, help, options);
      this.histograms.set(name, h);
    }
    return h;
  }

  getCounter(name: string): Counter | undefined {
    return this.counters.get(name);
  }

  getGauge(name: string): Gauge | undefined {
    return this.gauges.get(name);
  }

  getHistogram(name: string): Histogram | undefined {
    return this.histograms.get(name);
  }

  resetAll(): void {
    for (const c of this.counters.values()) c.reset();
    for (const g of this.gauges.values()) g.reset();
    for (const h of this.histograms.values()) h.reset();
  }

  renderPrometheus(): string {
    // Collect and refresh system gauges
    const uptimeGauge = this.getGauge("orchestrator_uptime_seconds");
    if (uptimeGauge) {
      uptimeGauge.set(Math.floor(process.uptime()));
    }

    const memoryGauge = this.getGauge("orchestrator_memory_bytes");
    if (memoryGauge) {
      const mem = process.memoryUsage();
      memoryGauge.set(mem.rss, { type: "rss" });
      memoryGauge.set(mem.heapTotal, { type: "heapTotal" });
      memoryGauge.set(mem.heapUsed, { type: "heapUsed" });
      memoryGauge.set(mem.external, { type: "external" });
    }

    const upGauge = this.getGauge("orchestrator_up");
    if (upGauge) {
      upGauge.set(1);
    }

    const sections: string[] = [];
    for (const c of this.counters.values()) {
      sections.push(c.render());
    }
    for (const g of this.gauges.values()) {
      sections.push(g.render());
    }
    for (const h of this.histograms.values()) {
      sections.push(h.render());
    }

    return sections.join("\n\n") + "\n";
  }
}

// Global Singleton Metrics Registry for the Tier 1 Outside Orchestrator
export const metricsRegistry = new MetricsRegistry();

// Standard Orchestrator Metrics Declarations
export const metrics = {
  // Process & Node Health
  orchestratorUp: metricsRegistry.registerGauge(
    "orchestrator_up",
    "Whether the outside orchestrator daemon is healthy and running (1 = up)"
  ),
  orchestratorUptimeSeconds: metricsRegistry.registerGauge(
    "orchestrator_uptime_seconds",
    "Total uptime of the outside orchestrator process in seconds"
  ),
  orchestratorMemoryBytes: metricsRegistry.registerGauge(
    "orchestrator_memory_bytes",
    "Process memory usage in bytes by type"
  ),

  // Ingress & Run Lifecycle
  runsTotal: metricsRegistry.registerCounter(
    "orchestrator_runs_total",
    "Total number of runs received at ingress by tenant and admission outcome"
  ),
  runsActive: metricsRegistry.registerGauge(
    "orchestrator_runs_active",
    "Number of active in-flight runs in Tier 3 by phase"
  ),

  // Phase Execution & Transitions
  phaseTransitionsTotal: metricsRegistry.registerCounter(
    "orchestrator_phase_transitions_total",
    "Total state machine phase transitions committed or failed"
  ),
  phaseDurationSeconds: metricsRegistry.registerHistogram(
    "orchestrator_phase_duration_seconds",
    "Execution duration of factory phases in seconds",
    { buckets: [1, 5, 10, 30, 60, 120, 300, 600] }
  ),

  // Private Model Inference
  inferenceRequestsTotal: metricsRegistry.registerCounter(
    "orchestrator_inference_requests_total",
    "Total model inference requests brokered to private compute workers"
  ),
  tokensConsumedTotal: metricsRegistry.registerCounter(
    "orchestrator_tokens_consumed_total",
    "Total LLM tokens consumed across private model workers"
  ),
  inferenceCostCentsTotal: metricsRegistry.registerCounter(
    "orchestrator_inference_cost_cents_total",
    "Total cost in cents incurred for LLM inference requests"
  ),

  // Sandbox VM & Teardown
  sandboxesProvisionedTotal: metricsRegistry.registerCounter(
    "orchestrator_sandboxes_provisioned_total",
    "Total disposable exe.dev sandboxes provisioned"
  ),
  sandboxesDestroyedTotal: metricsRegistry.registerCounter(
    "orchestrator_sandboxes_destroyed_total",
    "Total disposable exe.dev sandboxes destroyed by reason"
  ),
  teardownAttestationsTotal: metricsRegistry.registerCounter(
    "orchestrator_teardown_attestations_total",
    "Total zero-trust teardown attestations generated by status"
  ),

  // Disaster Recovery & Fencing
  recoveryRunsTotal: metricsRegistry.registerCounter(
    "orchestrator_recovery_runs_total",
    "Total in-flight runs reconciled during crash recovery"
  )
};
