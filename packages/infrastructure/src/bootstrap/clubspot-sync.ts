import { humanDeployer } from "../config";
import { ServiceAccount } from "../service-account";

// Identity the clubspot-sync Cloud Run job acts as. Separate from reportRunner (report-runner.ts)
// so the reports job never gains write access to the CRM.
export const clubspotSyncRunner = new ServiceAccount(
  "clubspot-sync",
  "Service account that runs the clubspot-sync job.",
);

clubspotSyncRunner.allowImpersonation([humanDeployer]);
