import winston from "winston";
import {
  ContactRow,
  OfferingRow,
  PersonRow,
  ProgramRoleRow,
  RegistrationEntryRow,
  RegistrationRow,
} from "@cyc-seattle/crm";
import {
  DirectusClient,
  runQueue,
  SyncQueue,
  SyncTaskHandler,
  SyncTaskRow,
  targetFromKey,
} from "@cyc-seattle/directus";
import { GroupSettings } from "@cyc-seattle/gsuite";
import { MemberAdder } from "./directory-writer.js";
import { planClassMembers } from "./membership.js";
import { planGroupNesting } from "./nesting.js";
import { isCurrentOrFutureOffering } from "./offerings.js";
import { planGroupOwners } from "./owners.js";
import { planProgramManagers } from "./roles.js";
import { ClassWithGoogleGroup, GoogleGroupRoleRow, GoogleGroupRow, ProgramWithGoogleGroup } from "./schema.js";
import { planGroupsWithSettings } from "./settings.js";
import { SettingsApplier } from "./settings-writer.js";

const QUEUE = "gsuite-sync";
const CLASS_MEMBERS_KIND = "sync_class_members";
const SETTINGS_KIND = "sync_group_settings";
const NESTING_KIND = "sync_group_nesting";
const MANAGERS_KIND = "sync_group_managers";
const OWNERS_KIND = "sync_group_owners";

/**
 * One class group's membership task queued per due class, per `enqueueDueClassGroups`. A worker
 * only ever sees the claimed row, so the handler recovers the class id `SyncQueue.enqueue` folded
 * into the task's key.
 */
function classMembersTaskHandler(directus: DirectusClient, adder: MemberAdder): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const classId = targetFromKey(task);

    const [classes, groups, registrationEntries, registrations, people, contacts] = await Promise.all([
      directus.readItems<ClassWithGoogleGroup>("classes", { limit: -1 }),
      directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
      directus.readItems<RegistrationEntryRow>("registration_entries", { limit: -1 }),
      directus.readItems<RegistrationRow>("registrations", { limit: -1 }),
      directus.readItems<PersonRow>("people", { limit: -1 }),
      directus.readItems<ContactRow>("contacts", { limit: -1 }),
    ]);

    const cls = classes.find((row) => row.id === classId);
    if (!cls?.google_group_id) {
      throw new Error(`Class ${classId} has no google_group_id; this task should not have been enqueued`);
    }
    const group = groups.find((row) => row.id === cls.google_group_id);
    if (!group) {
      throw new Error(`Class ${classId} references google_groups id ${cls.google_group_id}, which doesn't exist`);
    }

    const emails = planClassMembers(classId, { registrationEntries, registrations, people, contacts });
    for (const email of emails) {
      await adder.addMember(group.email, email, "MEMBER");
    }
  };
}

/**
 * Enqueues one `sync_class_members` task per class whose `google_group_id` is set and whose
 * offering is current or upcoming (see `isCurrentOrFutureOffering`) - the "current offering
 * forward" seed scope. `SyncQueue.enqueue`'s composed `key` means a class already queued from a
 * prior run is reset to pending here, not duplicated.
 */
