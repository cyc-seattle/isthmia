import { describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { feature } from "./feature";
import { asAdmin, newRunId, proxyOk, runCronJob } from "./support";

// The fake's seed, which the dev stack's clubspot-sync config names (contract: public test values).
const CLUB_ID = "seedClub01";
const parseHeaders = {
  "x-parse-application-id": "myclubspot2017",
  "x-parse-master-key": "fake-master-key-for-tests-only",
};

const pointer = (className: string, objectId: string) => ({ __type: "Pointer", className, objectId });
const date = (offsetDays: number) => ({
  __type: "Date",
  iso: new Date(Date.now() + offsetDays * 86_400_000).toISOString(),
});

/** Creates a Parse object with a chosen objectId, which the fake allows, so later objects can point at it. */
async function create(className: string, objectId: string, fields: Record<string, unknown>): Promise<void> {
  await proxyOk("clubspot-fake", 1337, "POST", `/parse/classes/${className}`, { objectId, ...fields }, parseHeaders);
}

describeFeature(feature("clubspot-sync.feature"), ({ Scenario }) => {
  Scenario("A participant's registration becomes a person with a guardian", ({ Given, And, When, Then }) => {
    const runId = newRunId();
    const id = (kind: string) => `${kind}${runId}`;
    const participant = {
      firstName: "Sync",
      lastName: `Sailor ${runId}`,
      guardianFirst: "Guardian",
      guardianLast: `Sailor ${runId}`,
      guardianEmail: `guardian.${runId}@example.test`,
    };

    Given("a camp running today in the Clubspot fake", async () => {
      const club = pointer("clubs", CLUB_ID);
      await create("camps", id("cmp"), {
        clubObject: club,
        name: `Integration camp ${runId}`,
        startDate: date(-7),
        endDate: date(30),
      });
      await create("campSessions", id("ses"), {
        clubObject: club,
        campObject: pointer("camps", id("cmp")),
        name: "Week 1",
        startDate: date(-7),
        endDate: date(30),
      });
      await create("campClasses", id("cls"), {
        clubObject: club,
        campObject: pointer("camps", id("cmp")),
        name: `Integration class ${runId}`,
      });
    });

    And("a participant registered in it, with a guardian", async () => {
      const camp = pointer("camps", id("cmp"));
      const session = pointer("campSessions", id("ses"));
      const campClass = pointer("campClasses", id("cls"));
      const confirmed = date(0);
      await create("participants", id("par"), {
        firstName: participant.firstName,
        lastName: participant.lastName,
        DOB: { __type: "Date", iso: "2015-05-01T00:00:00.000Z" },
        parentGuardianName: `${participant.guardianFirst} ${participant.guardianLast}`,
        parentGuardianEmail: participant.guardianEmail,
        parentGuardianMobile: "206-555-0199",
      });
      // The join points back at the registration, so it names the registration's objectId first.
      await create("registration_campSession", id("jn"), {
        campObject: camp,
        campSessionObject: session,
        campClassObject: campClass,
        registrationObject: pointer("registrations", id("reg")),
        confirmed_at: confirmed,
        status: "confirmed",
        priority: 1,
        waitlist: false,
      });
      await create("registrations", id("reg"), {
        clubObject: pointer("clubs", CLUB_ID),
        campObject: camp,
        confirmed_at: confirmed,
        status: "confirmed",
        participantsArray: [pointer("participants", id("par"))],
        sessions: [session],
        classes: [campClass],
        sessionJoinObjects: [pointer("registration_campSession", id("jn"))],
      });
    });

    When("clubspot-sync runs", async () => {
      await runCronJob("clubspot-sync", runId);
    });

    let person: any;

    Then("the CRM has the participant as a person", async () => {
      const fields = [
        "person_id.id",
        "person_id.first_name",
        "person_id.last_name",
        "person_id.my_contacts.relationship_type",
        "person_id.my_contacts.contact_id.first_name",
        "person_id.my_contacts.contact_id.last_name",
        "person_id.my_contacts.contact_id.email",
      ].join(",");
      const row = await asAdmin("GET", `/items/participants/${id("par")}?fields=${fields}`);
      person = row.person_id;
      expect(person).toMatchObject({ first_name: participant.firstName, last_name: participant.lastName });
    });

    And("the person's guardian is a person, linked as their guardian", () => {
      expect(person.my_contacts).toContainEqual({
        relationship_type: "guardian",
        contact_id: {
          first_name: participant.guardianFirst,
          last_name: participant.guardianLast,
          email: participant.guardianEmail,
        },
      });
    });
  });
});
