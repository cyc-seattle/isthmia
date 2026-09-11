import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as postgresql from "@pulumi/postgresql";
import { location } from "./config";
import { network, privateServicesConnection } from "./network";
import { randomSecret } from "./secret";
import { enableService } from "./services";

const sqlApi = enableService("sqladmin.googleapis.com");
const secretmanagerApi = enableService("secretmanager.googleapis.com");

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

// --- In-database authorization (#112).
//
// The Admin API can create instances, databases and roles, but not ownership or GRANTs. Since
// Postgres 15 revoked CREATE on `public` from PUBLIC, a role that neither owns its database nor
// holds an explicit grant cannot create tables - which is why the schema silently never applied.
// Those statements need a real SQL session, so everything below runs through the postgresql
// provider rather than the GCP one.

/** The built-in `postgres` role's password. Pulumi-generated and read only by whoever runs
 * `pulumi up` (who already holds project-wide access) - deliberately NOT granted to
 * `substrateRunner`, so a VM compromise gains nothing. */
export const postgresSuperuserPassword = randomSecret("cloudsql-postgres-password", {
  dependsOn: secretmanagerApi,
});

// Sets the password on the instance's built-in `postgres` role. Cloud SQL creates that role itself,
// so on an instance that predates this resource the first `pulumi up` must import it rather than
// create it - see docs/manual-setup.md.
export const postgresSuperuser = postgres.user("postgres", postgresSuperuserPassword.value);

const config = new pulumi.Config();
/** Local port that `just db-tunnel` forwards to Cloud SQL's private IP. */
const tunnelPort = config.getNumber("dbTunnelPort") ?? 5432;

/** Talks to Cloud SQL over the IAP tunnel `just deploy` opens (Cloud SQL is private-IP-only, and
 * the Cloud SQL connectors provide authorization, not connectivity - they cannot route into a VPC
 * from outside it). `superuser: false` is required: `postgres` on Cloud SQL holds
 * `cloudsqlsuperuser`, not real SUPERUSER, and the provider issues statements only a true superuser
 * can run unless told otherwise. */
export const postgresProvider = new postgresql.Provider("cloudsql", {
  host: "localhost",
  port: tunnelPort,
  username: "postgres",
  password: postgresSuperuserPassword.value,
  superuser: false,
  sslMode: "disable",
});
