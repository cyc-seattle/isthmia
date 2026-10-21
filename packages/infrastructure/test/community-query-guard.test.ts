import { describe, it, expect } from "vitest";
import { violation } from "../src/crm/community-query-guard.js";
import { queryGuardConfig } from "../src/crm/community-rules.js";

const config = queryGuardConfig();

// The relations the probes cross, as Directus's schema overview has them.
const relations = [
  { collection: "registration_entries", field: "class_id", related_collection: "classes" },
  { collection: "classes", field: "camp_id", related_collection: "camps" },
  { collection: "classes", field: "program_id", related_collection: "programs" },
  { collection: "registrations", field: "camp_id", related_collection: "camps" },
  { collection: "contacts", field: "subject_id", related_collection: "people", meta: { one_field: "my_contacts" } },
  { collection: "contacts", field: "contact_id", related_collection: "people", meta: { one_field: "contact_for" } },
];

const check = (collection: string, query: Record<string, unknown>) => violation(config, relations, collection, query);

describe("queryGuardConfig", () => {
  it("restricts the fields some Community read rule withholds, and opens the unfiltered lookups", () => {
    expect(config).toEqual({
      restricted: { people: ["email", "phone", "school"], registrations: ["camp_id", "share_contact"] },
      open: ["camps", "classes", "programs"],
    });
  });
});

describe("the Community query guard", () => {
  it("passes the portal's roster requests", () => {
    const activeCamp = { start_date: { _lte: "$NOW" }, end_date: { _gte: "$NOW(-36 hours)" } };
    expect(check("registration_entries", { filter: { class_id: { camp_id: activeCamp } } })).toBeUndefined();
    expect(check("people", {})).toBeUndefined();
    expect(check("contacts", { filter: { subject_id: { _eq: "p1" } } })).toBeUndefined();
  });

  it("passes a search, which Directus checks against permissions itself", () => {
    expect(check("people", { search: "bart" })).toBeUndefined();
  });

  it.each([
    [{ filter: { email: { _starts_with: "b" } } }, "people.email"],
    [{ filter: { _or: [{ first_name: { _eq: "x" } }, { phone: { _nnull: true } }] } }, "people.phone"],
    [{ sort: ["-email"] }, "people.email"],
    [{ group: ["school"] }, "people.school"],
    [{ aggregate: { countDistinct: ["phone"] } }, "people.phone"],
    [{ filter: { my_contacts: { contact_id: { first_name: { _eq: "Marge" } } } } }, "the relation people.my_contacts"],
    [
      { filter: { my_contacts: { _some: { relationship_type: { _eq: "guardian" } } } } },
      "the relation people.my_contacts",
    ],
    [
      { filter: { "$FOLLOW(contacts,subject_id)": { contact_id: { _null: false } } } },
      "the relation $FOLLOW(contacts,subject_id)",
    ],
    [{ deep: { my_contacts: { _filter: { relationship_type: { _eq: "guardian" } } } } }, "deep"],
  ])("rejects %j on people", (query: Record<string, unknown>, reason: string) => {
    expect(check("people", query)).toBe(reason);
  });

  it("rejects a filter through an open collection back into a partial one", () => {
    expect(check("contacts", { filter: { subject_id: { email: { _eq: "x" } } } })).toBe(
      "the relation contacts.subject_id",
    );
  });

  it("rejects a relation through a field the viewer can't read on every row", () => {
    expect(check("registrations", { filter: { camp_id: { name: { _eq: "Summer Session 2" } } } })).toBe(
      "registrations.camp_id",
    );
  });
});
