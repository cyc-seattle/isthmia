import { describe, it, expect, vi, afterEach } from "vitest";
import { applySchema } from "../src/directus-client.js";

const baseUrl = "https://directus.example.com";
const token = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("applySchema", () => {
  it("does nothing when the diff reports already in sync", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: null }));
    vi.stubGlobal("fetch", fetchMock);

    await applySchema(baseUrl, token, { some: "schema" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/schema/diff`, expect.anything());
  });

  it("applies the diff and succeeds when a re-diff afterward reports in sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { hash: "abc", diff: { collections: [1] } } })) // diff
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // apply
      .mockResolvedValueOnce(jsonResponse(200, { data: null })); // re-diff: in sync
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, { some: "schema" })).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${baseUrl}/schema/apply`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${baseUrl}/schema/diff`, expect.anything());
  });

  it("throws instead of silently succeeding when the apply didn't actually take", async () => {
    // Regression test: a live `pulumi up` once recorded this as a successful create even though
    // the collections never existed - /schema/apply returned 204 but didn't persist the change.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { hash: "abc", diff: { collections: [1] } } })) // diff
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // apply (silently a no-op)
      .mockResolvedValueOnce(jsonResponse(200, { data: { hash: "abc", diff: { collections: [1] } } })); // re-diff: still pending
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, { some: "schema" })).rejects.toThrow(/still reports pending changes/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
