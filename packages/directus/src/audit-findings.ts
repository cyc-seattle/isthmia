/** Row shape for the `audit_findings` collection: a discrepancy a sync noticed but didn't fix.
 * See `schema.yaml`. */
export type AuditFindingStatus = "open" | "dismissed";

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
