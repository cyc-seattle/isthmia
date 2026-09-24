import winston from "winston";
import { ContactRow, PersonRow, ProgramRoleAssignmentRow } from "@cyc-seattle/crm";
import { CampRow, ClassRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import {
  DirectusClient,
  runQueue,
  SyncQueue,
  SyncTaskHandler,
  SyncTaskRow,
  targetFromKey,
  TaskOrphaned,
} from "@cyc-seattle/directus";
import { resolveGroupSettingsTemplate } from "@cyc-seattle/gsuite";
import { DirectoryReader, runAudit } from "./audit-writer.js";
import { SettingsReader } from "./audit-settings.js";
import { MemberAdder } from "./directory-writer.js";
import { GroupDirectoryReader, runDiscovery } from "./discovery-writer.js";
import { planProgramMembers } from "./membership.js";
import { planGroupNesting } from "./nesting.js";
import { planGroupOwners } from "./owners.js";
import { GoogleGroupRow, ProgramWithGoogleGroup } from "./schema.js";
import { planGroupsWithSettings } from "./settings.js";
import { SettingsApplier } from "./settings-writer.js";

const QUEUE = "gsuite-sync";
// Discovery gets its own queue value, not just its own kind, so it can be drained to completion
// before the other passes are even enqueued - `runQueue` claims whatever's due next with no
// notion of priority between kinds sharing one queue, so a shared drain couldn't guarantee this.
const DISCOVERY_QUEUE = "gsuite-sync-discovery";
const DISCOVERY_KIND = "sync_group_discovery";
const PROGRAM_MEMBERS_KIND = "sync_program_members";
const SETTINGS_KIND = "sync_group_settings";
const NESTING_KIND = "sync_group_nesting";
const OWNERS_KIND = "sync_group_owners";
const AUDIT_KIND = "sync_audit_findings";

/** The discovery pass's task, keyed on a fixed target - like the audit pass, it's one Workspace
 * scan each run, not one task per row. */
function discoveryTaskHandler(
  directus: DirectusClient,
  directory: GroupDirectoryReader,
  customer: string,
): SyncTaskHandler {
  return async () => {
    await runDiscovery({ directus, directory, customer });
  };
}

/** Enqueues the one `sync_group_discovery` task each run, on `DISCOVERY_QUEUE` rather than `QUEUE`
 * - see the note on `DISCOVERY_QUEUE`. */
export async function enqueueDiscovery(now: Date, queue: SyncQueue): Promise<string[]> {
  const task = await queue.enqueue({ queue: DISCOVERY_QUEUE, kind: DISCOVERY_KIND, target: "run" }, now);
  return task.id ? [task.id] : [];
}

/**
 * One program group's membership task queued per due program, per `enqueueDueProgramGroups`. A
 * worker only ever sees the claimed row, so the handler recovers the program id
 * `SyncQueue.enqueue` folded into the task's key.
 */
function programMembersTaskHandler(directus: DirectusClient, adder: MemberAdder, now: Date): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const programId = targetFromKey(task);

    const [
      programs,
      groups,
      classes,
      camps,
      registrationEntries,
      registrations,
      people,
      contacts,
      programRoleAssignments,
    ] = await Promise.all([
      directus.readItems<ProgramWithGoogleGroup>("programs", { limit: -1 }),
      directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
      directus.readItems<ClassRow>("classes", { limit: -1 }),
      directus.readItems<CampRow>("camps", { limit: -1 }),
      directus.readItems<RegistrationEntryRow>("registration_entries", { limit: -1 }),
      directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
      directus.readItems<PersonRow>("people", { limit: -1 }),
      directus.readItems<ContactRow>("contacts", { limit: -1 }),
      directus.readItems<ProgramRoleAssignmentRow>("program_role_assignments", { limit: -1 }),
    ]);

    const program = programs.find((row) => row.id === programId);
    if (!program?.google_group_id) {
      throw new TaskOrphaned(`Program ${programId} has no google_group_id; this task should not have been enqueued`);
    }
    const group = groups.find((row) => row.id === program.google_group_id);
    if (!group || group.archived) {
      throw new TaskOrphaned(
        `Program ${programId} references google_groups id ${program.google_group_id}, which is missing or archived`,
      );
    }

    const emails = planProgramMembers(
      programId,
      { classes, camps, registrationEntries, registrations, people, contacts, programRoleAssignments },
      now,
    );
    for (const email of emails) {
      await adder.addMember(group.email, email, "MEMBER");
    }
  };
}

/**
 * Enqueues one `sync_program_members` task per program with a `google_group_id` set. That's the
 * only gate: a program whose only current activity is a `program_role_assignments` row - an
 * off-season program, or one with no class yet - still needs its role holders synced, so this no
 * longer requires a due class the way it once did (#149). The membership window that decides
 * *which* participants get added lives in `planProgramMembers`, not here.
 * `SyncQueue.enqueue`'s composed `key` means a program already queued from a prior run is reset to
 * pending here, not duplicated.
 */
