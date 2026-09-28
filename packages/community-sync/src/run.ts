import winston from "winston";
import { ContactRow } from "@cyc-seattle/crm";
import { CampRow, ClassRow, ParticipantRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { DirectusClient, finishSyncRun, startSyncRun } from "@cyc-seattle/directus";
import { GroupMember } from "@cyc-seattle/gsuite";
import { AuthentikClient } from "./authentik.js";
import { FamilyGroupTables, planFamilyGroupEmails } from "./family-group.js";
import { reconcileGroupMembership } from "./group-executor.js";
import { runLoginEmailPass } from "./login-email-executor.js";
import { PersonWithLoginEmail } from "./schema.js";
import { planStaffGroupEmails } from "./staff-group.js";

const SOURCE = "community-sync";
const STAFF_GROUP_NAME = "staff";
const FAMILIES_GROUP_NAME = "families";

/** The slice of `DirectoryClient` the staff pass reads through. */
export interface StaffGroupSource {
  listMembers(groupKey: string, options?: { includeDerivedMembership?: boolean }): Promise<GroupMember[]>;
}

export interface RunCommunitySyncOptions {
  now: Date;
  directus: DirectusClient;
  authentik: AuthentikClient;
  directory: StaffGroupSource;
  /** The Google Group `staff` mirrors, e.g. `all@cyccommunitysailing.org`. */
  staffSourceGroup: string;
  /** Gates the family pass - off by default until the board approves sharing names and contact
   * information (see the design's "Launch prerequisite"). */
  families: boolean;
  /** Overrides `planGroupDiff`'s guard against emptying a group or removing more than half its
   * current members - see group-diff.ts. */
  allowLargeRemoval?: boolean;
}

export interface RunCommunitySyncResult {
  status: "ok" | "failed";
  counts: Record<string, number>;
}

async function readFamilyGroupTables(directus: DirectusClient): Promise<FamilyGroupTables> {
  const [camps, classes, registrationEntries, registrations, participants, contacts, people] = await Promise.all([
    directus.readItems<CampRow>("camps", { fields: ["id", "start_date", "end_date"], limit: -1 }),
    directus.readItems<ClassRow>("classes", { fields: ["id", "camp_id"], limit: -1 }),
    directus.readItems<RegistrationEntryRow>("registration_entries", {
      fields: ["id", "registration_id", "class_id", "status"],
      limit: -1,
    }),
    directus.readItems<RegistrationRow>("registrations", { fields: ["id", "participant_id"], limit: -1 }),
    directus.readItems<Pick<ParticipantRow, "id" | "person_id">>("participants", {
      fields: ["id", "person_id"],
      limit: -1,
    }),
    directus.readItems<ContactRow>("contacts", {
      fields: ["subject_id", "contact_id", "relationship_type"],
      limit: -1,
    }),
    directus.readItems<PersonWithLoginEmail>("people", { fields: ["id", "login_email"], limit: -1 }),
  ]);
  return { camps, classes, registrationEntries, registrations, participants, contacts, people };
}

/**
 * One job execution: the login-email pass, then the staff group pass, then - only when
 * `families` is set - the family group pass. Each pass's counts land in the run's `sync_runs` row
 * regardless of outcome; a pass left off contributes no keys rather than zeros, so a `sync_runs`
 * row shows plainly whether the family pass ran at all.
 */
export async function runCommunitySync(options: RunCommunitySyncOptions): Promise<RunCommunitySyncResult> {
  const { now, directus, authentik, directory, staffSourceGroup, families, allowLargeRemoval = false } = options;

  const run = await startSyncRun(directus, SOURCE, now);
  const counts: Record<string, number> = {};
  let error: string | undefined;

  try {
    const loginEmailResult = await runLoginEmailPass(directus);
    counts["loginEmailUpdated"] = loginEmailResult.updated;
    counts["loginEmailSkipped"] = loginEmailResult.skipped;

    const staffMembers = await directory.listMembers(staffSourceGroup, { includeDerivedMembership: true });
    const staffPlan = planStaffGroupEmails(staffMembers);
    const staffResult = await reconcileGroupMembership(authentik, STAFF_GROUP_NAME, staffPlan.emails, {
      allowLargeRemoval,
    });
    counts["staffAdded"] = staffResult.added;
    counts["staffRemoved"] = staffResult.removed;
    counts["staffUsersCreated"] = staffResult.usersCreated;
    counts["staffSkipped"] = staffPlan.skipped;

    if (families) {
      const tables = await readFamilyGroupTables(directus);
      const familyPlan = planFamilyGroupEmails(tables, now);
      const familyResult = await reconcileGroupMembership(authentik, FAMILIES_GROUP_NAME, familyPlan.emails, {
        allowLargeRemoval,
      });
      counts["familyAdded"] = familyResult.added;
      counts["familyRemoved"] = familyResult.removed;
      counts["familyUsersCreated"] = familyResult.usersCreated;
      counts["familySkipped"] = familyPlan.skipped;
    } else {
      winston.info("Family pass is off (--families not set); skipping");
    }
  } catch (caught) {
    winston.error("Community sync run failed", {
      error: caught instanceof Error ? { message: caught.message, stack: caught.stack } : caught,
    });
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const status: "ok" | "failed" = error !== undefined ? "failed" : "ok";
  if (run?.id) {
    await finishSyncRun(directus, run.id, new Date(), {
      status: status === "ok" ? "succeeded" : "failed",
      counts,
      error,
    });
  }

  return { status, counts };
}
