import { describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { feature } from "./feature";
import { asAdmin, newRunId, proxyOk, runCronJob } from "./support";

interface MembershipRow {
  id: string;
  added_at: string;
  removed_at: string | null;
}

describeFeature(feature("gsuite-sync.feature"), ({ Scenario }) => {
  Scenario(
    "Role holders join the program's group, and one who leaves stays out until staff let them back",
    ({ Given, And, When, Then }) => {
      const runId = newRunId();
      const groupEmail = `program.${runId}@example.test`;
      const personEmail = `volunteer.${runId}@example.test`;
      const leaverEmail = `leaver.${runId}@example.test`;
      const leaverAddedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      let groupId: string;
      let programId: string;
      let leaverId: string;
      let removedRowId: string | undefined;

      async function holdRole(firstName: string, email: string): Promise<string> {
        const person = await asAdmin("POST", "/items/people", { first_name: firstName, last_name: runId, email });
        const role = await asAdmin("POST", "/items/program_roles", { name: `${firstName} ${runId}` });
        await asAdmin("POST", "/items/program_role_assignments", {
          person_id: person.id,
          program_id: programId,
          program_role_id: role.id,
        });
        return person.id;
      }

      async function members(): Promise<string[]> {
        const body = await proxyOk(
          "workspace-fake",
          8080,
          "GET",
          `/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`,
        );
        return (body.members ?? []).map((member: { email: string }) => member.email);
      }

      async function leaverRows(): Promise<MembershipRow[]> {
        const query = new URLSearchParams({ "filter[group_id][_eq]": groupId, "filter[person_id][_eq]": leaverId });
        return asAdmin("GET", `/items/google_group_memberships?${query}`);
      }

      Given("a group in the Workspace fake", async () => {
        await proxyOk("workspace-fake", 8080, "POST", "/admin/directory/v1/groups", {
          email: groupEmail,
          name: `Program ${runId}`,
        });
      });

      // Discovery matches the row to the live group by email. Staff link a program to its row by hand.
      And("a program in the CRM that points at the group", async () => {
        const group = await asAdmin("POST", "/items/google_groups", { email: groupEmail, name: `Program ${runId}` });
        const program = await asAdmin("POST", "/items/programs", {
          name: `Program ${runId}`,
          google_group_id: group.id,
        });
        groupId = group.id;
        programId = program.id;
      });

      And("a person in the CRM who holds a role in the program", async () => {
        await holdRole("Volunteer", personEmail);
      });

      And("a second role holder whom gsuite-sync added to the group, who has since left it", async () => {
        leaverId = await holdRole("Leaver", leaverEmail);
        await asAdmin("POST", "/items/google_group_memberships", {
          group_id: groupId,
          person_id: leaverId,
          email: leaverEmail,
          added_at: leaverAddedAt,
          removed_at: null,
        });
      });

      When("gsuite-sync runs", async () => {
        await runCronJob("gsuite-sync", runId);
      });

      Then("the person is a member of the group", async () => {
        expect(await members()).toContain(personEmail);
      });

      And("the leaver is not a member of the group", async () => {
        expect(await members()).not.toContain(leaverEmail);
      });

      And("the leaver's membership row records that they left", async () => {
        const rows = await leaverRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.removed_at).not.toBeNull();
        removedRowId = rows[0]!.id;
      });

      When("staff delete the leaver's membership row", async () => {
        if (!removedRowId) {
          throw new Error("No removed membership row to delete: the step that finds it failed.");
        }
        await asAdmin("DELETE", `/items/google_group_memberships/${removedRowId}`);
      });

      // Job names must be unique.
      And("gsuite-sync runs again", async () => {
        await runCronJob("gsuite-sync", `${runId}-again`);
      });

      Then("the leaver is a member of the group", async () => {
        expect(await members()).toContain(leaverEmail);
      });

      And("the leaver has a fresh membership row", async () => {
        const rows = await leaverRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).not.toBe(removedRowId);
        expect(rows[0]!.removed_at).toBeNull();
        expect(Date.parse(rows[0]!.added_at)).toBeGreaterThan(Date.parse(leaverAddedAt));
      });
    },
  );
});
