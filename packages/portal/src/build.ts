import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sections } from "./links.js";
import { renderPage } from "./render.js";

// Emit the static site into <package>/dist/site so the Docker image can COPY it into Caddy's web
// root. Keeping it under dist/ means `tsc --build --clean` and the usual clean tooling remove it.
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "site");

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "index.html"), renderPage(sections), "utf8");
  console.log(`Wrote ${join(outDir, "index.html")}`);
}

await main();
