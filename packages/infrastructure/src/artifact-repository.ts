import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { deployers, location, projectId } from "./config";

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
);

export const artifactRepositoryUrl = pulumi.concat(
  location,
  "-docker.pkg.dev/",
  projectId,
  "/",
  artifactRepository.repositoryId,
);

export const artifactRepositoryAccess = deployers.map((deployer) => {
  return new gcp.artifactregistry.RepositoryIamMember(
    `artifact-member-${deployer}`,
    {
      project: artifactRepository.project,
      location: artifactRepository.location,
      repository: artifactRepository.name,
      role: "roles/artifactregistry.writer",
      member: deployer,
    },
  );
});
