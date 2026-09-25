import { createHash } from "node:crypto";

/** Row shape for the `audit_findings` collection: a discrepancy a sync noticed but didn't fix.
 * See `schema.yaml`. */
export type AuditFindingStatus = "open" | "resolved" | "dismissed";

export interface AuditFindingRow {
  id?: string;
  /** Which sync raised it, e.g. `"gsuite-sync"`. */
  source: string;
  /** What kind of discrepancy, e.g. `"unexpected_member"`. Not a schema enum - each sync defines its own. */
  kind: string;
  /** What the finding is about - a group address, a person id, whatever the kind implies. */
  subject: string;
  detail: string;
  status: AuditFindingStatus;
  /**
   * `source` + `kind` + `subject` + a hash of `detail`, unique. A staff dismissal is keyed by this,
   * so it survives the next run instead of the finding reappearing.
   */
  fingerprint: string;
}

/** An `audit_findings` row before its `fingerprint` and `status` are attached. `kind` is a plain
 * string here - each sync defines its own set and narrows it in its own types. */
export interface AuditFindingInput {
  source: string;
  kind: string;
  subject: string;
  detail: string;
}

/**
 * `source` + `kind` + `subject` + a hash of `detail`, matching the schema's unique `fingerprint`
 * column. Hashing `detail` keeps the fingerprint's length independent of how long a finding's
 * message gets, while still changing whenever the substance of the finding does - which is what
 * lets `planAuditFindingWrites` tell "already raised" from "raised again with something new to say".
 */
export function fingerprintFinding(input: AuditFindingInput): string {
  const detailHash = createHash("sha256").update(input.detail).digest("hex");
  return `${input.source}:${input.kind}:${input.subject}:${detailHash}`;
}

export interface AuditFindingWrites {
  toCreate: readonly AuditFindingInput[];
  /** Open rows to mark `resolved` - their condition wasn't raised again this run. */
  toResolve: readonly AuditFindingRow[];
  /** Resolved rows to reopen - their fingerprint recurred, so the row is reused rather than
   * colliding with a fresh insert under the unique `fingerprint` column. */
  toReopen: readonly AuditFindingRow[];
}

/**
 * Reconciles this run's findings, deduped by fingerprint, against the `audit_findings` rows whose
 * `kind` is in `ownedKinds` - so a row some other sync raised is untouched. A row toggles between
 * `open` and `resolved` as its condition recurs or clears; `dismissed` rows never change, since a
 * human already reviewed them.
 */
export function planAuditFindingWrites(
  findings: readonly AuditFindingInput[],
  existingRows: readonly AuditFindingRow[],
  ownedKinds: readonly string[],
): AuditFindingWrites {
  const freshByFingerprint = new Map<string, AuditFindingInput>();
  for (const finding of findings) {
    freshByFingerprint.set(fingerprintFinding(finding), finding);
  }

  const ownedRows = existingRows.filter((row) => ownedKinds.includes(row.kind));
  const existingFingerprints = new Set(ownedRows.map((row) => row.fingerprint));

  const toCreate = [...freshByFingerprint.entries()]
    .filter(([fingerprint]) => !existingFingerprints.has(fingerprint))
    .map(([, finding]) => finding);

  const toResolve = ownedRows.filter((row) => row.status === "open" && !freshByFingerprint.has(row.fingerprint));
  const toReopen = ownedRows.filter((row) => row.status === "resolved" && freshByFingerprint.has(row.fingerprint));

  return { toCreate, toResolve, toReopen };
}
