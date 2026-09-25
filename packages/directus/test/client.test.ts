import { describe, it, expect, vi, afterEach } from "vitest";
import winston from "winston";
import { CREATE_CHUNK_SIZE, DirectusClient } from "../src/client.js";

// This package's tsconfig has no DOM lib, so the ambient `RequestInit` resolves to an empty
// structural type (see client.ts) rather than undici's real one. This local alias covers the
// fields these tests assert on from a captured fetch-mock call.
type FetchInit = { method?: string; headers?: unknown; body?: unknown };

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

describe("readItems", () => {
  it("encodes filter operators as filter[field][operator] query params", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    await client.readItems("people", {
      filter: { email: { _eq: "a@b.com" }, last_name: { _icontains: "smith" } },
      fields: ["id", "email"],
      sort: ["-id"],
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`${baseUrl}/items/people?`);
    const params = new URL(url).searchParams;
    expect(params.get("filter[email][_eq]")).toBe("a@b.com");
    expect(params.get("filter[last_name][_icontains]")).toBe("smith");
    expect(params.get("fields")).toBe("id,email");
    expect(params.get("sort")).toBe("-id");
  });

  it("sends the bearer token in the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    await client.readItems("people");

    const [, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${token}`);
  });

  it("pages through every row when limit is -1, until a short page ends it", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 500 }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: page1 }))
      .mockResolvedValueOnce(jsonResponse(200, { data: page2 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    const items = await client.readItems("people", { limit: -1 });

    expect(items).toHaveLength(501);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(firstUrl.searchParams.get("page")).toBe("1");
    const secondUrl = new URL((fetchMock.mock.calls[1] as [string])[0]);
    expect(secondUrl.searchParams.get("page")).toBe("2");
  });

  it("throws an error naming the status and the path on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(404, "not found")));
    const client = new DirectusClient(baseUrl, token);

    await expect(client.readItems("people")).rejects.toThrow(/GET \/items\/people.*-> 404/);
  });

  it("treats a 204 empty response as no rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(204, undefined)));
    const client = new DirectusClient(baseUrl, token);

    await expect(client.readItems("people")).resolves.toEqual([]);
  });
});

describe("createItems", () => {
  it("sends the whole batch in one POST request", async () => {
    const items = [{ name: "a" }, { name: "b" }];
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: items }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    const result = await client.createItems("people", items);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${baseUrl}/items/people`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(items);
    expect(result).toEqual(items);
  });

  it("splits a large batch into chunked POSTs and returns every created row in order", async () => {
    const items = Array.from({ length: CREATE_CHUNK_SIZE + 3 }, (_, i) => ({ name: `p${i}` }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: items.slice(0, CREATE_CHUNK_SIZE) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: items.slice(CREATE_CHUNK_SIZE) }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    const result = await client.createItems("people", items);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = (fetchMock.mock.calls as [string, FetchInit][]).map(
      ([, init]) => JSON.parse(init.body as string) as unknown[],
    );
    expect(bodies.map((body: unknown[]) => body.length)).toEqual([CREATE_CHUNK_SIZE, 3]);
    expect(result).toEqual(items);
  });

  it("in dry-run mode, issues no request and returns what it would have written", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token, true);
    const items = [{ name: "a" }];

    const result = await client.createItems("people", items);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(items);
  });

  it("in dry-run mode, still allows reads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token, true);

    const result = await client.readItems("people");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 1 }]);
  });
});

describe("deleteItem", () => {
  it("sends a DELETE to /items/<collection>/<id>", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(204, undefined));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    await client.deleteItem("session_classes", "1");

    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${baseUrl}/items/session_classes/1`);
    expect(init.method).toBe("DELETE");
  });

  it("in dry-run mode, issues no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token, true);

    await client.deleteItem("session_classes", "1");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("updateItem", () => {
  it("sends a PATCH to /items/<collection>/<id>", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: { id: "1", name: "a" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token);

    await client.updateItem("people", "1", { name: "a" });

    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${baseUrl}/items/people/1`);
    expect(init.method).toBe("PATCH");
  });

  it("in dry-run mode, issues no write request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new DirectusClient(baseUrl, token, true);

    const result = await client.updateItem("people", "1", { name: "a" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ name: "a" });
  });

  it("in dry-run mode, logs which fields would change but not their values", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const client = new DirectusClient(baseUrl, token, true);
    const infoSpy = vi.spyOn(winston, "info").mockImplementation(() => winston);

    await client.updateItem("medical_profiles", "42", {
      conditions: "peanut allergy",
      allergies: "peanuts",
    });

    expect(infoSpy).toHaveBeenCalledWith(
      "Dry run: skipping update",
      expect.objectContaining({ collection: "medical_profiles", id: "42", fields: ["conditions", "allergies"] }),
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("peanut allergy");
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("peanuts");

    infoSpy.mockRestore();
  });
});
