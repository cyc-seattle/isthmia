/** Row shape for the `contact_points` collection. See `schema.yaml`. */
export type ContactPointKind = "email" | "phone";
export type ContactPointSource = "form" | "staff";

export interface ContactPointRow {
  id?: string;
  person_id: string;
  kind: ContactPointKind;
  value: string;
  normalized: string;
  source: ContactPointSource;
  last_seen_at: string | null;
}
