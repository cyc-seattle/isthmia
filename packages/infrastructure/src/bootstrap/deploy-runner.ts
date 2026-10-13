import * as gcp from "@pulumi/gcp";
import { projectId } from "../config";
import { substrateRunner } from "./substrate-runner";

// The identity GitHub Actions impersonates to deploy (#118 adds the Workload Identity Federation
// pool and the workflow that assumes this account; this project only creates the identity itself).
export const deployRunner = new gcp.serviceaccount.Account("deploy-runner", {
  accountId: "deploy-runner",
  displayName: "CI deploy identity — impersonated by GitHub Actions to run pulumi up.",
});

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

// Grants CI `iam.serviceAccounts.actAs` on substrate-runner, needed to attach it to the VM.
new gcp.serviceaccount.IAMMember(
  "deploy-runner-user-substrate-runner",
  {
    serviceAccountId: substrateRunner.name,
    role: "roles/iam.serviceAccountUser",
    member: deployRunner.member,
  },
  { aliases: [{ name: `deploy-runner-user-substrate-runner@${projectId}.iam.gserviceaccount.com` }] },
);
