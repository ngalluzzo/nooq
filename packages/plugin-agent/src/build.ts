import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidatePaths, type Sources } from "./sources.ts";
export async function buildCandidate(sources: Sources, code: string, target: "browser" | "bun"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nooq-candidate-bundle-"));
  try {
    await mkdir(join(dir, "src"));
    for (const path of candidatePaths) await writeFile(join(dir, path), sources[path]);
    const entry = join(dir, "entry.ts"); await writeFile(entry, code);
    const aliases: Record<string, string> = {
      "candidate-index": join(dir, "src/index.ts"), "candidate-dom": join(dir, "src/dom.ts"), "candidate-stories": join(dir, "src/plugin.stories.ts"),
    };
    for (const name of ["@nooq/plugins", "@nooq/plugins/dom", "@nooq/core", "@nooq/yjs", "@nooq/editor", "@nooq/editor/testing", "@nooq/design", "@nooq/design/story-settings", "@nooq/plugins/essentials", "@storybook/html", "@storybook/html/entry-preview", "storybook/test", "storybook/preview-api", "axe-core"]) aliases[name] = import.meta.resolve(name).replace(/^file:\/\//, "");
    const build = await Bun.build({ entrypoints: [entry], target, packages: "bundle", define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "candidate-imports", setup(builder) { builder.onResolve({ filter: /^(candidate-|@nooq\/|@storybook\/html|storybook\/|axe-core$)/ }, args => aliases[args.path] ? { path: aliases[args.path] } : undefined); } }],
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    return await build.outputs[0]!.text();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
