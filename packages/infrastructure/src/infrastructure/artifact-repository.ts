import { enableService } from "../services";

// The repository lives in the cloud stack (./cloud.ts). The images here push to it.
export const artifactRegistryApi = enableService("artifactregistry.googleapis.com");
