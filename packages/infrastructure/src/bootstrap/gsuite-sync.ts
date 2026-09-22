import { humanDeployer } from "../config";
import { ServiceAccount } from "../service-account";

// Identity the gsuite-sync Cloud Run job acts as. Separate from clubspotSyncRunner and
// reportRunner: it holds the Groups Administrator role directly (assigned by hand in the Admin
// console, docs/manual-setup.md §5.4), not domain-wide delegation, so unlike substrateRunner
// (substrate.ts) it needs no tokenCreator self-grant - nothing is impersonated.
export const gsuiteSyncRunner = new ServiceAccount("gsuite-sync", "Service account that runs the gsuite-sync job.");

gsuiteSyncRunner.allowImpersonation([humanDeployer]);
