import test from "node:test";
import assert from "node:assert/strict";
import { Counter, Gauge, Histogram, MetricsRegistry } from "../src/core/metrics.js";

test("Counter increments without labels and with labels", () => {
  const counter = new Counter("test_counter", "A test counter");
  assert.equal(counter.get(), 0);

  counter.inc();
  assert.equal(counter.get(), 1);

  counter.inc(undefined, 5);
  assert.equal(counter.get(), 6);

  counter.inc({ tenant: "t1", status: "success" });
  assert.equal(counter.get({ tenant: "t1", status: "success" }), 1);

  counter.inc({ tenant: "t1", status: "success" }, 3);
  assert.equal(counter.get({ tenant: "t1", status: "success" }), 4);

  // Label order independence
  assert.equal(counter.get({ status: "success", tenant: "t1" }), 4);

  // Rejects negative increments
  assert.throws(() => counter.inc(undefined, -1));
});

test("Gauge sets, increments, and decrements", () => {
  const gauge = new Gauge("test_gauge", "A test gauge");
  assert.equal(gauge.get(), 0);

  gauge.set(42);
  assert.equal(gauge.get(), 42);

  gauge.inc();
  assert.equal(gauge.get(), 43);

  gauge.dec(undefined, 10);
  assert.equal(gauge.get(), 33);

  gauge.set(100, { phase: "build" });
  assert.equal(gauge.get({ phase: "build" }), 100);
});

test("Histogram observes values and tracks buckets, count, and sum", () => {
  const hist = new Histogram("test_hist", "A test histogram", { buckets: [1, 5, 10] });

  hist.observe(0.5);
  hist.observe(3);
  hist.observe(7);
  hist.observe(15);

  const rendered = hist.render();
  assert(rendered.includes('test_hist_bucket{le="1"} 1'));
  assert(rendered.includes('test_hist_bucket{le="5"} 2'));
  assert(rendered.includes('test_hist_bucket{le="10"} 3'));
  assert(rendered.includes('test_hist_bucket{le="+Inf"} 4'));
  assert(rendered.includes("test_hist_sum 25.5"));
  assert(rendered.includes("test_hist_count 4"));
});

test("MetricsRegistry renders valid Prometheus exposition format with metadata", () => {
  const registry = new MetricsRegistry();
  const c = registry.registerCounter("jobs_total", "Total jobs executed");
  const g = registry.registerGauge("active_workers", "Active worker count");
  const h = registry.registerHistogram("duration_sec", "Job duration", { buckets: [1, 10] });

  c.inc({ outcome: "success" }, 10);
  g.set(3);
  h.observe(2.5, { job: "build" });

  const output = registry.renderPrometheus();

  // Validate format
  assert(output.includes("# HELP jobs_total Total jobs executed"));
  assert(output.includes("# TYPE jobs_total counter"));
  assert(output.includes('jobs_total{outcome="success"} 10'));

  assert(output.includes("# HELP active_workers Active worker count"));
  assert(output.includes("# TYPE active_workers gauge"));
  assert(output.includes("active_workers 3"));

  assert(output.includes("# HELP duration_sec Job duration"));
  assert(output.includes("# TYPE duration_sec histogram"));
  assert(output.includes('duration_sec_bucket{job="build",le="1"} 0'));
  assert(output.includes('duration_sec_bucket{job="build",le="10"} 1'));
  assert(output.includes('duration_sec_bucket{job="build",le="+Inf"} 1'));
  assert(output.includes('duration_sec_sum{job="build"} 2.5'));
  assert(output.includes('duration_sec_count{job="build"} 1'));
});

test("MetricsRegistry resetAll clears all series", () => {
  const registry = new MetricsRegistry();
  const c = registry.registerCounter("test_c", "help");
  c.inc({ foo: "bar" }, 5);
  assert.equal(c.get({ foo: "bar" }), 5);

  registry.resetAll();
  assert.equal(c.get({ foo: "bar" }), 0);
});
