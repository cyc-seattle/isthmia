import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { enableService } from "../services";

const sqlApi = enableService("sqladmin.googleapis.com");

/**
 * Creates a Postgres role on an instance, via the Cloud SQL Admin API — not a direct Postgres
 * connection, so this works from wherever `pulumi up` runs, with no network path to the instance's
 * private IP required. `deletionPolicy: "ABANDON"` because Postgres won't let the API delete a role
 * that's been granted privileges on a database (a normal end state here), and failing to delete
 * would otherwise block the rest of a `pulumi destroy`.
 */
export function sqlUser(name: string, instance: pulumi.Input<string>, password: pulumi.Input<string>): gcp.sql.User {
  return new gcp.sql.User(
    `${name}-user`,
    { instance, name, password, deletionPolicy: "ABANDON" },
    // The users were the instance's children until it moved to cyc-seattle/platform (#215).
    {
      dependsOn: sqlApi,
      aliases: [{ parent: pulumi.createUrn("substrate", "gcp:sql/databaseInstance:DatabaseInstance") }],
    },
  );
}
