import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { location, projectId } from "../config";
import { deployRunner } from "./deploy-runner";
import { humanDeployers } from "./human-deployers";
import { enableService } from "../services";

// Pulumi state, one bucket and one KMS key per environment (#215). A dev deployer gets only dev's,
// so it can't edit the state a prod apply reads.

const kmsApi = enableService("cloudkms.googleapis.com");
const storageApi = enableService("storage.googleapis.com");

// An IAM member resource is read-modify-write against one shared policy, so the default
// create-then-delete replacement strips the member it just added (#153).
const iamOpts: pulumi.CustomResourceOptions = { deleteBeforeReplace: true };

/**
 * A bucket for one environment's Pulumi state: uniform bucket-level access, public access
 * prevention, and versioning that keeps the 30 newest noncurrent versions of each object. Use
 * {@link StateBucket.grant} to let a member read and write state.
 */
export class StateBucket extends gcp.storage.Bucket {
  constructor(
    protected readonly plainId: string,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(
      plainId,
      {
        name: `${projectId}-${plainId}`,
        location,
        uniformBucketLevelAccess: true,
        publicAccessPrevention: "enforced",
        versioning: { enabled: true },
        lifecycleRules: [{ action: { type: "Delete" }, condition: { numNewerVersions: 30, withState: "ARCHIVED" } }],
      },
      { protect: true, dependsOn: storageApi, ...opts },
    );
  }

  /** Lets a member read and write every object. `granteeLabel` names the resource. */
  grant(member: pulumi.Input<string>, granteeLabel: string): gcp.storage.BucketIAMMember {
    return new gcp.storage.BucketIAMMember(
      `${this.plainId}-${granteeLabel}`,
      { bucket: this.name, role: "roles/storage.objectUser", member },
      iamOpts,
    );
  }

  /** Lets a member read and write one object, by name. */
  grantObject(object: string, member: pulumi.Input<string>, granteeLabel: string): gcp.storage.BucketIAMMember {
    return new gcp.storage.BucketIAMMember(
      `${this.plainId}-${granteeLabel}`,
      {
        bucket: this.name,
        role: "roles/storage.objectUser",
        member,
        condition: {
          title: `Only ${object}`,
          expression: pulumi.interpolate`resource.name == "projects/_/buckets/${this.name}/objects/${object}"`,
        },
      },
      iamOpts,
    );
  }
}

/** The key ring for the state keys. GCP never deletes a key ring. */
export const keyRing = new gcp.kms.KeyRing(
  "pulumi",
  { name: "pulumi", location },
  { protect: true, dependsOn: kmsApi },
);

/**
 * A KMS key that encrypts one environment's Pulumi secrets, rotated every 90 days. Use
 * {@link StateKey.grant} to let a member encrypt and decrypt with it.
 */
export class StateKey extends gcp.kms.CryptoKey {
  constructor(
    protected readonly plainId: string,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(plainId, { name: plainId, keyRing: keyRing.id, rotationPeriod: "7776000s" }, { protect: true, ...opts });
  }

  /** Lets a member encrypt and decrypt with this key. `granteeLabel` names the resource. */
  grant(member: pulumi.Input<string>, granteeLabel: string): gcp.kms.CryptoKeyIAMMember {
    return new gcp.kms.CryptoKeyIAMMember(
      `${this.plainId}-${granteeLabel}`,
      { cryptoKeyId: this.id, role: "roles/cloudkms.cryptoKeyEncrypterDecrypter", member },
      iamOpts,
    );
  }
}

const prodBucket = new StateBucket("pulumi-prod");
const devBucket = new StateBucket("pulumi-dev");
const prodKey = new StateKey("state-prod");
const devKey = new StateKey("state-dev");

for (const member of humanDeployers) {
  for (const resource of [prodBucket, devBucket, prodKey, devKey]) {
    resource.grant(member, member);
  }
}

prodBucket.grant(deployRunner.member, "deploy-runner");
prodKey.grant(deployRunner.member, "deploy-runner");
// The cluster stack writes dev's platform values here, from a prod apply.
devBucket.grantObject("platform/outputs.json", deployRunner.member, "deploy-runner-outputs");

function backend(bucket: StateBucket, key: StateKey) {
  return {
    url: pulumi.interpolate`gs://${bucket.name}`,
    secretsProvider: pulumi.interpolate`gcpkms://${key.id}`,
  };
}

export const stateBackends = { prod: backend(prodBucket, prodKey), dev: backend(devBucket, devKey) };
