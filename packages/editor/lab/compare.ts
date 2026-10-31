/**
 * The regression gate (EB-6, EB-2.1): compare a change's lab results with
 * the base commit's, measured on the same runner in the same job.
 *
 *   bun lab/compare.ts <base-results-dir> <head-results-dir>
 *
 * Fails when keystroke-to-paint p95 regresses by more than 10% for any
 * document and condition, or when any invariant gains violations. A result
 * the base doesn't have yet (a new budget) is reported, never failed.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const [baseDir, headDir] = process.argv.slice(2);
if (!baseDir || !headDir) {
  console.error("usage: bun lab/compare.ts <base-results-dir> <head-results-dir>");
  process.exit(2);
}

const TOLERANCE = 0.1;
type Result = Record<string, any>;

async function load(dir: string): Promise<Map<string, Result>> {
  const out = new Map<string, Result>();
  for (const file of await readdir(dir).catch(() => [] as string[])) {
    if (file.endsWith(".json")) out.set(file.replace(/\.json$/, ""), await Bun.file(join(dir, file)).json());
  }
  return out;
}

const [base, head] = await Promise.all([load(baseDir), load(headDir)]);
const rows: string[] = [];
let failed = false;

for (const [name, now] of head) {
  const before = base.get(name);
  if (!before) {
    rows.push(`new       ${name}`);
    continue;
  }
  if (now.budget === "EB-6") {
    const [b, h] = [before.keystrokeToPaintMs.p95, now.keystrokeToPaintMs.p95];
    const worse = h > b * (1 + TOLERANCE);
    failed ||= worse;
    rows.push(`${worse ? "REGRESSED" : "ok       "} ${name}: p95 ${b}ms → ${h}ms`);
  } else if (now.budget === "EB-7") {
    const worse = now.violations > before.violations;
    failed ||= worse;
    rows.push(`${worse ? "REGRESSED" : "ok       "} ${name}: violations ${before.violations} → ${now.violations}`);
  } else if (now.budget === "EB-5") {
    const worse = now.neverEditable > before.neverEditable;
    failed ||= worse;
    rows.push(`${worse ? "REGRESSED" : "ok       "} ${name}: never editable ${before.neverEditable} → ${now.neverEditable} of ${now.samples}`);
  }
}

console.log(rows.join("\n"));
if (failed) {
  console.error(`\nA lab result regressed against the base commit (EB-6 allows ${TOLERANCE * 100}% on p95; invariants allow none).`);
  process.exit(1);
}