export async function enqueueDueProgramGroups(
  now: Date,
  directus: DirectusClient,
  queue: SyncQueue,
): Promise<string[]> {
  const [programs, groups] = await Promise.all([
    directus.readItems<ProgramWithGoogleGroup>("programs", { limit: -1 }),
    directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
  ]);
  const archivedGroupIds = new Set(groups.filter((group) => group.archived && group.id).map((group) => group.id));

  const taskIds: string[] = [];
  for (const program of programs) {
    if (!program.id || !program.google_group_id || archivedGroupIds.has(program.google_group_id)) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: PROGRAM_MEMBERS_KIND, target: program.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

/** A `google_groups` row's settings task, keyed on its own id. Resolves `settings_template` to a
 * `@cyc-seattle/gsuite` template by name and applies it - an unrecognized name (a typo, most
 * likely) throws a plain error rather than `TaskOrphaned`, so the task keeps retrying and
 * eventually flags `needs_attention` instead of quietly leaving the group unmanaged. */
function groupSettingsTaskHandler(directus: DirectusClient, applier: SettingsApplier): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const groupId = targetFromKey(task);
    const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

    const group = groups.find((row) => row.id === groupId);
    if (!group || group.archived) {
      throw new TaskOrphaned(
        `google_groups row ${groupId} is missing or archived; this task should not have been enqueued`,
      );
    }
    if (group.settings_template == null) {
      throw new TaskOrphaned(
        `google_groups row ${groupId} has no settings_template; this task should not have been enqueued`,
      );
    }

    await applier.patchSettings(group.email, resolveGroupSettingsTemplate(group.settings_template));
  };
}

/** Enqueues one `sync_group_settings` task per `google_groups` row with a `settings_template` set. */
export async function enqueueGroupSettings(now: Date, directus: DirectusClient, queue: SyncQueue): Promise<string[]> {
  const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

  const taskIds: string[] = [];
  for (const group of planGroupsWithSettings(groups)) {
    if (!group.id) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: SETTINGS_KIND, target: group.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

/** A `google_groups` row's nesting task, keyed on the nesting (child) group's own id - it joins
 * its parent group the same way a person does, per `MemberAdder`. */
function groupNestingTaskHandler(directus: DirectusClient, adder: MemberAdder): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const groupId = targetFromKey(task);
    const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

    const [nesting] = planGroupNesting(groups).filter(({ child }) => child.id === groupId);
    if (!nesting) {
      throw new TaskOrphaned(
        `google_groups row ${groupId} has no resolvable parent_id; this task should not have been enqueued`,
      );
    }

    await adder.addMember(nesting.parent.email, nesting.child.email, "MEMBER");
  };
}

/** Enqueues one `sync_group_nesting` task per `google_groups` row whose `parent_id` resolves to
 * another row - see `planGroupNesting`. */
export async function enqueueGroupNesting(now: Date, directus: DirectusClient, queue: SyncQueue): Promise<string[]> {
  const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

  const taskIds: string[] = [];
  for (const { child } of planGroupNesting(groups)) {
    if (!child.id) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: NESTING_KIND, target: child.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

/** A `google_groups` row's owners task, keyed on its own id. Owners come from `owners`, a config
 * list rather than any CRM row - see `planGroupOwners`. */
function groupOwnersTaskHandler(
  directus: DirectusClient,
  adder: MemberAdder,
  owners: readonly string[],
): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const groupId = targetFromKey(task);
    const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

    const group = groups.find((row) => row.id === groupId);
    if (!group || group.archived) {
      throw new TaskOrphaned(
        `google_groups row ${groupId} is missing or archived; this task should not have been enqueued`,
      );
    }

    for (const email of planGroupOwners(owners)) {
      await adder.addMember(group.email, email, "OWNER");
    }
  };
}

