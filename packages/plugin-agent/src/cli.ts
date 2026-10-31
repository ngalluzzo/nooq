import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseBrief } from "./brief.ts";
import { validate, validatePackage, type Stage } from "./check.ts";
import { run } from "./runner.ts";
import { readSources } from "./sources.ts";
import { join, resolve } from "node:path";

const help = `nooq plugin agent (complete block packages + Storybook)
  bun run plugin-agent run <brief.json> [--model ID] [--out NEW_DIRECTORY]
  bun run plugin-agent check <brief.json> <run-directory> [--stage types|runtime|all]
  bun run plugin-agent check <legacy-brief.json> <src/index.ts>
  bun run plugin-agent preview <run-directory> [--port 0]
Options: --base-url http://127.0.0.1:8000/v1 --omlx-settings PATH --rounds 3
Credentials: OMLX_API_KEY or ~/.omlx/settings.json (kept in memory).
Validation requires macOS sandbox-exec. No installation or publication occurs.`;

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
    stage: { type: "string" }, port: { type: "string" }, model: { type: "string" }, out: { type: "string" }, "base-url": { type: "string" }, "omlx-settings": { type: "string" }, rounds: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help || !positionals.length) console.log(help);
  else if (positionals[0] === "run" && positionals.length === 2) {
    const result = await run({ briefPath: positionals[1]!, model: values.model, out: values.out, baseUrl: values["base-url"], omlxSettings: values["omlx-settings"], rounds: values.rounds ? Number(values.rounds) : undefined });
    if (result.status !== "passed") process.exitCode = 1;
  } else if (positionals[0] === "check" && positionals.length === 3) {
    const brief = parseBrief(JSON.parse(await readFile(positionals[1]!, "utf8")));
    if(values.stage && !["types","runtime","all"].includes(values.stage))throw new Error("Invalid stage");
    const result = brief.view ? await validatePackage(await readSources(resolve(positionals[2]!)),brief,{stage:values.stage as Stage|undefined}) : await validate(await readFile(positionals[2]!,"utf8"),brief);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if(positionals[0]==="preview" && positionals.length===2) {
    const dir=resolve(positionals[1]!), port=Number(values.port??0);
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error("Invalid port");
    const html=await readFile(join(dir,"preview.html"),"utf8");
    const server=Bun.serve({hostname:"127.0.0.1",port,fetch(req){return new URL(req.url).pathname==="/"?new Response(html,{headers:{"content-type":"text/html","cache-control":"no-store"}}):new Response("Not found",{status:404});}});
    console.log(`Preview: ${server.url.href}`);
    const stop=()=>{server.stop(true);process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
  } else throw new Error(help);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
