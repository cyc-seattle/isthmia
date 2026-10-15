import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddedOutpostProvider, findEmbeddedOutpost } from "../src/authentik/embedded-outpost.js";

const url = "https://login.example.com";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

const outposts = {
  results: [
    { pk: "other", managed: null },
    { pk: "embedded-pk", managed: "goauthentik.io/outposts/embedded" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findEmbeddedOutpost", () => {
  it("finds the outpost by its managed key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, outposts)));

    await expect(findEmbeddedOutpost(url, "token")).resolves.toBe("embedded-pk");
  });

  it("fails when the instance has no embedded outpost", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] })));

    await expect(findEmbeddedOutpost(url, "token")).rejects.toThrow(/no outpost managed as/);
  });
});

describe("EmbeddedOutpost", () => {
  it("sets the providers and config on the embedded outpost", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, outposts));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const inputs = { url, token: "token", providers: [7], config: '{"authentik_host":"https://login.example.com"}' };
    const result = await embeddedOutpostProvider.create(inputs);

    expect(result.id).toBe("embedded-pk");
    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, { method: string; body: string }];
    expect(patchUrl).toBe(`${url}/api/v3/outposts/instances/embedded-pk/`);
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body)).toEqual({
      providers: [7],
      config: { authentik_host: "https://login.example.com" },
    });
  });
});
