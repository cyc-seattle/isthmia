/**
 * The subset of `Parse.Query` (and so `LoggedQuery`) that `findAll` needs, kept as an interface so
 * paging can be tested against a fake query instead of a live one.
 */
export interface PageableQuery<T> {
  limit(n: number): PageableQuery<T>;
  skip(n: number): PageableQuery<T>;
  find(): Promise<T[]>;
}

// Parse's own default page size is 100. admin-functions' `.limit(1000)` calls raise that cap but
// don't remove it - a 1001st row is dropped exactly as silently, just less often. Paging removes
// the cap instead of moving it.
const PAGE_SIZE = 1000;

/** Pages a Parse query in fixed-size batches, so a result larger than one page is never truncated. */
export async function findAll<T>(query: PageableQuery<T>, pageSize = PAGE_SIZE): Promise<T[]> {
  const results: T[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await query.limit(pageSize).skip(skip).find();
    results.push(...page);
    if (page.length < pageSize) {
      return results;
    }
  }
}
