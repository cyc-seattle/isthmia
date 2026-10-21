import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

// What a prod stack owns while its app still runs on the substrate VM. The resources moved here from
// `infrastructure` with `pulumi state move` (#231, docs/prod-state-move.md), so their names and
// inputs match what `infrastructure` declared. Deleted with the VM.

const stacks = new Map<string, pulumi.StackReference>();

/** An output of another project's stack in this environment, through one StackReference per stack. */
function stackOutput(project: string, output: string): pulumi.Output<string> {
  const name = `organization/${project}/${pulumi.getStack()}`;
  let stack = stacks.get(name);
  if (!stack) {
    stack = new pulumi.StackReference(name);
    stacks.set(name, stack);
  }
  return stack.requireOutput(output).apply((value: string) => value);
}

/** An output of `infrastructure`, which runs the VM. */
export function infrastructureOutput(output: string): pulumi.Output<string> {
  return stackOutput("infrastructure", output);
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
    managedZone: stackOutput("cloud", "internalZoneName"),
    rrdatas: [address],
  });
}

/**
 * An A record for `<host>.<domain>`, or the domain itself without `host`, to the VM's address. The
 * address is `infrastructure`'s until the record moves to the Gateway.
 */
export function vmDnsRecord(name: string, host?: string): gcp.dns.RecordSet {
  const domain = infrastructureOutput("internalDomain");
  const hostname = host === undefined ? domain : pulumi.interpolate`${host}.${domain}`;
  return dnsRecord(name, hostname, infrastructureOutput("publicIp"));
}

/**
 * A database and its user, `name`, on platform's Cloud SQL instance, through the Admin API. Both
 * outlive `pulumi destroy`: Postgres won't let the API drop a role that holds grants, and Directus's
 * license activation is tied to its database (#172). The database was a `postgresql.Database`, and
 * was imported as this one, so its tables were never touched (#231).
 */
export function vmDatabase(name: string, password: pulumi.Input<string>): gcp.sql.Database {
  const instance = stackOutput("cloud", "postgresInstanceName");
  const user = new gcp.sql.User(`${name}-user`, { instance, name, password, deletionPolicy: "ABANDON" });
  return new gcp.sql.Database(
    `${name}-db`,
    { instance, name, deletionPolicy: "ABANDON" },
    { dependsOn: user, protect: true },
  );
}
