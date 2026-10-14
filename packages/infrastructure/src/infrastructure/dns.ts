import * as pulumi from "@pulumi/pulumi";
import { enableService } from "../services";

const config = new pulumi.Config();

// Domains the platform serves from. Safe (example) defaults live here; the real production domains
// are set per-stack in Pulumi.prod.yaml, so a non-prod stack never touches real DNS.
//   externalDomain — public-facing website
//   internalDomain — admin / staff / volunteer portals
export const externalDomain = config.get("externalDomain") ?? "external.example.com";
export const internalDomain = config.get("internalDomain") ?? "internal.example.com";

// The zones live in the cloud stack (./cloud.ts). This stack writes records into them.
enableService("dns.googleapis.com");
