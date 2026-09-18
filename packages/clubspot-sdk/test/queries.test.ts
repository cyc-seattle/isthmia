import { describe, it, expect, beforeAll, vi } from "vitest";
import { Parse } from "../src/parse.js";
import { Camp, Club } from "../src/types.js";
import {
  queryCampEntries,
  queryContracts,
  queryPayouts,
  queryQboSyncEvents,
  queryRegistrations,
  querySuppressedEmails,
  queryTransactions,
} from "../src/queries.js";

// types.ts registers each class with a TC39 class decorator, which this test runtime can't
// execute (Node has no native support, and vitest's esbuild transform doesn't down-level it).
// Stand in with plain Parse.Object subclasses that have the same className, since query building
// only depends on that - not on Parse.Object.registerSubclass.
vi.mock("../src/types.js", async () => {
  const { default: BaseParse } = await import("parse/node.js");

  function makeClass(objectClass: string) {
    return class extends BaseParse.Object {
      static objectClass = objectClass;
      constructor(attributes?: unknown) {
        super(objectClass, attributes as Record<string, unknown>);
      }
    };
  }

  return {
    Camp: makeClass("camps"),
    Club: makeClass("clubs"),
    Contract: makeClass("contracts"),
    Payout: makeClass("payouts"),
    QboSyncEvent: makeClass("qbo_sync_events"),
    Registration: makeClass("registrations"),
    SesEmailSuppression: makeClass("ses_email_suppression"),
    Transaction: makeClass("transactions"),
  };
});

beforeAll(() => {
  Parse.initialize("test-app-id");
});

function makeCamp(id: string): Camp {
  const camp = new Camp({} as ConstructorParameters<typeof Camp>[0]);
  camp.id = id;
  return camp;
}

function makeClub(id: string): Club {
  const club = new Club({} as ConstructorParameters<typeof Club>[0]);
  club.id = id;
  return club;
}

describe("queryCampEntries", () => {
  it("filters to confirmed entries for the camp, without excluding archived ones", () => {
    const camp = makeCamp("camp-1");
    const where = queryCampEntries(camp).toJSON().where;

    expect(where.campObject).toEqual({ __type: "Pointer", className: "camps", objectId: "camp-1" });
    expect(where.confirmed_at).toEqual({ $exists: true });
    expect(where.archived).toBeUndefined();
  });
});

describe("queryRegistrations", () => {
  it("filters to unarchived registrations with a confirmed/applied/invited status", () => {
    const club = makeClub("club-1");
    const json = queryRegistrations(club).toJSON();

    expect(json.where.clubObject).toEqual({ __type: "Pointer", className: "clubs", objectId: "club-1" });
    expect(json.where.archived).toBe(false);
    expect(json.where.status).toEqual({ $in: ["confirmed", "applied", "invited"] });
    expect(json.order).toBe("-confirmed_at");
  });
});

describe("queryTransactions", () => {
  it("bounds event_timestamp by the date range and sorts most recent first", () => {
    const club = makeClub("club-1");
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-31T23:59:59.999Z");
    const json = queryTransactions(club, start, end).toJSON();

    expect(json.where.event_timestamp).toEqual({
      $gte: { __type: "Date", iso: start.toISOString() },
      $lte: { __type: "Date", iso: end.toISOString() },
    });
    expect(json.order).toBe("-event_timestamp");
  });
});

describe("queryContracts", () => {
  it("excludes archived contracts for the club, sorted newest first", () => {
    const club = makeClub("club-1");
    const json = queryContracts(club).toJSON();

    expect(json.where.clubObject).toEqual({ __type: "Pointer", className: "clubs", objectId: "club-1" });
    expect(json.where.archived).toEqual({ $ne: true });
    expect(json.order).toBe("-createdAt");
  });
});

describe("querySuppressedEmails", () => {
  it("excludes archived suppression entries for the club, sorted newest first", () => {
    const club = makeClub("club-1");
    const json = querySuppressedEmails(club).toJSON();

    expect(json.where.clubObject).toEqual({ __type: "Pointer", className: "clubs", objectId: "club-1" });
    expect(json.where.archived).toEqual({ $ne: true });
    expect(json.order).toBe("-createdAt");
  });
});

describe("queryQboSyncEvents", () => {
  it("excludes archived and hidden sync events for the club, sorted most recent first", () => {
    const club = makeClub("club-1");
    const json = queryQboSyncEvents(club).toJSON();

    expect(json.where.clubObject).toEqual({ __type: "Pointer", className: "clubs", objectId: "club-1" });
    expect(json.where.archived).toEqual({ $ne: true });
    expect(json.where.hidden).toEqual({ $ne: true });
    expect(json.order).toBe("-succeeded_at");
  });
});

describe("queryPayouts", () => {
  it("excludes archived payouts for the club, sorted most recent first", () => {
    const club = makeClub("club-1");
    const json = queryPayouts(club).toJSON();

    expect(json.where.clubObject).toEqual({ __type: "Pointer", className: "clubs", objectId: "club-1" });
    expect(json.where.archived).toEqual({ $ne: true });
    expect(json.order).toBe("-arrivalDate");
  });
});
