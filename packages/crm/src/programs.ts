/** Row shape for the `programs` collection. See `schema.yaml`. */
export interface ProgramRow {
  id?: string;
  name: string;
  /** The finance account this program's revenue rolls up to. Hand-set by staff; no sync writes it. */
  revenue_account: string | null;
}
