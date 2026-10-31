/**
 * Logo geometry + tokens.json → assets/*.svg. `--check` fails instead of
 * writing when a committed file is out of date.
 */

import { logoAssets } from "../src/brand/assets.ts";
import type { Tokens } from "../src/tokens.ts";

const root = new URL("..", import.meta.url);
const tokens = (await Bun.file(new URL("tokens.json", root)).json()) as Tokens;
const check = process.argv.includes("--check");
let stale = 0;

for (const [name, svg] of Object.entries(logoAssets(tokens))) {
  const target = new URL(`assets/${name}`, root);
  if (check) {
    const current = await Bun.file(target).text().catch(() => "");
    if (current !== svg) {
      console.error(`assets/${name} is out of date.`);
      stale++;
    }
  } else {
    await Bun.write(target, svg);
    console.log(`wrote assets/${name}`);
  }
}

if (stale) {
  console.error("Run `bun run logo` in packages/design.");
  process.exit(1);
}
if (check) console.log("assets are up to date.");
