import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

// What a project owns in platform's `infra` stack: its A records, and prod's databases. Prod's
// resources moved here from the retired `infrastructure` project with `pulumi state move` (#231), so
// their names and inputs match what it declared.

let cloud: pulumi.StackReference | undefined;

/** An output of platform's `infra` stack in this environment. */
function cloudOutput(output: string): pulumi.Output<string> {
  cloud ??= new pulumi.StackReference(`organization/infra/${pulumi.getStack()}`);
  return cloud.requireOutput(output).apply((value: string) => value);
}

/** An A record for `hostname` in platform's zone. Each project owns its own hostnames' records. */
export function dnsRecord(
  name: string,
  hostname: pulumi.Input<string>,
  address: pulumi.Input<string>,
): gcp.dns.RecordSet {
  return new gcp.dns.RecordSet(name, {
    name: pulumi.interpolate`${hostname}.`,
    type: "A",
    ttl: 300,
    managedZone: cloudOutput("internalZoneName"),
    rrdatas: [address],
  });
}

/**
 * A prod database and its user, `name`, on platform's Cloud SQL instance, through the Admin API. Both
 * outlive `pulumi destroy`: Postgres won't let the API drop a role that holds grants, and Directus's
 * license activation is tied to its database (#172). The database was a `postgresql.Database`, and
 * was imported as this one, so its tables were never touched (#231).
 */
export function prodDatabase(name: string, password: pulumi.Input<string>): gcp.sql.Database {
  const instance = cloudOutput("postgresInstanceName");
  const user = new gcp.sql.User(`${name}-user`, { instance, name, password, deletionPolicy: "ABANDON" });
  return new gcp.sql.Database(
    `${name}-db`,
    { instance, name, deletionPolicy: "ABANDON" },
    { dependsOn: user, protect: true },
  );
}
