import type { Model } from "@earendil-works/pi-ai";

/** Pi sends chat-template kwargs only for a reasoning-capable model with this format. */
export function localModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id, name: id, provider: "nooq-local", baseUrl, api: "openai-completions",
    reasoning: true, input: ["text"], contextWindow: 32768, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false,
      maxTokensField: "max_tokens", thinkingFormat: "chat-template",
      chatTemplateKwargs: { enable_thinking: false },
    },
  };
}
