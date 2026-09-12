import * as gcp from "@pulumi/gcp";
import { humanDeployer, projectId } from "../config";
import { ServiceAccount } from "../service-account";

// Identity the run-reports Cloud Run job acts as. Moved from
// packages/infrastructure/src/infrastructure/run-reports-job.ts; it was imported here, not recreated.
export const reportRunner = new ServiceAccount("report-runner", "Service account that runs the run-reports job.");

// Users who are allowed to impersonate the report runner.
const reportRunners = ["user:master@cyccommunitysailing.org", "user:ungood@onetrue.name"];

reportRunner.allowImpersonation(reportRunners);

// Let the human operator deploy the run-reports Cloud Run job. deploy-runner already holds this
// role through its predefined-role list.
new gcp.projects.IAMMember(`run-developer-${humanDeployer}`, {
  project: projectId,
  role: "roles/run.developer",
  member: humanDeployer,
});
