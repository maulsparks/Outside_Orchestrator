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

  const execIdx = args.indexOf("--exec");
  if (execIdx !== -1 && args[execIdx + 1] && args[execIdx + 2]) {
    const vmName = args[execIdx + 1];
    const cmd = args[execIdx + 2];
    console.log(`Executing in ${vmName}: ${cmd}...`);
    try {
      const res = await client.execCommand(vmName, cmd);
      console.log(`Exit Code: ${res.exitCode}`);
      console.log(`Stdout: ${res.stdout}`);
      if (res.stderr) console.error(`Stderr: ${res.stderr}`);
    } catch (err: any) {
      console.error(`✖ Failed to exec in ${vmName}:`, err.message);
    }
  }

  const rawIdx = args.indexOf("--raw");
  if (rawIdx !== -1 && args[rawIdx + 1]) {
    const rawCmd = args.slice(rawIdx + 1).join(" ");
    console.log(`Sending raw command to exe.dev: ${rawCmd}...`);
    const res = await fetch("https://exe.dev/exec", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.EXEDEV_API_KEY}`,
        "Content-Type": "text/plain"
      },
      body: rawCmd
    });
    console.log(`Status: ${res.status}`);
    console.log(`Output: ${await res.text()}`);
    return;
  }

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