/** Enqueues one `sync_group_owners` task per `google_groups` row. */
export async function enqueueGroupOwners(now: Date, directus: DirectusClient, queue: SyncQueue): Promise<string[]> {
  const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

  const taskIds: string[] = [];
  for (const group of groups) {
    if (!group.id || group.archived) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: OWNERS_KIND, target: group.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

/** The audit pass's task, keyed on a fixed target - it's one comparison over every group and
 * program each run, not one task per row like the write passes. */
function auditTaskHandler(
  directus: DirectusClient,
  directory: DirectoryReader,
  settingsReader: SettingsReader,
  groupOwners: readonly string[],
  now: Date,
): SyncTaskHandler {
  return async () => {
    await runAudit({ directus, directory, settings: settingsReader, now, groupOwners });
  };
}

/** Enqueues the one `sync_audit_findings` task each run - see `auditTaskHandler`. Unlike the other
 * `enqueue*` functions, this needs no Directus read: the task's target is fixed, not derived from
 * any row. */
export async function enqueueAudit(now: Date, queue: SyncQueue): Promise<string[]> {
  const task = await queue.enqueue({ queue: QUEUE, kind: AUDIT_KIND, target: "run" }, now);
  return task.id ? [task.id] : [];
}

export interface RunGroupSyncOptions {
  now: Date;
  directus: DirectusClient;
  queue: SyncQueue;
  adder: MemberAdder;
  settingsApplier: SettingsApplier;
  directory: DirectoryReader & GroupDirectoryReader;
  settingsReader: SettingsReader;
  /** Break-glass super-admin emails the owners pass grants OWNER on every group. */
  groupOwners: readonly string[];
  /** The Workspace customer id the discovery pass lists groups for - see `DirectoryClient.listGroups`. */
  customer: string;
}

export interface RunGroupSyncResult {
  status: "ok" | "failed";
  tasksChecked: number;
  tasksFailed: number;
}

/**
 * One job execution: runs discovery to completion first (its own queue - see `DISCOVERY_QUEUE`),
 * then enqueues every due task across the other four passes (membership, settings, nesting,
 * owners) plus audit, and drains the `gsuite-sync` queue once. Those five share the
 * queue, so they're claimed and run together here rather than through separate drains - `taskKey`
 * composing `queue:kind:target` is what lets a settings task and a members task on the same group
 * coexist without colliding. Each task is isolated from its siblings' failures by the queue's own
 * per-task retry.
 */
export async function runGroupSync(options: RunGroupSyncOptions): Promise<RunGroupSyncResult> {
  const { now, directus, queue, adder, settingsApplier, directory, settingsReader, groupOwners, customer } = options;

  let tasksFailed = 0;
  let checkedTaskIds: string[] = [];
  let runError: string | undefined;

  try {
    const discoveryEnqueuedIds = await enqueueDiscovery(now, queue);
    const { taskIds: discoveryClaimedIds } = await runQueue(directus, DISCOVERY_QUEUE, {
      [DISCOVERY_KIND]: discoveryTaskHandler(directus, directory, customer),
    });

    const enqueued = await Promise.all([
      enqueueDueProgramGroups(now, directus, queue),
      enqueueGroupSettings(now, directus, queue),
      enqueueGroupNesting(now, directus, queue),
      enqueueGroupOwners(now, directus, queue),
      enqueueAudit(now, queue),
    ]);
    const enqueuedTaskIds = enqueued.flat();

    const { taskIds: claimedTaskIds } = await runQueue(directus, QUEUE, {
      [PROGRAM_MEMBERS_KIND]: programMembersTaskHandler(directus, adder, now),
      [SETTINGS_KIND]: groupSettingsTaskHandler(directus, settingsApplier),
      [NESTING_KIND]: groupNestingTaskHandler(directus, adder),
      [OWNERS_KIND]: groupOwnersTaskHandler(directus, adder, groupOwners),
      [AUDIT_KIND]: auditTaskHandler(directus, directory, settingsReader, groupOwners, now),
    });

    // The union, not just what this run enqueued: a task the seeder orphaned earlier (its program
    // or group deleted, say) is claimed and retired here without ever being re-enqueued, and still
    // belongs in what this run reports on - see `TaskOrphaned`.
    checkedTaskIds = [
      ...new Set([...discoveryEnqueuedIds, ...discoveryClaimedIds, ...enqueuedTaskIds, ...claimedTaskIds]),
    ];

    if (checkedTaskIds.length > 0) {
      const [mainTasks, discoveryTasks] = await Promise.all([
        directus.readItems<SyncTaskRow>("sync_tasks", { filter: { queue: { _eq: QUEUE } }, limit: -1 }),
        directus.readItems<SyncTaskRow>("sync_tasks", { filter: { queue: { _eq: DISCOVERY_QUEUE } }, limit: -1 }),
      ]);
      const taskById = new Map(
        [...mainTasks, ...discoveryTasks].filter((task) => task.id).map((task) => [task.id as string, task]),
      );
      // Neither "done" nor "cancelled" is a failure worth surfacing: "cancelled" means the task's
      // own precondition evaporated, not that anything is broken. A task still "pending" is,
      // whether it failed once or has been failing for weeks (`needs_attention`).
      tasksFailed = checkedTaskIds.filter((id) => {
        const status = taskById.get(id)?.status;
        return status !== "done" && status !== "cancelled";
      }).length;
    }
  } catch (error) {
    winston.error("Group sync run failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  const status: "ok" | "failed" = runError !== undefined || tasksFailed > 0 ? "failed" : "ok";
  return { status, tasksChecked: checkedTaskIds.length, tasksFailed };
}
