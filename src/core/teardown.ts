import { TeardownAttestation } from "../../contracts/interfaces";

export function canBeCleanTerminated(attestation: TeardownAttestation): boolean {
  return (
    attestation.credentials_revoked &&
    attestation.tailscale_absent_or_deauthorized &&
    attestation.exe_vm_absent_or_provider_terminal &&
    attestation.post_teardown_probes_passed
  );
}
