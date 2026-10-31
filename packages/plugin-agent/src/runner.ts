import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseBrief } from "./brief.ts";
import { validatePackage, type CompleteValidation, type Stage } from "./check.ts";
import { candidatePaths, contextSections, contractFingerprint, hash, packageHash, scaffoldPackage, type CandidatePath } from "./sources.ts";
import { localModel } from "./model.ts";

import { writeArtifacts } from "./artifacts.ts";

export interface RunOptions {
  briefPath: string;
  out?: string;
  baseUrl?: string;
  model?: string;
  omlxSettings?: string;
  rounds?: number;
  roundTimeoutMs?: number;
}

export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("This runner accepts a local HTTP model endpoint only");
  }
  return url.href.replace(/\/$/, "");
}

export async function run(options: RunOptions): Promise<{ dir: string; status: string }> {
  const brief = parseBrief(JSON.parse(await readFile(options.briefPath, "utf8")));
  if(!brief.view) throw new Error("Generation now requires a complete-plugin brief; use briefs/callout-complete.json. Legacy sources remain checkable.");
  const baseUrl = localEndpoint(options.baseUrl ?? "http://127.0.0.1:8000/v1");
  const rounds = options.rounds ?? 3, roundTimeoutMs = options.roundTimeoutMs ?? 240_000;
  if(!Number.isInteger(rounds) || rounds<1 || rounds>5 || roundTimeoutMs<1000 || roundTimeoutMs>300_000) throw new Error("Invalid run bounds");
  let key=process.env.OMLX_API_KEY;
  if(!key) try { key=JSON.parse(await readFile(options.omlxSettings ?? join(homedir(),".omlx/settings.json"),"utf8")).auth?.api_key; } catch { if(options.omlxSettings) throw new Error("Cannot read specified oMLX settings"); }
  if(key!==undefined && typeof key!=="string") throw new Error("Invalid oMLX API key configuration");
  const response=await fetch(`${baseUrl}/models`,{headers:key?{Authorization:`Bearer ${key}`}:{},signal:AbortSignal.timeout(10_000),redirect:"error"});
  if(!response.ok) throw new Error(`Local model discovery failed: HTTP ${response.status}`);
  const catalog=await response.json() as {data:{id:string}[]};
  if(!options.model && catalog.data.length!==1) throw new Error(`Select --model explicitly: ${catalog.data.map(m=>m.id).join(", ")}`);
  const modelId=options.model ?? catalog.data[0]?.id;
  if(!modelId || !catalog.data.some(m=>m.id===modelId)) throw new Error("Requested model is absent from local catalog");
  const dir=options.out?resolve(options.out):await mkdtemp(join(tmpdir(),"nooq-plugin-run-"));
  if(options.out) await mkdir(dir,{mode:0o700});
  await mkdir(join(dir,"src")); await mkdir(join(dir,"revisions"));
  const agentDir=join(dir,".agent"); await mkdir(agentDir,{mode:0o700});
  const api=await contextSections(), fingerprint=await contractFingerprint(), sources=scaffoldPackage(brief);
  await writeFile(join(dir,"api-context.json"),JSON.stringify(api,null,2)+"\n");
  await writeFile(join(dir,"brief.json"),JSON.stringify(brief,null,2)+"\n");
  for(const path of candidatePaths) await writeFile(join(dir,path),sources[path]);
  await writeFile(join(dir,"revisions/000-scaffold.json"),JSON.stringify(sources,null,2)+"\n");
  const started=Date.now(), events:object[]=[], gaps:{capability:string;reason:string}[]=[];
  let revisions=0,toolCalls=0,checks=0,completedRounds=0,failure:string|undefined,latest:CompleteValidation|undefined;
  let fileWrites = Promise.resolve();
  const budget=()=>{if(++toolCalls>32)throw new Error("Tool budget exhausted");};
  const reply=(value:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(value)}],details:{}});
  const customTools=[
    defineTool({name:"read_api",label:"Read API section",description:"Read one pinned contract section: overview, headless, recipes, dom, or stories. Stories include Storybook authoring guidance.",parameters:Type.Object({section:Type.Union([Type.Literal("overview"),Type.Literal("headless"),Type.Literal("recipes"),Type.Literal("dom"),Type.Literal("stories")])}),execute:async(_,args)=>{budget();return reply({section:args.section,content:api[args.section]});}}),
    defineTool({name:"read_file",label:"Read candidate",description:"Read one editable candidate file.",parameters:Type.Object({path:Type.Union(candidatePaths.map(p=>Type.Literal(p)))}),execute:async(_,args)=>{budget();return reply({path:args.path,source:sources[args.path as CandidatePath]});}}),
    defineTool({name:"write_file",label:"Write candidate file",description:"Replace one allowlisted file with complete TypeScript. Harness, tests, brief and manifest are not editable.",parameters:Type.Object({path:Type.Union(candidatePaths.map(p=>Type.Literal(p))),source:Type.String({maxLength:60_000})}),execute:async(_,args)=>{
      budget(); if(++revisions>12 || args.source.length>60_000 || !candidatePaths.includes(args.path as CandidatePath))throw new Error("Invalid file or source budget exhausted");
      const revision=revisions, path=args.path as CandidatePath; sources[path]=args.source;latest=undefined;
      fileWrites = fileWrites.then(async () => {
        await writeFile(join(dir,path),args.source);
        await writeFile(join(dir,`revisions/${String(revision).padStart(3,"0")}.json`),JSON.stringify({path,source:args.source},null,2)+"\n");
      });
      await fileWrites;
      events.push({event:"write",revision,path,sourceHash:hash(args.source),elapsedMs:Date.now()-started});return reply({written:path,packageHash:packageHash(sources)});
    }}),
    defineTool({name:"check_plugin",label:"Check candidate",description:"Run protected checks. types is quick; runtime includes headless and secured Editor checks; all additionally runs real Chromium, Storybook play functions and axe in both themes. Only all can complete a run.",parameters:Type.Object({stage:Type.Optional(Type.Union([Type.Literal("types"),Type.Literal("runtime"),Type.Literal("all")]))}),execute:async(_,args)=>{
      budget();if(++checks>6)throw new Error("Validation budget exhausted");
      latest=await validatePackage(structuredClone(sources),brief,{stage:args.stage as Stage|undefined});
      events.push({event:"check",validation:latest,elapsedMs:Date.now()-started}); console.log(`  check ${checks}: ${latest.complete?"complete":latest.ok?"partial pass":"failed"}`);return reply(latest);
    }}),
    defineTool({name:"report_api_gap",label:"Report API gap",description:"Stop with an unavailable capability and explanation. Do not invent APIs.",parameters:Type.Object({capability:Type.String(),reason:Type.String()}),execute:async(_,args)=>{budget();gaps.push(args);return reply({recorded:true});}}),
  ];
  const system="You implement a complete nooq block plugin and its Storybook interaction tests. Use only provided tools. The brief and independent oracle are immutable. Read the overview, headless, dom, and stories contracts as needed, then fill the scaffold's three files. Use general behavior, never fixture IDs. No filesystem, network, dynamic loading, global state, or import-time side effects. DOM creation belongs inside mount/render. Default exports: Plugin in index.ts, DOMPlugin in dom.ts, CSF metadata in plugin.stories.ts. Each required story needs meaningful awaited play assertions. Never weaken or bypass checks. Run all checks, repair concrete failures, finish when complete=true. Report missing capabilities with report_api_gap. The host owns credentials, tests and package metadata.";
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPromptOverride:()=>system,appendSystemPromptOverride:()=>[]});await loader.reload();
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(agentDir,"models-store.json"),allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider("nooq-local",{baseUrl,api:"openai-completions",authHeader:true,models:[localModel(modelId,baseUrl)]});
  await runtime.setRuntimeApiKey("nooq-local",key||"local-no-auth");
  const {session}=await createAgentSession({cwd:dir,agentDir,modelRuntime:runtime,model:runtime.getModel("nooq-local",modelId)!,thinkingLevel:"off",resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.inMemory(),customTools,tools:customTools.map(t=>t.name)});
  session.subscribe(event=>{
    if(event.type==="tool_execution_start")console.log(`  tool: ${event.toolName}`);
    if(event.type==="message_end" && event.message.role==="assistant") {events.push({event:"model",stopReason:event.message.stopReason,usage:event.message.usage,elapsedMs:Date.now()-started});console.log(`  model: ${event.message.stopReason}, ${event.message.usage.output} output tokens, ${Math.round((Date.now()-started)/1000)}s elapsed`);if(event.message.stopReason==="error")failure=event.message.errorMessage??"Model error";}
    if(toolCalls>=32 || gaps.length)void session.abort();
  });
  const cancel=()=>{failure="Run cancelled";void session.abort();};process.once("SIGINT",cancel);process.once("SIGTERM",cancel);
  console.log(`Model: ${modelId}\nRun: ${dir}`);
  try {
    for(let round=0;round<rounds;round++){
      let timedOut=false;const timer=setTimeout(()=>{timedOut=true;console.log(`  round ${round+1}: time limit reached; aborting`);void session.abort();},roundTimeoutMs);
      try {await session.prompt(round===0?`${api.overview}\nImplement this brief in the three scaffold files. $target is a placeholder, never a literal ID. Read recipes for declarative fields/standard commands, dom for rich text, and stories before writing stories.\n${JSON.stringify(brief,null,2)}`:`Independent validation has not completed. Repair failures or report an API gap.\n${JSON.stringify(latest)}`);}finally{clearTimeout(timer);}
      completedRounds++;if(timedOut){failure="Model round timed out";break;}if(failure||gaps.length||toolCalls>=32)break;
      latest=await validatePackage(sources,brief);if(latest.complete)break;
    }
  } catch(error){failure=String(error);}finally{process.off("SIGINT",cancel);process.off("SIGTERM",cancel);session.dispose();}
  // Independently run final current bytes, including the actual preview artifact.
  await fileWrites;
  latest=await validatePackage(sources,brief,{artifactDir:dir});
  if(await contractFingerprint()!==fingerprint)failure=[failure,"SDK or oracle changed during the run; rerun against a stable tree"].filter(Boolean).join("; ");
  const status=gaps.length?"api-gap":failure?"failed":latest.complete?"passed":"needs-repair";
  await writeArtifacts(dir,brief,latest,{status,model:modelId,baseUrl,piVersion:"0.85.1",bunVersion:Bun.version,contractHash:fingerprint,apiHash:hash(JSON.stringify(api)),briefHash:hash(JSON.stringify(brief)),elapsedMs:Date.now()-started,revisions,toolCalls,completedRounds,gaps,failure,events,
    bounds:{rounds,roundTimeoutMs,toolCalls:32,sourceRevisions:12,modelChecks:6,runtimeTimeoutMs:20000,browserTimeoutMs:90000},
    remainingGates:["human source review","native IME coverage beyond composition-event simulation","browser performance budgets","HTML/PDF export adapters"],
  });
  console.log(`Result: ${status}\nPreview: ${join(dir,"preview.html")}\nReport: ${join(dir,"report.json")}`);return {dir,status};
}
