/** fontsource + Capsize metrics → src/fonts.css. `--check` fails when the committed file is stale. */

import { buildFontsCss } from "./fonts.ts";

const target = new URL("../src/fonts.css", import.meta.url);
const css = await buildFontsCss();

if (process.argv.includes("--check")) {
  if ((await Bun.file(target).text().catch(() => "")) !== css) {
    console.error("src/fonts.css is out of date. Run `bun run fonts` in packages/design.");
    process.exit(1);
  }
  console.log("src/fonts.css is up to date.");
} else {
  await Bun.write(target, css);
  console.log(`wrote src/fonts.css (${css.length} bytes)`);
}
