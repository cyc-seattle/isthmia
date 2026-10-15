import { describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { feature } from "./feature";
import { asAdmin, newRunId, proxyOk, runCronJob } from "./support";

describeFeature(feature("gsuite-sync.feature"), ({ Scenario }) => {
  Scenario("A program's role holder becomes a member of the program's group", ({ Given, And, When, Then }) => {
    const runId = newRunId();
    const groupEmail = `program.${runId}@example.test`;
    const personEmail = `volunteer.${runId}@example.test`;
    let programId: string;

    Given("a group in the Workspace fake", async () => {
      await proxyOk("workspace-fake", 8080, "POST", "/admin/directory/v1/groups", {
        email: groupEmail,
        name: `Program ${runId}`,
      });
    });

    // Discovery matches the row to the live group by email. Staff link a program to its row by hand.
    And("a program in the CRM that points at the group", async () => {
      const group = await asAdmin("POST", "/items/google_groups", { email: groupEmail, name: `Program ${runId}` });
      const program = await asAdmin("POST", "/items/programs", { name: `Program ${runId}`, google_group_id: group.id });
      programId = program.id;
    });

    And("a person in the CRM who holds a role in the program", async () => {
      const person = await asAdmin("POST", "/items/people", {
        first_name: "Volunteer",
        last_name: runId,
        email: personEmail,
      });
      const role = await asAdmin("POST", "/items/program_roles", { name: `Volunteer ${runId}` });
      await asAdmin("POST", "/items/program_role_assignments", {
        person_id: person.id,
        program_id: programId,
        program_role_id: role.id,
      });
    });

    When("gsuite-sync runs", async () => {
      await runCronJob("gsuite-sync", runId);
    });

    Then("the person is a member of the group", async () => {
      const members = await proxyOk(
        "workspace-fake",
        8080,
        "GET",
        `/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`,
      );
      expect((members.members ?? []).map((member: { email: string }) => member.email)).toContain(personEmail);
    });
  });
});
