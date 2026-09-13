import { describe, it, expect } from "vitest";
import { findAll, PageableQuery } from "../src/parse-paging.js";

/** A fake Parse query: `find()` returns a slice of `rows` based on the last `limit`/`skip` set. */
function fakeQuery<T>(rows: T[]): PageableQuery<T> {
  let limit = rows.length;
  let skip = 0;
  const query: PageableQuery<T> = {
    limit(n) {
      limit = n;
      return query;
    },
    skip(n) {
      skip = n;
      return query;
    },
    find: () => Promise.resolve(rows.slice(skip, skip + limit)),
  };
  return query;
}

describe("findAll", () => {
  it("returns every row when the result fits in one page", async () => {
    const rows = [1, 2, 3];
    expect(await findAll(fakeQuery(rows), 10)).toEqual(rows);
  });

  it("returns a result of exactly one page, rather than mistaking a full page for a truncated one", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => i);
    expect(await findAll(fakeQuery(rows), 100)).toEqual(rows);
  });

  it("pages past a result larger than one page, instead of truncating it", async () => {
    // The bug this guards against: a camp with 140 confirmed registrations against Parse's default
    // page size of 100 lost the last 40 silently, with no error and an advanced watermark.
    const rows = Array.from({ length: 140 }, (_, i) => i);
    expect(await findAll(fakeQuery(rows), 100)).toEqual(rows);
  });
});
