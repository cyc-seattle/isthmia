import { SyncProgramRun, SyncRun } from "@cyc-seattle/crm";
import { DirectusClient } from "./directus.js";

/** No prior successful sync: the registration window starts from the beginning of Clubspot history. */
export const EPOCH = new Date(0);

/**
 * The watermark for a camp is the latest `started_at` among its own `ok` sync_program_runs rows,
 * or the epoch if it has none. Per camp, not per run: a run-level watermark would advance past a
 * camp that failed while a sibling camp in the same run succeeded.
 */
export function watermarkForCamp(campId: string, priorRuns: readonly SyncProgramRun[]): Date {
  const startedTimes = priorRuns
    .filter((run) => run.clubspot_camp_id === campId && run.status === "ok")
    .map((run) => new Date(run.started_at).getTime());
  return startedTimes.length === 0 ? EPOCH : new Date(Math.max(...startedTimes));
}

export interface FinishRunResult {
  status: "ok" | "failed";
  programsChecked: number;
  programsSynced: number;
  error?: string;
}

/** Thin executor over the two log collections. Holds no decision logic of its own. */
export class SyncLog {
  constructor(private readonly directus: DirectusClient) {}

  async startRun(startedAt: Date): Promise<SyncRun> {
    const [run] = await this.directus.createItems<SyncRun>("sync_runs", [
      {
        started_at: startedAt.toISOString(),
        status: "running",
        programs_checked: 0,
        programs_synced: 0,
      },
    ]);
    if (!run) {
      throw new Error("Directus did not return the created sync_runs row");
    }
    return run;
  }

  async finishRun(runId: string, finishedAt: Date, result: FinishRunResult): Promise<void> {
    await this.directus.updateItem<SyncRun>("sync_runs", runId, {
      finished_at: finishedAt.toISOString(),
      status: result.status,
      programs_checked: result.programsChecked,
      programs_synced: result.programsSynced,
      error: result.error ?? null,
    });
  }

  async recordProgramRun(row: Omit<SyncProgramRun, "id">): Promise<SyncProgramRun> {
    const [created] = await this.directus.createItems<SyncProgramRun>("sync_program_runs", [row]);
    if (!created) {
      throw new Error("Directus did not return the created sync_program_runs row");
    }
    return created;
  }

  /** Every prior `sync_program_runs` row, the input to `watermarkForCamp` for each discovered camp. */
  async priorProgramRuns(): Promise<SyncProgramRun[]> {
    return this.directus.readItems<SyncProgramRun>("sync_program_runs", { limit: -1 });
  }
}
