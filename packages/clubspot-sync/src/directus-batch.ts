import { DirectusClient } from "@cyc-seattle/directus";

// Directus 403s a dot-notation relational filter (`filter[registration_id.camp_id][_eq]`) on
// several hop collections - it requires read permission on the traversed field itself, which
// this token doesn't have, independent of what's in `fields` (see #135 follow-up). Chunked `_in` is
// the fallback: a UUID plus its comma separator is ~37 characters, so 40 ids/batch keeps a request's
// id list under 1,480 characters - well under a conservative 2,000-character URL budget once the
// base URL, path, and other query params are added.
export const ID_BATCH_SIZE = 40;

/**
 * Reads rows whose `field` matches one of `ids`, batching the `_in` list so no single request's URL
 * grows unbounded with the id list's size. Shared by `sync-run.ts`'s per-camp reads and
 * `merge-executor.ts`'s per-group reads.
 */
export async function readByIds<Row>(
  directus: DirectusClient,
  collection: string,
  field: string,
  ids: readonly string[],
  fields?: readonly string[],
): Promise<Row[]> {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    batches.push(ids.slice(i, i + ID_BATCH_SIZE));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      directus.readItems<Row>(collection, {
        filter: { [field]: { _in: batch.join(",") } },
        limit: -1,
        ...(fields ? { fields: [...fields] } : {}),
      }),
    ),
  );
  return results.flat();
}
