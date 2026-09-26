import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as yaml from "js-yaml";
import { HANDLED_PEOPLE_FOREIGN_KEYS } from "../src/merge.js";

interface RelationEntry {
  collection: string;
  field: string;
  related_collection: string | null;
  schema?: { on_delete?: string };
}

interface Snapshot {
  relations?: RelationEntry[];
}

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `packages/*\/schema.yaml`, found by directory rather than a hand-maintained list - matches `discoverSchemaFiles` in `packages/infrastructure/src/directus/client.ts`. */
function findSchemaFiles(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "schema.yaml"))
    .filter((path) => existsSync(path));
}

function readPeopleRelations(): RelationEntry[] {
  const relations: RelationEntry[] = [];
  for (const path of findSchemaFiles()) {
    const snapshot = yaml.load(readFileSync(path, "utf8")) as Snapshot;
    for (const relation of snapshot.relations ?? []) {
      if (relation.related_collection === "people") {
        relations.push(relation);
      }
    }
  }
  return relations;
}

describe("merge FK coverage", () => {
  const relations = readPeopleRelations();

  it("finds at least one relation to people across the schemas", () => {
    // A guard against readPeopleRelations silently finding nothing - every assertion below
    // would otherwise vacuously pass.
    expect(relations.length).toBeGreaterThan(0);
  });

  it("handles every relation to people in HANDLED_PEOPLE_FOREIGN_KEYS", () => {
    const handled = new Set(HANDLED_PEOPLE_FOREIGN_KEYS.map((fk) => `${fk.collection}.${fk.field}`));
    const missing = relations
      .map((relation) => `${relation.collection}.${relation.field}`)
      .filter((key) => !handled.has(key));
    expect(missing).toEqual([]);
  });

  it("has on_delete: RESTRICT on every relation to people except participants.person_id", () => {
    for (const relation of relations) {
      const key = `${relation.collection}.${relation.field}`;
      const expected = key === "participants.person_id" ? "SET NULL" : "RESTRICT";
      expect(relation.schema?.on_delete).toBe(expected);
    }
  });
});
