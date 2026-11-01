import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Brief } from "./brief.ts";
import type { Validation } from "./check.ts";

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** Static fallback preview: candidate JavaScript never runs in the browser. */
export function previewHtml(brief: Brief, validation: Validation): string {
  const block = validation.conformance?.preview;
  const complete = validation as import("./check.ts").CompleteValidation;
  const checks = [...validation.conformance?.checks ?? [], ...complete.runtime?.checks ?? [], ...complete.browser?.checks ?? []];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(brief.label)} — plugin review</title>
<style>body{font:17px/1.6 system-ui;max-width:760px;margin:4rem auto;padding:0 1.5rem;color:#24312e;background:#faf9f4}article{border:1px solid #b8c9c1;border-left:5px solid #33765f;padding:1.5rem;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eeeee7;padding:1rem}small{color:#53675f}li{margin:.4rem 0}</style>
<main><small>NOOQ · GENERATED PLUGIN REVIEW</small><h1>${escape(brief.label)}</h1><p>${validation.ok ? "Passed the requested checks. Consult the gates below for completeness." : "Candidate has unresolved checks."}</p>
<article aria-label="Generic block preview"><strong>${escape(block?.type ?? brief.blockType)}</strong><p>${escape(block?.text?.s || "Empty text block")}</p><pre aria-label="Stored fields">${escape(JSON.stringify(block?.fields ?? brief.defaults.fields, null, 2))}</pre></article>
<h2>Validation</h2><ul>${checks.map(c => `<li>${c.ok ? "Pass" : "Fail"}: ${escape(c.name)}${c.error ? `<pre>${escape(c.error)}</pre>` : ""}</li>`).join("")}</ul>${validation.errors.map(e => `<pre>${escape(e)}</pre>`).join("")}
<p>This is a static generic fallback preview, not a plugin DOM renderer. ${escape(JSON.stringify(complete.gates ?? [{name:"headless",status:validation.ok?"passed":"failed"}]))}. Export adapters, native IME and performance budgets are separate gates.</p><small>Source SHA-256: ${escape(validation.sourceHash)}</small></main></html>`;
}

export async function writeArtifacts(dir: string, brief: Brief, validation: Validation, report: object): Promise<void> {
  await writeFile(join(dir, "report.json"), JSON.stringify({ ...report, validation }, null, 2) + "\n");
  await writeFile(join(dir, "report.html"), previewHtml(brief, validation));
  try { await access(join(dir,"preview.html")); } catch { await writeFile(join(dir,"preview.html"),previewHtml(brief,validation)); }
  await writeFile(join(dir, "package.json"), JSON.stringify({
    name: `@nooq-generated/${brief.id}`, version: "0.1.0", private: true, type: "module",
    exports: { ".": "./src/index.ts", ...(brief.view ? { "./dom": "./src/dom.ts" } : {}) }, dependencies: { "@nooq/plugins": "workspace:*" },
    ...(brief.view ? { devDependencies: { "@nooq/editor": "workspace:*", "@storybook/html-vite": "catalog:", "storybook": "catalog:" } } : {}),
  }, null, 2) + "\n");
  await writeFile(join(dir, "README.md"), `# ${brief.label}\n\n${brief.description}\n\nGenerated candidate for the nooq plugin API. Review src/index.ts and report.json before copying into the nooq workspace. This package uses workspace dependencies and is not a standalone published package.\n\nOpen preview.html for the isolated working preview when browser checks ran; report.html is the static validation summary. src/plugin.stories.ts contains standard CSF3 stories with interaction tests and can be included in the host Storybook stories glob. There is no automatic installation, merge, or publication. The report names the supported checks and remaining integration gaps.\n`);
}