export async function enqueueDueClassGroups(now: Date, directus: DirectusClient, queue: SyncQueue): Promise<string[]> {
  const [classes, offerings] = await Promise.all([
    directus.readItems<ClassWithGoogleGroup>("classes", { limit: -1 }),
    directus.readItems<OfferingRow>("offerings", { limit: -1 }),
  ]);
  const offeringById = new Map(offerings.filter((row) => row.id).map((row) => [row.id as string, row]));

  const taskIds: string[] = [];
  for (const cls of classes) {
    if (!cls.id || !cls.google_group_id) {
      continue;
    }
    const offering = offeringById.get(cls.offering_id);
    if (!offering || !isCurrentOrFutureOffering(offering, now)) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: CLASS_MEMBERS_KIND, target: cls.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

/** A `google_groups` row's settings task, keyed on its own id. Applies `settings_template`
 * verbatim - it's already the Groups Settings API payload staff copied from `gam/templates/`. */
function groupSettingsTaskHandler(directus: DirectusClient, applier: SettingsApplier): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const groupId = targetFromKey(task);
    const groups = await directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 });

    const group = groups.find((row) => row.id === groupId);
    if (!group) {
      throw new Error(`google_groups row ${groupId} not found; this task should not have been enqueued`);
    }
    if (group.settings_template == null) {
      throw new Error(`google_groups row ${groupId} has no settings_template; this task should not have been enqueued`);
    }

    await applier.patchSettings(group.email, group.settings_template as GroupSettings);
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
      throw new Error(
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

/** A program's manager task, keyed on its Google Group's id. `program_roles` current on `now`
 * grant whatever `google_group_roles` maps their role type to - `MANAGER` for both seeded types. */
function groupManagersTaskHandler(directus: DirectusClient, adder: MemberAdder, now: Date): SyncTaskHandler {
  return async (task: SyncTaskRow) => {
    const groupId = targetFromKey(task);

    const [programs, groups, programRoles, groupRoles, people] = await Promise.all([
      directus.readItems<ProgramWithGoogleGroup>("programs", { limit: -1 }),
      directus.readItems<GoogleGroupRow>("google_groups", { limit: -1 }),
      directus.readItems<ProgramRoleRow>("program_roles", { limit: -1 }),
      directus.readItems<GoogleGroupRoleRow>("google_group_roles", { limit: -1 }),
      directus.readItems<PersonRow>("people", { limit: -1 }),
    ]);

    const program = programs.find((row) => row.google_group_id === groupId);
    if (!program?.id) {
      throw new Error(`No program references google_groups id ${groupId}; this task should not have been enqueued`);
    }
    const group = groups.find((row) => row.id === groupId);
    if (!group) {
      throw new Error(`Program ${program.id} references google_groups id ${groupId}, which doesn't exist`);
    }

    const assignments = planProgramManagers(program.id, { programRoles, groupRoles, people }, now);
    for (const { email, role } of assignments) {
      await adder.addMember(group.email, email, role);
    }
  };
}

/** Enqueues one `sync_group_managers` task per program with a `google_group_id` set. */
export async function enqueueGroupManagers(now: Date, directus: DirectusClient, queue: SyncQueue): Promise<string[]> {
  const programs = await directus.readItems<ProgramWithGoogleGroup>("programs", { limit: -1 });

  const taskIds: string[] = [];
  for (const program of programs) {
    if (!program.google_group_id) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: MANAGERS_KIND, target: program.google_group_id }, now);
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
    if (!group) {
      throw new Error(`google_groups row ${groupId} not found; this task should not have been enqueued`);
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
    if (!group.id) {
      continue;
    }
    const task = await queue.enqueue({ queue: QUEUE, kind: OWNERS_KIND, target: group.id }, now);
    if (task.id) {
      taskIds.push(task.id);
    }
  }
  return taskIds;
}

export interface RunGroupSyncOptions {
  now: Date;
  directus: DirectusClient;
  queue: SyncQueue;
  adder: MemberAdder;
  settingsApplier: SettingsApplier;
  /** Break-glass super-admin emails the owners pass grants OWNER on every group. */
  groupOwners: readonly string[];
}

export interface RunGroupSyncResult {
  status: "ok" | "failed";
  tasksChecked: number;
  tasksFailed: number;
}

/**
 * One job execution: enqueues every due task across all five passes (membership, settings,
 * nesting, managers, owners), then drains the `gsuite-sync` queue once. All five share the queue,
 * so they're claimed and run together here rather than through separate drains - `taskKey`
 * composing `queue:kind:target` is what lets a settings task and a members task on the same group
 * coexist without colliding. Each task is isolated from its siblings' failures by the queue's own
 * per-task retry.
 */
export async function runGroupSync(options: RunGroupSyncOptions): Promise<RunGroupSyncResult> {
  const { now, directus, queue, adder, settingsApplier, groupOwners } = options;

  let tasksFailed = 0;
  let taskIds: string[] = [];
  let runError: string | undefined;

  try {
    const enqueued = await Promise.all([
      enqueueDueClassGroups(now, directus, queue),
      enqueueGroupSettings(now, directus, queue),
      enqueueGroupNesting(now, directus, queue),
      enqueueGroupManagers(now, directus, queue),
      enqueueGroupOwners(now, directus, queue),
    ]);
    taskIds = enqueued.flat();

    await runQueue(directus, QUEUE, {
      [CLASS_MEMBERS_KIND]: classMembersTaskHandler(directus, adder),
      [SETTINGS_KIND]: groupSettingsTaskHandler(directus, settingsApplier),
      [NESTING_KIND]: groupNestingTaskHandler(directus, adder),
      [MANAGERS_KIND]: groupManagersTaskHandler(directus, adder, now),
      [OWNERS_KIND]: groupOwnersTaskHandler(directus, adder, groupOwners),
    });

    if (taskIds.length > 0) {
      const tasks = await directus.readItems<SyncTaskRow>("sync_tasks", {
        filter: { queue: { _eq: QUEUE } },
        limit: -1,
      });
      const taskById = new Map(tasks.filter((task) => task.id).map((task) => [task.id as string, task]));
      // Not "done" covers both a retry the queue has since scheduled ("pending") and one that's
      // exhausted its budget ("failed") - either way this run saw a failure worth surfacing.
      tasksFailed = taskIds.filter((id) => taskById.get(id)?.status !== "done").length;
    }
  } catch (error) {
    winston.error("Group sync run failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  const status: "ok" | "failed" = runError !== undefined || tasksFailed > 0 ? "failed" : "ok";
  return { status, tasksChecked: taskIds.length, tasksFailed };
}
