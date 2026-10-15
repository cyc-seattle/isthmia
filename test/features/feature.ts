import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadFeatureFromText } from "@amiceli/vitest-cucumber";

// Synchronous, because a CommonJS file can't await at the top level.
export function feature(name: string) {
  return loadFeatureFromText(readFileSync(join(__dirname, "../../features", name), "utf8"));
}
