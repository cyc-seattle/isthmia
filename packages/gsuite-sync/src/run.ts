import winston from "winston";
import { ContactRow, OfferingRow, PersonRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/crm";
import {
  DirectusClient,
  runQueue,
  SyncQueue,
  SyncTaskHandler,
  SyncTaskRow,
  targetFromKey,
} from "@cyc-seattle/directus";
import { MemberAdder } from "./directory-writer.js";
import { planClassMembers } from "./membership.js";
import { isCurrentOrFutureOffering } from "./offerings.js";
import { ClassWithGoogleGroup, GoogleGroupRow } from "./schema.js";

const QUEUE = "gsuite-sync";
const CLASS_MEMBERS_KIND = "sync_class_members";

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

export interface RunMembershipSyncOptions {
  now: Date;
  directus: DirectusClient;
  queue: SyncQueue;
  adder: MemberAdder;
}

export interface RunMembershipSyncResult {
  status: "ok" | "failed";
  classesChecked: number;
  classesFailed: number;
}

/**
 * One job execution: enqueues every due class's membership task, then drains the `gsuite-sync`
 * queue. Each class is isolated from its siblings' failures by the queue's own per-task retry.
 */
export async function runMembershipSync(options: RunMembershipSyncOptions): Promise<RunMembershipSyncResult> {
  const { now, directus, queue, adder } = options;

  let classesFailed = 0;
  let taskIds: string[] = [];
  let runError: string | undefined;

  try {
    taskIds = await enqueueDueClassGroups(now, directus, queue);
    await runQueue(directus, QUEUE, { [CLASS_MEMBERS_KIND]: classMembersTaskHandler(directus, adder) });

    if (taskIds.length > 0) {
      const tasks = await directus.readItems<SyncTaskRow>("sync_tasks", {
        filter: { queue: { _eq: QUEUE } },
        limit: -1,
      });
      const taskById = new Map(tasks.filter((task) => task.id).map((task) => [task.id as string, task]));
      // Not "done" covers both a retry the queue has since scheduled ("pending") and one that's
      // exhausted its budget ("failed") - either way this run saw a failure worth surfacing.
      classesFailed = taskIds.filter((id) => taskById.get(id)?.status !== "done").length;
    }
  } catch (error) {
    winston.error("Membership sync run failed", {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    runError = error instanceof Error ? error.message : String(error);
  }

  const status: "ok" | "failed" = runError !== undefined || classesFailed > 0 ? "failed" : "ok";
  return { status, classesChecked: taskIds.length, classesFailed };
}
