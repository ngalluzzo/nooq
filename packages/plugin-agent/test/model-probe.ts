import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { localModel } from "../src/model.ts";

export async function probe() {
  let payload: any;
  const dir = await mkdtemp(join(tmpdir(), "nooq-model-contract-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    payload = await request.json();
    return new Response('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }});
  try {
    const baseUrl = server.url.href + "v1";
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(dir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider("nooq-local", { baseUrl, api: "openai-completions", models: [localModel("test-local", baseUrl)] });
    await runtime.setRuntimeApiKey("nooq-local", "test-only");
    const result = await runtime.completeSimple(runtime.getModel("nooq-local", "test-local")!, { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }] }, { maxTokens: 8192, signal: AbortSignal.timeout(5000) });
    return { stopReason: result.stopReason, payload };
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
}
