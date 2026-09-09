import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { location } from "./config";
import { network, privateServicesConnection } from "./network";
import { enableService } from "./services";

const sqlApi = enableService("sqladmin.googleapis.com");

/**
 * A Cloud SQL for PostgreSQL instance with secure, durable defaults: private IP only (no public
 * endpoint), automated backups + point-in-time recovery, and deletion protection — the settings
 * that matter most for the one dataset we can't recreate. Attach it to a private network whose
 * service-networking connection already exists.
 */
export class PostgresInstance extends gcp.sql.DatabaseInstance {
  constructor(name: string, args: { network: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
    super(
      name,
      {
        databaseVersion: "POSTGRES_16",
        region: location,
        settings: {
          // Enterprise edition is required for the shared-core tier below; Cloud SQL now defaults
          // new instances to Enterprise Plus, which only allows db-perf-optimized-* tiers.
          edition: "ENTERPRISE",
          // Shared-core (Tier B, ~$25-30/mo). Not covered by the Cloud SQL SLA; fine at this scale.
          tier: "db-g1-small",
          availabilityType: "ZONAL",
          diskType: "PD_SSD",
          diskAutoresize: true,
          ipConfiguration: {
            ipv4Enabled: false,
            privateNetwork: args.network,
          },
          backupConfiguration: {
            enabled: true,
            pointInTimeRecoveryEnabled: true,
            startTime: "09:00", // ~01:00-02:00 America/Los_Angeles, off-peak
            transactionLogRetentionDays: 7,
            backupRetentionSettings: { retainedBackups: 30 },
          },
        },
        deletionProtection: true,
      },
      opts,
    );
  }

  /** Creates a database on this instance. */
  database(name: string): gcp.sql.Database {
    return new gcp.sql.Database(`${name}-db`, { instance: this.name, name }, { parent: this });
  }

  /**
   * Creates a Postgres role on this instance, via the Cloud SQL Admin API — not a direct Postgres
   * connection, so this works from wherever `pulumi up` runs, with no network path to the
   * instance's private IP required. `deletionPolicy: "ABANDON"` because Postgres won't let the API
   * delete a role that's been granted privileges on a database (a normal end state here), and
   * failing to delete would otherwise block the rest of a `pulumi destroy`.
   */
  user(name: string, password: pulumi.Input<string>): gcp.sql.User {
    return new gcp.sql.User(
      `${name}-user`,
      { instance: this.name, name, password, deletionPolicy: "ABANDON" },
      { parent: this },
    );
  }
}

// The substrate's Postgres instance. Directus, Listmonk, and FreeScout all run on Postgres; each
// app creates its own database (via postgres.database()) and user in the slice that deploys it,
// rather than speculatively here.
export const postgres = new PostgresInstance(
  "substrate",
  { network: network.id },
  { dependsOn: [privateServicesConnection, sqlApi] },
);
