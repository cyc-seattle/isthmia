import * as gcp from "@pulumi/gcp";
import { projectId } from "./config";

// The identity GitHub Actions impersonates to deploy (#118 adds the Workload Identity Federation
// pool and the workflow that assumes this account; this project only creates the identity itself).
export const deployRunner = new gcp.serviceaccount.Account("deploy-runner", {
  accountId: "deploy-runner",
  displayName: "CI deploy identity — impersonated by GitHub Actions to run pulumi up.",
});

// Predefined roles a deploy needs. See the design doc's "Permissions" section for what each backs.
const predefinedRoles = [
  "roles/serviceusage.serviceUsageAdmin",
  "roles/compute.admin",
  "roles/compute.osLogin",
  "roles/iap.tunnelResourceAccessor",
  "roles/cloudsql.admin",
  "roles/servicenetworking.networksAdmin",
  "roles/dns.admin",
  "roles/artifactregistry.admin",
  "roles/secretmanager.admin",
  "roles/run.developer",
  "roles/cloudscheduler.admin",
];

for (const role of predefinedRoles) {
  new gcp.projects.IAMMember(`deploy-runner-${role.replace("roles/", "")}`, {
    project: projectId,
    role,
    member: deployRunner.member,
  });
}

// What no predefined role grants without over-granting. Excludes project-IAM and role-edit
// permissions on purpose, so deploy-runner can't grant itself Owner.
export const deployerRole = new gcp.projects.IAMCustomRole("deployer", {
  roleId: "deployer",
  title: "Deployer",
  description: "Scoped project permissions for the CI deploy identity, deploy-runner.",
  permissions: [
    "resourcemanager.projects.get",
    "iam.serviceAccounts.get",
    "iam.serviceAccounts.list",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.setIamPolicy",
    "iam.roles.get",
    "iam.roles.list",
  ],
});

new gcp.projects.IAMMember("deploy-runner-deployer", {
  project: projectId,
  role: deployerRole.name,
  member: deployRunner.member,
});

// Addressed by literal email since `bootstrap` doesn't own these accounts yet; grants CI
// `iam.serviceAccounts.actAs` on them, needed to attach them to the VM and the Cloud Run job.
const existingServiceAccounts = [
  `substrate-runner@${projectId}.iam.gserviceaccount.com`,
  `report-runner@${projectId}.iam.gserviceaccount.com`,
];

for (const email of existingServiceAccounts) {
  new gcp.serviceaccount.IAMMember(`deploy-runner-user-${email}`, {
    serviceAccountId: `projects/${projectId}/serviceAccounts/${email}`,
    role: "roles/iam.serviceAccountUser",
    member: deployRunner.member,
  });
}
