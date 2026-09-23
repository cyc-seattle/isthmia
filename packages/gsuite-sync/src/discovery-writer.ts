import winston from "winston";
import { DirectusClient } from "@cyc-seattle/directus";
import { Group, GroupMember } from "@cyc-seattle/gsuite";
import { planGroupNestingDiscovery, planGroupUpserts } from "./discovery.js";
import { GoogleGroupRow } from "./schema.js";

/** The slice of `DirectoryClient` the discovery pass reads through - narrow enough that a real
 * instance satisfies it structurally, matching `DirectoryReader`'s pattern in audit-writer.ts. */
export interface GroupDirectoryReader {
  listGroups(customer: string): Promise<Group[]>;
  listMembers(groupKey: string): Promise<GroupMember[]>;
}

export interface RunDiscoveryOptions {
  directus: DirectusClient;
  directory: GroupDirectoryReader;
  /** The Workspace customer id `listGroups` lists - see `DirectoryClient.listGroups`. */
  customer: string;
}

/**
 * The whole discovery pass: lists every group Workspace has and upserts `google_groups` by email
 * (see `planGroupUpserts`), then lists every current row's live membership and derives `parent_id`
 * from it (see `planGroupNestingDiscovery`). Runs before every other pass, since they all read
 * `google_groups` - `run.ts` gives it its own queue to make that ordering deterministic.
 */
export async function runDiscovery(options: RunDiscoveryOptions): Promise<void> {
  const { directus, directory, customer } = options;

  const [liveGroups, existingRows] = await Promise.all([
    directory.listGroups(customer),
    directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
  ]);

  const { toCreate, toUpdate } = planGroupUpserts(liveGroups, existingRows);

  for (const row of toCreate) {
    winston.info("Discovered new Google Group", { email: row.email });
  }
  const created =
    toCreate.length > 0
      ? await directus.createItems<GoogleGroupRow>("google_groups", toCreate as GoogleGroupRow[])
      : [];

  for (const { id, patch } of toUpdate) {
    winston.info("Refreshing discovered group's name", { id, patch });
    await directus.updateItem<GoogleGroupRow>("google_groups", id, patch);
  }

  // The full current set of rows, including this run's creates and name refreshes - nesting
  // patches below need every row's real id, and a row this run just created has one only here.
  const nameUpdateById = new Map(toUpdate.map(({ id, patch }) => [id, patch.name] as const));
  const currentRows: GoogleGroupRow[] = [
    ...existingRows.map((row) => {
      const name = row.id ? nameUpdateById.get(row.id) : undefined;
      return name !== undefined ? { ...row, name } : row;
    }),
    ...created,
  ];

  const membersByEmail = new Map<string, GroupMember[]>();
  for (const group of currentRows) {
    membersByEmail.set(group.email, await directory.listMembers(group.email));
  }

  const nestingPatches = planGroupNestingDiscovery(currentRows, membersByEmail);
  for (const { id, patch } of nestingPatches) {
    winston.info("Discovered group nesting", { id, patch });
    await directus.updateItem<GoogleGroupRow>("google_groups", id, patch);
  }
}
