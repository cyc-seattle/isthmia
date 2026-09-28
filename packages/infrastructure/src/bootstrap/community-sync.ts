import { humanDeployer } from "../config";
import { ServiceAccount } from "../service-account";

// Identity the community-sync Cloud Run job acts as. Like gsuiteSyncRunner (gsuite-sync.ts), it
// holds a read-only Admin role (Groups → Read, assigned by hand in the Admin console,
// docs/manual-setup.md §5.5) directly, not domain-wide delegation, so - unlike substrateRunner
// (substrate.ts) - it needs no tokenCreator self-grant: nothing is impersonated.
export const communitySyncRunner = new ServiceAccount(
  "community-sync",
  "Service account that runs the community-sync job.",
);

communitySyncRunner.allowImpersonation([humanDeployer]);
