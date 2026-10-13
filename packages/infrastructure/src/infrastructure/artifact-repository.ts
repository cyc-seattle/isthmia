import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { location, projectId } from "../config";
import { deployRunner } from "./identities";
import { enableService } from "../services";

const artifactRegistryApi = enableService("artifactregistry.googleapis.com");

export const artifactRepository = new gcp.artifactregistry.Repository(
  "artifact-repository",
  {
    location,
    repositoryId: "artifact-docker-repository",
    format: "DOCKER",
    dockerConfig: {
      immutableTags: false,
    },
  },
  { dependsOn: artifactRegistryApi },
);

export const artifactRepositoryUrl = pulumi.concat(
  location,
  "-docker.pkg.dev/",
  projectId,
  "/",
  artifactRepository.repositoryId,
);

// Human deployers get access through project `roles/owner` instead (docs/manual-setup.md §7).
export const artifactRepositoryAccess = new gcp.artifactregistry.RepositoryIamMember(
  "artifact-member-deploy-runner",
  {
    project: artifactRepository.project,
    location: artifactRepository.location,
    repository: artifactRepository.name,
    role: "roles/artifactregistry.writer",
    member: deployRunner.member,
  },
  { aliases: [{ name: `artifact-member-serviceAccount:deploy-runner@${projectId}.iam.gserviceaccount.com` }] },
);
