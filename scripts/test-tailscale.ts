import { TailscaleClient } from "../src/adapters/tailscale/client.js";

async function main() {
  const client = new TailscaleClient();
  console.log("Fetching devices from Tailscale API...");
  try {
    const devices = await client.getDevices();
    console.log(`Found ${devices.length} devices:`);
    for (const d of devices) {
      console.log(`- ID: ${d.id}, Name: ${d.name}, Hostname: ${d.hostname}, Addresses: ${d.addresses.join(",")}, Tags: ${d.tags ? d.tags.join(",") : "none"}`);
    }

    console.log("\nTesting creating sandbox auth key...");
    const key = await client.createSandboxAuthKey({
      tags: ["tag:factory-sandbox"],
      ephemeral: true,
      expirySeconds: 300
    });
    console.log(`Successfully created auth key: ${key.id} (prefix: ${key.key.substring(0, 10)}...)`);

    console.log("\nFetching active Tailscale ACL policy...");
    const policy = await client.validateAclPolicy("");
    console.log(`Active ACL SHA: ${policy.activeSha}`);
    console.log(`ETag: ${policy.etag}`);
  } catch (err: any) {
    console.error("Error testing Tailscale client:", err);
  }
}

main();
