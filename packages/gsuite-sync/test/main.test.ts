import { beforeEach, describe, expect, it, vi } from "vitest";
import { google } from "googleapis";

const constructed = vi.hoisted(() => ({ directory: [] as unknown[][], settings: [] as unknown[][] }));

vi.mock("@cyc-seattle/gsuite-sdk", () => ({
  DirectoryClient: class {
    constructor(...args: unknown[]) {
      constructed.directory.push(args);
    }
  },
  GroupSettingsClient: class {
    constructor(...args: unknown[]) {
      constructed.settings.push(args);
    }
  },
}));

const { googleClients } = await import("../src/main.js");

describe("googleClients", () => {
  const auth = new google.auth.GoogleAuth();

  beforeEach(() => {
    constructed.directory = [];
    constructed.settings = [];
  });

  it("sends both clients to the root URL when one is set", () => {
    googleClients(auth, "http://workspace-fake:8080");

    expect(constructed.directory).toEqual([[auth, { rootUrl: "http://workspace-fake:8080" }]]);
    expect(constructed.settings).toEqual([[auth, { rootUrl: "http://workspace-fake:8080" }]]);
  });

  it("leaves both clients on Google without one", () => {
    googleClients(auth);

    expect(constructed.directory).toEqual([[auth, {}]]);
    expect(constructed.settings).toEqual([[auth, {}]]);
  });
});
