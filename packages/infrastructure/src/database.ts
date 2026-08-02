import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { location } from "./config";
import { network, privateServicesConnection } from "./network";

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
}

// The platform's Postgres instance. Directus, Listmonk, and FreeScout all run on Postgres; each
// app creates its own database (via postgres.database()) and user in the slice that deploys it,
// rather than speculatively here.
export const postgres = new PostgresInstance(
  "platform",
  { network: network.id },
  { dependsOn: privateServicesConnection },
);
