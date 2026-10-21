import type { QueryGuardConfig } from "./community-rules";

interface Relation {
  collection: string;
  field: string;
  related_collection: string | null;
  meta?: { one_field?: string | null } | null;
}

/** Why `query` would reveal a field the Community role can't read on every row, or undefined. */
export function violation(
  config: QueryGuardConfig,
  relations: Relation[],
  collection: string,
  query: Record<string, unknown>,
): string | undefined;
