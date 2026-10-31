import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBrief, scaffold } from "../src/brief.ts";
import { checkSourcePolicy, sandboxRun, validate } from "../src/check.ts";
import { previewHtml } from "../src/artifacts.ts";
import { runConformance } from "../src/conformance.ts";
import callouts from "../examples/callout.ts";

const brief = parseBrief(JSON.parse(await readFile(new URL("../briefs/callout.json", import.meta.url), "utf8")));
const macTest = process.platform === "darwin" ? test : test.skip;

test("brief rejects an absent behavioral oracle", () => {
  expect(() => parseBrief({ ...brief, commands: [] })).toThrow();
  expect(() => parseBrief({ ...brief, commands: [{ ...brief.commands[0], cases: [] }] })).toThrow();
});
test("source policy rejects extra imports and hidden type-resolution paths", () => {
  for (const source of ['import x from "node:fs";', 'await import("secret");', 'type X = import("/private/secret");', '/// <reference path="/private/secret" />\nexport {};', 'process.env.KEY']) {
    expect(checkSourcePolicy(source).length).toBeGreaterThan(0);
  }
  expect(checkSourcePolicy(scaffold(brief))).toEqual([]);
});
test("preview escapes candidate output and contains no executable script", () => {
  const html = previewHtml({ ...brief, label: "<script>alert(1)</script>" }, { ok: false, errors: ["<img src=x>"], sourceHash: "test", sandbox: "not-run" });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});
test("reviewed Qwen example passes the protected scenarios on every platform", () => {
  const result = runConformance(callouts, brief);
  expect(result.checks).toHaveLength(20);
  expect(result.checks.filter(c => !c.ok)).toEqual([]);
});
test("a field-behavior regression is caught independently of model assertions", () => {
  const command = callouts.contributes.commands[0]!;
  const broken = { ...callouts, contributes: { ...callouts.contributes, commands: [{ ...command, prepare: () => ({ status: "not-applicable" as const }) }] } };
  const result = runConformance(broken, brief);
  expect(result.checks.some(c => !c.ok && c.name.includes("scenario"))).toBe(true);
});
macTest("reviewed generated source passes the full sandbox gate", async () => {
  const result = await validate(await readFile(new URL("../examples/callout.ts", import.meta.url), "utf8"), brief);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.sandbox).toBe("macos-seatbelt");
});
macTest("sandbox denies external file reads/writes, subprocesses, network, and credential inheritance", async () => {
  const outside = await mkdtemp(join(tmpdir(), "nooq-sandbox-canary-"));
  const file = join(outside, "canary.txt");
  await writeFile(file, "canary");
  process.env.NOOQ_SANDBOX_CANARY = "must-not-leak";
  try {
    const result = JSON.parse(await sandboxRun(`
      import fs from "node:fs";
      const results = {};
      try { fs.readFileSync(${JSON.stringify(file)}); results.read = true; } catch { results.read = false; }
      try { fs.writeFileSync(${JSON.stringify(file)}, "changed"); results.write = true; } catch { results.write = false; }
      try { Bun.spawnSync([process.execPath, "-e", "console.log(1)"]); results.spawn = true; } catch { results.spawn = false; }
      try { await fetch("http://127.0.0.1:8000/v1/models", {signal:AbortSignal.timeout(500)}); results.network = true; } catch { results.network = false; }
      results.secret = process.env.NOOQ_SANDBOX_CANARY ?? null;
      console.log(JSON.stringify(results));
    `));
    expect(result).toEqual({ read: false, write: false, spawn: false, network: false, secret: null });
    expect(await readFile(file, "utf8")).toBe("canary");
  } finally { delete process.env.NOOQ_SANDBOX_CANARY; await rm(outside, { recursive: true, force: true }); }
});
macTest("sandbox terminates a hung candidate", async () => {
  await expect(sandboxRun("for (;;) {}", 150)).rejects.toThrow("timed out");
});
macTest("the deterministic scaffold fails the protected behavior checks", async () => {
  const result = await validate(scaffold(brief), brief);
  expect(result.errors).toEqual([]);
  expect(result.sandbox).toBe("macos-seatbelt");
  expect(result.ok).toBe(false);
  expect(result.conformance!.checks.some(c => !c.ok && c.name.includes("diagnostics"))).toBe(true);
  expect(result.conformance!.checks.some(c => !c.ok && c.name.includes("scenario"))).toBe(true);
});
