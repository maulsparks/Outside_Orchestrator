import { ExeDevClient } from "../src/adapters/exedev/client.js";

async function main() {
  const client = new ExeDevClient();
  const args = process.argv.slice(2);
  const rmIdx = args.indexOf("--rm");

  if (rmIdx !== -1 && args[rmIdx + 1]) {
    const vmName = args[rmIdx + 1];
    console.log(`Attempting to delete VM: ${vmName}...`);
    try {
      await client.destroySandboxVm(vmName);
      console.log(`✔ Successfully deleted VM: ${vmName}`);
    } catch (err: any) {
      console.error(`✖ Failed to delete VM ${vmName}:`, err.message);
    }
  }

  console.log("Querying exe.dev for active VMs...");
  const vms = await client.listVms();
  console.log(`Found ${vms.length} VM entry/entries:`);
  for (const vm of vms) {
    console.log(` - ${vm.raw}`);
  }
}


main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
