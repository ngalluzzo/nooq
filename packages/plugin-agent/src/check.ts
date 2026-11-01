import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import type { Brief } from "./brief.ts";
import type { Conformance } from "./conformance.ts";
import { candidatePaths, hashes, packageHash, type CandidatePath, type Sources } from "./sources.ts";
import { buildCandidate } from "./build.ts";
import { runBrowserChecks, type BrowserChecks } from "./browser.ts";
export type Stage = "types" | "runtime" | "all";
export interface Gate { name: string; status: "passed" | "failed" | "not-run" }
export interface CompleteValidation extends Validation { complete: boolean; files: Record<string,string>; gates: Gate[]; runtime?: Conformance; browser?: BrowserChecks }

const repo = resolve(import.meta.dir, "../../..");
const apiPath = join(repo, "packages/plugins/src/index.ts");
export interface Validation {
  ok: boolean;
  sourceHash: string;
  errors: string[];
  conformance?: Conformance;
  sandbox: "macos-seatbelt" | "not-run";
}
export const sourceHash = (source: string) => new Bun.CryptoHasher("sha256").update(source).digest("hex");

export function checkSourcePolicy(source: string, path: CandidatePath = "src/index.ts"): string[] {
  const errors: string[] = [];
  if (source.length > 60_000) return ["Source exceeds 60 KB limit"];
  const file = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.Latest, true);
  if (file.referencedFiles.length || file.typeReferenceDirectives.length || file.libReferenceDirectives.length) errors.push("Reference directives are unsupported");
  const forbidden = new Set(["eval", "Function", "require", "process", "Bun", "globalThis", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "window", "localStorage", "sessionStorage", "indexedDB", "navigator", "location", "setTimeout", "setInterval"]);
  if (path === "src/index.ts") forbidden.add("document");
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec) {
        const typeOnly = ts.isImportDeclaration(node) && node.importClause?.isTypeOnly;
        const allowed = ts.isStringLiteral(spec) && (spec.text === "@nooq/plugins"
          || (spec.text === "@nooq/core" && typeOnly)
          || (path !== "src/index.ts" && ["@nooq/plugins/dom", "./index.ts"].includes(spec.text))
          || (path === "src/plugin.stories.ts" && (["./dom.ts", "storybook/test", "@nooq/editor/testing"].includes(spec.text) || (spec.text === "@storybook/html-vite" && typeOnly))));
        if (!allowed) errors.push(`Import is outside the ${path} capability allowlist`);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("Dynamic imports are unsupported");
    if (ts.isImportTypeNode(node)) errors.push("Import type expressions are unsupported; use an explicit type-only import");
    if (ts.isPropertyAccessExpression(node) && ["innerHTML", "outerHTML", "defaultView", "ownerDocument"].includes(node.name.text)) errors.push(`Unsupported DOM escape: ${node.name.text}`);
    if (ts.isIdentifier(node) && forbidden.has(node.text)) errors.push(`Unsupported global: ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(errors)];
}

/** Run code with no repository/home access, no network, and no inherited credentials. */
export async function sandboxRun(bundle: string, timeoutMs = 15_000): Promise<string> {
  if (process.platform !== "darwin" || !Bun.which("sandbox-exec")) throw new Error("Validation requires macOS sandbox-exec; no unsandboxed fallback is enabled");
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "nooq-plugin-check-")));
  const bun = await realpath(process.execPath);
  const literal = (p: string) => JSON.stringify(p);
  const profile = `(version 1)
(deny default)
(allow signal (target self))
(allow process-info* (target self))
(allow process-exec (literal ${literal(bun)}))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read* (literal "/"))
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple") (literal ${literal(bun)}) (subpath ${literal(scratch)}) (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))
(allow file-write* (subpath ${literal(scratch)}) (literal "/dev/null"))`;
  try {
    const entry = join(scratch, "check.js");
    await writeFile(entry, bundle);
    const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, bun, "--no-env-file", entry], {
      cwd: scratch, env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch }, stdout: "pipe", stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) { proc.kill(); throw new Error("Validation output limit exceeded"); }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString();
    };
    try {
      const [stdout, stderr, code] = await Promise.all([consume(proc.stdout), consume(proc.stderr), proc.exited]);
      if (timedOut) throw new Error("Validation timed out");
      if (code !== 0) throw new Error(`Sandbox validation exited ${code}: ${stderr.slice(0, 3500)}`);
      return stdout;
    } finally { clearTimeout(timer); proc.kill(); await proc.exited; }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function validate(source: string, brief: Brief): Promise<Validation> {
  const result: Validation = { ok: false, sourceHash: sourceHash(source), errors: checkSourcePolicy(source), sandbox: "not-run" };
  if (result.errors.length) return result;
  const scratch = await mkdtemp(join(tmpdir(), "nooq-plugin-build-"));
  try {
    const candidate = join(scratch, "candidate.ts");
    await writeFile(candidate, source);
    const program = ts.createProgram([candidate], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], baseUrl: repo,
      paths: { "@nooq/plugins": [apiPath], "@nooq/core": [join(repo, "packages/core/src/index.ts")] },
    });
    result.errors.push(...ts.getPreEmitDiagnostics(program).map(d => {
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
      return `${d.file?.fileName === candidate ? "src/index.ts" : d.file?.fileName ?? "TypeScript"}${pos ? `:${pos.line + 1}` : ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    }));
    if (result.errors.length) return result;
    const entry = join(scratch, "entry.ts");
    await writeFile(entry, `import candidate from "nooq-candidate";\nimport { runConformance } from ${JSON.stringify(join(import.meta.dir, "conformance.ts"))};\nconsole.log("NOOQ_RESULT=" + JSON.stringify(runConformance(candidate, ${JSON.stringify(brief)})));`);
    const build = await Bun.build({
      entrypoints: [entry], target: "bun", packages: "bundle",
      plugins: [{ name: "pinned-candidate", setup(builder) {
        builder.onResolve({ filter: /^@nooq\/plugins$/ }, () => ({ path: apiPath }));
        builder.onResolve({ filter: /^nooq-candidate$/ }, () => ({ path: "candidate", namespace: "nooq" }));
        builder.onLoad({ filter: /.*/, namespace: "nooq" }, () => ({ contents: source, loader: "ts", resolveDir: dirname(apiPath) }));
      } }],
    });
    if (!build.success) throw new Error(build.logs.map(String).join("\n"));
    const output = await sandboxRun(await build.outputs[0]!.text());
    result.sandbox = "macos-seatbelt";
    const lines = output.split("\n").filter(l => l.startsWith("NOOQ_RESULT="));
    if (lines.length !== 1) throw new Error("Missing or ambiguous conformance result");
    const conformance = JSON.parse(lines[0]!.slice("NOOQ_RESULT=".length)) as Conformance;
    if (!Array.isArray(conformance.checks) || !conformance.checks.length) throw new Error("Invalid conformance result");
    result.conformance = conformance;
    result.ok = conformance.checks.every(c => c.ok === true);
    return result;
  } catch (e) {
    result.errors.push(e instanceof AggregateError ? e.errors.map(String).join("\n") : String(e));
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function apiContext(): Promise<string> {
  return `Experimental API subset, pinned by this run. Only headless text blocks and synchronous target-field commands are supported. No editor dispatch, DOM contributions, export hooks, jobs, dependencies, or authorization implementation. Use the supplied context; do not invent methods.

Example command body (for an unrelated title field):
const target = ctx.snapshot.blocks[args.block];
if (!ctx.isAlive(args.block) || target?.type !== "example.note/v1") return { status: "not-applicable" };
return { status: "ready", intent: "rename-note", ops: [{ op: "setField", block: args.block, key: "title", value: "New title" }] };

AUTHORING API:
${await readFile(join(repo, "packages/plugins/src/definitions.ts"), "utf8")}

CORE DATA AND OPERATION TYPES:
${await readFile(join(repo, "packages/core/src/model.ts"), "utf8")}`;
}

/** Full candidate checks. Partial stages never qualify a package as complete. */
export async function validatePackage(sources: Sources, brief: Brief, options: { stage?: Stage; artifactDir?: string } = {}): Promise<CompleteValidation> {
  const result: CompleteValidation = { ok: false, complete: false, sourceHash: packageHash(sources), files: hashes(sources), errors: [], sandbox: "not-run",
    gates: ["types", "headless", "runtime", "browser", "storybook"].map(name => ({ name, status: "not-run" })),
  };
  const gate = (name: string, ok: boolean) => { result.gates.find(g => g.name === name)!.status = ok ? "passed" : "failed"; };
  if (!brief.view || !brief.insertCommand) { result.errors.push("Complete-plugin checks require view and insertCommand in the brief"); return result; }
  for (const path of candidatePaths) result.errors.push(...checkSourcePolicy(sources[path], path).map(e => `${path}: ${e}`));
  if (result.errors.length) { gate("types", false); return result; }
  const scratch = await mkdtemp(join(tmpdir(), "nooq-package-check-"));
  try {
    await mkdir(join(scratch, "src"));
    for (const path of candidatePaths) await writeFile(join(scratch, path), sources[path]);
    const paths: Record<string, string[]> = {};
    for (const name of ["@nooq/plugins", "@nooq/plugins/dom", "@nooq/core", "@nooq/editor/testing", "@storybook/html-vite", "storybook/test"]) {
      paths[name] = [import.meta.resolve(name).replace(/^file:\/\//, "").replace(/\.js$/, ".d.ts")];
      // Workspace exports are TypeScript sources already.
    }
    const program = ts.createProgram(candidatePaths.map(p => join(scratch, p)), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], baseUrl: repo, paths });
    result.errors.push(...ts.getPreEmitDiagnostics(program).map(d => { const pos=d.file && d.start!==undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined; return `${d.file?.fileName.replace(scratch + "/", "") ?? "TypeScript"}${pos ? ":"+(pos.line+1) : ""}: ${ts.flattenDiagnosticMessageText(d.messageText,"\n")}`; }));
    gate("types", !result.errors.length); if(result.errors.length) return result;
    if(options.stage === "types") { result.ok = true; return result; }
    const bundle = await buildCandidate(sources, `import plugin from "candidate-index"; import {runConformance} from ${JSON.stringify(join(import.meta.dir,"conformance.ts"))}; import {runRuntimeChecks} from ${JSON.stringify(join(import.meta.dir,"runtime-checks.ts"))}; const brief=${JSON.stringify(brief)}; const result={headless:runConformance(plugin,brief),runtime:await runRuntimeChecks(plugin,brief)}; console.log("NOOQ_RESULT="+JSON.stringify(result));`, "bun");
    const output = await sandboxRun(bundle, 20_000); result.sandbox = "macos-seatbelt";
    const lines = output.split("\n").filter(l => l.startsWith("NOOQ_RESULT="));
    if(lines.length !== 1) throw new Error("Missing or ambiguous sandbox result");
    const data = JSON.parse(lines[0]!.slice("NOOQ_RESULT=".length));
    if(!Array.isArray(data.headless?.checks) || !data.headless.checks.length || !Array.isArray(data.runtime?.checks) || !data.runtime.checks.length) throw new Error("Invalid sandbox result");
    result.conformance=data.headless; result.runtime=data.runtime;
    gate("headless",data.headless.checks.every((c: any)=>c.ok===true)); gate("runtime",data.runtime.checks.every((c: any)=>c.ok===true));
    if(result.gates.some(g=>g.status==="failed")) return result;
    if(options.stage === "runtime") { result.ok=true; return result; }
    result.browser = await runBrowserChecks(sources, brief, options.artifactDir);
    for(const [name,prefix] of [["browser","browser:"],["storybook","storybook:"]] as const) {
      const checks=result.browser.checks.filter(c=>c.name.startsWith(prefix)); gate(name,!!checks.length && checks.every(c=>c.ok));
    }
    result.ok = result.complete = result.gates.every(g=>g.status === "passed");
    return result;
  } catch(error) { result.errors.push(String(error)); return result; }
  finally { await rm(scratch,{recursive:true,force:true}); }
}
