import { describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { feature } from "./feature";
import { asAdmin, newRunId, proxyOk, runCronJob } from "./support";

/** One scenario's group, program, and role holder, named by its run ID. */
function fixture() {
  const runId = newRunId();
  const groupEmail = `program.${runId}@example.test`;
  const personEmail = `volunteer.${runId}@example.test`;
  const ids = { group: "", program: "", person: "" };

  return {
    runId,
    personEmail,
    ids,

    async createGroup() {
      await proxyOk("workspace-fake", 8080, "POST", "/admin/directory/v1/groups", {
        email: groupEmail,
        name: `Program ${runId}`,
      });
    },

    // Discovery matches the row to the live group by email. Staff link a program to its row by hand.
    async createProgram() {
      const group = await asAdmin("POST", "/items/google_groups", { email: groupEmail, name: `Program ${runId}` });
      const program = await asAdmin("POST", "/items/programs", { name: `Program ${runId}`, google_group_id: group.id });
      ids.group = group.id;
      ids.program = program.id;
    },

    async createRoleHolder() {
      const person = await asAdmin("POST", "/items/people", {
        first_name: "Volunteer",
        last_name: runId,
        email: personEmail,
      });
      const role = await asAdmin("POST", "/items/program_roles", { name: `Volunteer ${runId}` });
      await asAdmin("POST", "/items/program_role_assignments", {
        person_id: person.id,
        program_id: ids.program,
        program_role_id: role.id,
      });
      ids.person = person.id;
    },

    async members(): Promise<string[]> {
      const members = await proxyOk(
        "workspace-fake",
        8080,
        "GET",
        `/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`,
      );
      return (members.members ?? []).map((member: { email: string }) => member.email);
    },

    async membershipRows(): Promise<{ id: string; email: string; added_at: string; removed_at: string | null }[]> {
      const query = new URLSearchParams({
        "filter[group_id][_eq]": ids.group,
        "filter[person_id][_eq]": ids.person,
      });
      return asAdmin("GET", `/items/google_group_memberships?${query}`);
    },
  };
}

describeFeature(feature("gsuite-sync.feature"), ({ Scenario }) => {
  Scenario("A program's role holder becomes a member of the program's group", ({ Given, And, When, Then }) => {
    const run = fixture();

    Given("a group in the Workspace fake", run.createGroup);
    And("a program in the CRM that points at the group", run.createProgram);
    And("a person in the CRM who holds a role in the program", run.createRoleHolder);

    When("gsuite-sync runs", async () => {
      await runCronJob("gsuite-sync", run.runId);
    });

    Then("the person is a member of the group", async () => {
      expect(await run.members()).toContain(run.personEmail);
    });
  });

  Scenario(
    "A member who leaves isn't re-added until staff delete their membership row",
    ({ Given, And, When, Then }) => {
      const run = fixture();
      const addedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      let removedRowId: string;

      Given("a group in the Workspace fake", run.createGroup);
      And("a program in the CRM that points at the group", run.createProgram);
      And("a person in the CRM who holds a role in the program", run.createRoleHolder);

      And("a membership row that says gsuite-sync added the person, who has since left the group", async () => {
        await asAdmin("POST", "/items/google_group_memberships", {
          group_id: run.ids.group,
          person_id: run.ids.person,
          email: run.personEmail,
          added_at: addedAt,
          removed_at: null,
        });
      });

      When("gsuite-sync runs", async () => {
        await runCronJob("gsuite-sync", run.runId);
      });

      Then("the person is not a member of the group", async () => {
        expect(await run.members()).not.toContain(run.personEmail);
      });

      And("the person's membership row records that they left", async () => {
        const rows = await run.membershipRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.removed_at).not.toBeNull();
        removedRowId = rows[0]!.id;
      });

      When("staff delete the person's membership row", async () => {
        await asAdmin("DELETE", `/items/google_group_memberships/${removedRowId}`);
      });

      // Job names must be unique.
      And("gsuite-sync runs again", async () => {
        await runCronJob("gsuite-sync", `${run.runId}-again`);
      });

      Then("the person is a member of the group", async () => {
        expect(await run.members()).toContain(run.personEmail);
      });

      And("the person has a fresh membership row", async () => {
        const rows = await run.membershipRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).not.toBe(removedRowId);
        expect(rows[0]!.removed_at).toBeNull();
        expect(Date.parse(rows[0]!.added_at)).toBeGreaterThan(Date.parse(addedAt));
      });
    },
  );
});
