import assert from "node:assert/strict";
import test from "node:test";

import { ExeDevClient } from "../src/adapters/exedev/client.js";

test("ExeDevClient creates VM with expected resource parameters", async () => {
  let requestedUrl = "";
  let requestMethod = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody = "";

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestMethod = init?.method ?? "GET";
    requestHeaders = (init?.headers as Record<string, string>) ?? {};
    requestBody = String(init?.body ?? "");

    return new Response("OK", { status: 200 });
  };

  const client = new ExeDevClient({
    apiKey: "test-exe-key",
    baseUrl: "https://exe.dev",
    fetchFn: mockFetch
  });

  const vm = await client.createSandboxVm({
    runId: "run-001",
    armId: "arm-a",
    cpuMillis: 2000,
    memoryMb: 4096
  });

  assert.equal(requestedUrl, "https://exe.dev/exec");
  assert.equal(requestMethod, "POST");
  assert.equal(requestHeaders["Authorization"], "Bearer test-exe-key");
  assert.equal(requestBody, "new --name=sbx-run-001-arm-a --cpu=2 --memory=4");
  assert.equal(vm.vmName, "sbx-run-001-arm-a");
  assert.equal(vm.status, "provisioned");
});

test("ExeDevClient destroySandboxVm executes rm command", async () => {
  let requestBody = "";

  const mockFetch: typeof fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return new Response("OK", { status: 200 });
  };

  const client = new ExeDevClient({
    apiKey: "test-exe-key",
    fetchFn: mockFetch
  });

  await client.destroySandboxVm("sbx-run-001");
  assert.equal(requestBody, "rm sbx-run-001");
});

test("ExeDevClient asserts apiKey presence", async () => {
  const client = new ExeDevClient({ apiKey: "" });
  await assert.rejects(
    async () => client.createSandboxVm({ runId: "run-1" }),
    { message: /EXEDEV_API_KEY is required/ }
  );
});
