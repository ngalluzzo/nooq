/**
 * tokens.json → src/tokens.css. `--check` fails instead of writing when the
 * committed CSS is out of date.
 */

import { tokensToCss, type Tokens } from "../src/tokens.ts";

const root = new URL("..", import.meta.url);
const tokens = (await Bun.file(new URL("tokens.json", root)).json()) as Tokens;
const target = new URL("src/tokens.css", root);
const css = tokensToCss(tokens);

if (process.argv.includes("--check")) {
  const current = await Bun.file(target).text().catch(() => "");
  if (current !== css) {
    console.error("src/tokens.css is out of date. Run `bun run tokens` in packages/design.");
    process.exit(1);
  }
  console.log("src/tokens.css is up to date.");
} else {
  await Bun.write(target, css);
  console.log(`wrote src/tokens.css (${css.length} bytes)`);
}
