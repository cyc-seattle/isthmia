import { humanDeployers } from "./human-deployers";
import { ServiceAccount } from "../service-account";

// Identity the clubspot-sync Cloud Run job acts as.
export const clubspotSyncRunner = new ServiceAccount(
  "clubspot-sync",
  "Service account that runs the clubspot-sync job.",
);

clubspotSyncRunner.allowImpersonation(humanDeployers);
