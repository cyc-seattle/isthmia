import { DirectusClient } from "./client.js";
import {
  claimableTasks,
  EnqueueInput,
  planCancel,
  planClaim,
  planEnqueue,
  planFailure,
  planSuccess,
  taskKey,
} from "./queue.js";
import { SyncTaskRow } from "./sync-tasks.js";

/** Does one task's work. Enqueuing child tasks (via `parent_id`) is the handler's job, not the
 * worker's - the worker has no notion that a task tree exists. */
export type SyncTaskHandler = (task: SyncTaskRow) => Promise<void>;

/** Thrown by a handler when a precondition the seeder guaranteed at enqueue time is gone by the
 * time the task is claimed - e.g. a class had its `google_group_id` cleared. Retrying can never
 * succeed, so `runQueue` retires the task as `cancelled` instead of treating this as a failure. */
export class TaskOrphaned extends Error {}

/**
 * Thin executor over `DirectusClient` and the pure decisions in `queue.ts`. Holds no decision
 * logic of its own - see `planClaim` for why claiming needs no lease.
 */
export class SyncQueue {
  constructor(private readonly directus: DirectusClient) {}

  /** Creates a task, or resets an existing one with the same `key` back to pending. This is what
   * makes a re-enqueue update in place instead of piling up a duplicate row. */
  async enqueue(input: EnqueueInput, now = new Date()): Promise<SyncTaskRow> {
    const [existing] = await this.directus.readItems<SyncTaskRow>("sync_tasks", {
      filter: { key: { _eq: taskKey(input) } },
    });
    const row = planEnqueue(input, now);
    if (existing?.id) {
      return this.directus.updateItem<SyncTaskRow>("sync_tasks", existing.id, row);
    }
    const [created] = await this.directus.createItems<SyncTaskRow>("sync_tasks", [row as SyncTaskRow]);
    if (!created) {
      throw new Error("Directus did not return the created sync_tasks row");
    }
    return created;
  }
}

/**
 * Claims and runs every due task in `queue`, one at a time, until none remain. A handler may
 * enqueue its own children mid-run; those become claimable on their own once written, so this loop
 * makes no assumption about the shape of the tree it's walking - it only ever sees a flat list of
 * what's due right now.
 */
export async function runQueue(
  directus: DirectusClient,
  queue: string,
  handlers: Readonly<Record<string, SyncTaskHandler>>,
  now: () => Date = () => new Date(),
): Promise<{ processed: number; taskIds: string[] }> {
  const taskIds: string[] = [];
  for (;;) {
    const tasks = await directus.readItems<SyncTaskRow>("sync_tasks", {
      filter: { queue: { _eq: queue } },
      limit: -1,
    });
    const [task] = claimableTasks(tasks, now());
    if (!task?.id) {
      return { processed: taskIds.length, taskIds };
    }

    const handler = handlers[task.kind];
    if (!handler) {
      throw new Error(`No handler registered for sync_tasks kind "${task.kind}" in queue "${queue}"`);
    }

    const claimed = await directus.updateItem<SyncTaskRow>("sync_tasks", task.id, planClaim(task, now()));
    try {
      await handler(claimed);
      await directus.updateItem<SyncTaskRow>("sync_tasks", task.id, planSuccess(now()));
    } catch (error) {
      if (error instanceof TaskOrphaned) {
        await directus.updateItem<SyncTaskRow>("sync_tasks", task.id, planCancel(error.message, now()));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await directus.updateItem<SyncTaskRow>("sync_tasks", task.id, planFailure(claimed, message, now()));
      }
    }
    taskIds.push(task.id);
  }
}
