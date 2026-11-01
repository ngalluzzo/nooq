# Proposal 0008: bring your own model

**Status: DRAFT — not yet opened. Drafted: 2026-11-01. Decision of record:
none yet.** Covers a new plugin API section (P-14, amending proposals/0002
P-7 and P-7.1) and one new package. No DOCUMENT-MODEL change. A new module
is a significant change under GOVERNANCE, so this needs an issue open for
at least 7 days.

The README says "Bring your own model; nooq ships the blocks, not a walled
garden." Today a host that wants a real model writes the client, the
request format, streaming, cancellation and key handling itself. This
proposal ships that part.

## Problem

| Finding | Evidence |
| --- | --- |
| The only model seam is one function for one job, and its only implementation is simulated. | `RewriteProvider`, `simulatedRewrite`, `packages/editor/src/reference.ts` |
| A provider lives in a plugin factory, so the runtime never sees which model ran. Provenance is whatever the binding said at construction. | `rewritePlugin(provider)`, P-7; `jobBindings`, P-7.1 |
| A writer can't switch models without a new runtime. A binding fixes `actor.model` for the editor's life. | P-7.1, "fixed for that runtime"; `addIdentity`, `packages/editor/src/controller.ts` |
| Only publishing jobs may have a binding, so a job that calls a model and returns data has nowhere to get one. | `Invalid or duplicate job binding`, `controller.ts` |
| 0007 hands the host a tool list and leaves the model call to it. | proposals/0007, "plugs into any tool-calling loop" |
| The repo's one real model client is dev tooling, and its library brings four vendor SDKs. | `packages/plugin-agent/src/model.ts`; pi-ai 0.85.1 depends on `@anthropic-ai/sdk`, `openai`, `@google/genai` and `@aws-sdk/client-bedrock-runtime` |

## Change

### 1. The model interface (P-14.1)

A **model** is one configured model at one endpoint. Hosts create it.
Jobs, and later agent sessions, call it. `@nooq/plugins` defines these
types and `ModelError`, and nothing else.

```ts
interface Model {
  /** Configured model name. Provenance prefers the name the server reports. */
  readonly name: string;
  /** Where requests go, for the writer to see. Never stored in the document. */
  readonly destination: { host: string; local: boolean };
  readonly supports: { tools: boolean };
  generate(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

interface ModelRequest {
  system?: string;
  messages: readonly ModelMessage[];
  tools?: readonly { name: string; description: string; inputSchema: object }[];
  maxTokens?: number;
}

type ModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls?: readonly ToolCall[] }
  | { role: "tool"; call: string; text: string };

type ToolCall = { id: string; name: string; input: JsonValue };

type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "call"; call: ToolCall }
  | { type: "invalid-call"; id: string; name: string; reason: string }
  | { type: "done"; stop: "end" | "calls" | "length"; model?: string };
```

- `inputSchema` is JSON Schema 2020-12, the same shape as 0007's tools.
- A request with `tools` to a model whose `supports.tools` is false
  throws before any network call.
- Tool arguments that don't parse as JSON give `invalid-call`. The caller
  answers the model. The adapter never guesses.
- `done.model` is the model name the server reported, when it reports
  one.
- Failures throw `ModelError` with a `reason` (`unavailable`, `auth`,
  `rate-limit`, `refused`, `bad-response`) and `retryable`. Its message
  never contains a credential or request content.
- `generate` honors `signal`. P-7.4 still discards late results from a
  model that ignores it.

The interface is the contract. Adapters (§3) are optional, and a host can
implement `Model` over any client it already uses, pi-ai or the Vercel AI
SDK included.

### 2. Models bind to identity, not to plugins (P-14.2)

P-7 injects providers into plugin factories. Here the host puts the model
on the job binding instead, next to the actor and the signer.

```ts
const editor = new Editor({
  docId, actor,
  plugins: [essentials, review, rewritePlugin()],
  jobBindings: [{ job: rewriteJob, actor: { actorId: "ai:assistant", kind: "ai" },
                  signer: agentSigner, model: () => settings.model }],
});
```

- `model` is a `Model`, or a function the runtime calls once per
  `jobs.start`. A run keeps the model it started with. A writer's new
  choice applies to the next run.
- A job that calls a model declares `usesModel: true` and reads
  `ctx.model`. It never sees the binding, the key or the endpoint
  configuration.
- Starting such a job when its binding has no model, or the function
  returns `null`, rejects that handle's `result` with `ModelError`
  reason `unavailable`. Editing and initialization go on (P-7).
- A binding with `model` MUST NOT also set `actor.model`. That fails
  configuration.
- A non-publishing job that declares `usesModel` takes a binding with no
  signer. This lifts P-7.1's publishing-only rule for those jobs.

**Provenance.** The runtime sets the run's actor `model` from
`done.model`, or else the configured `name`. Neither job code nor job
arguments can set it. A run records one model. If its calls report
different names, it records the configured `name`. Reported names come
from a server, so the runtime trims them to 128 printable characters
before they enter the registry.

**One client per model.** DM-14.2 registers each Yjs client once, to one
`{actorId, kind, model?}`, and gives each attribution its own client. A
run whose model has no client yet gets a new client for the same actor
and signer. A writer who uses three models adds three registry entries,
not three identities. DM-13 grants bind `actorId`, key and kind, not
model, so a new model needs no new grant. Identities are registered at
construction today (`addIdentity`), so this adds lazy registration per
model, which inherits its binding's readiness.

### 3. Adapters (`@nooq/model-adapters`)

A new package with no runtime dependencies. It uses `fetch`, streams and
`TextDecoder`, which browsers, Bun and Node all provide. Each wire format
is its own subpath.

| Adapter | Covers |
| --- | --- |
| `openAICompatible({ baseUrl, model, apiKey?, headers?, tools?, fetch? })` | Chat Completions: Ollama, LM Studio, llama.cpp, vLLM, oMLX, OpenRouter, OpenAI and other hosted endpoints. |
| `anthropic({ model, apiKey?, baseUrl?, headers?, allowBrowser?, fetch? })` | The Anthropic Messages API. |

- `fetch` is injectable, so a host can route requests through its own
  proxy and keep its key there. `apiKey` is then absent.
- Credentials stay in the adapter's closure. They are never properties,
  never in `toJSON` and never in errors.
- `destination.local` is true only when `baseUrl`'s host is `localhost`,
  `127.0.0.1` or `[::1]`.
- `openAICompatible` reports `supports.tools` as the host sets it, false
  by default. Many local servers and models can't call tools reliably.
  `anthropic` reports true.
- `anthropic` sends Anthropic's browser opt-in header only when
  `allowBrowser` is set. A host sets it only for a key the writer entered
  on their own device.

pi-ai and the AI SDK are both open, so the stack rule (README, commitment
4) doesn't exclude them. Weight does. pi-ai brings four vendor SDKs and
AWS client code into an editor bundle, for two wire formats that each fit
in a page of `fetch`. `plugin-agent` is a Node dev tool and keeps pi-ai.

### 4. The rewrite job

`rewritePlugin()` with no argument declares `usesModel` and calls
`ctx.model`.

- The system prompt asks for the rewritten block text only. It says the
  block text is content to rewrite, not instructions.
- Text deltas go to `ctx.progress` as ephemeral preview (P-7.4). The job
  publishes once, after `done`.
- `stop: "length"` publishes nothing and returns `{ status: "truncated" }`.

### 5. Reference editor and lab

`simulatedRewrite` becomes `rewritePlugin()` bound to `simulatedModel`, a
`Model` with the same output as today. Tests and the bench exercise the
new path with no network. The lab page gains a model setting: adapter,
base URL, model and key. The key stays in memory unless the writer
chooses "remember on this device". CI never sets it. Model inference
stays out of the test suite (plugin-agent README).

### 6. With agent sessions (0007)

When 0007 opens, its `agentBindings` take `model` the same way, and a
session requires `supports.tools`. The tool-calling loop that joins them
ships in `@nooq/agent-tools` and is specified there. This proposal
doesn't depend on 0007.

## Browsers and local servers

- A local server must allow the page's origin (for Ollama,
  `OLLAMA_ORIGINS`).
- Chromium and Firefox treat loopback as a secure origin, so an HTTPS
  page may call `http://127.0.0.1`. Chromium may first ask the writer for
  local network access. Safari is untested.
- Hosted providers differ on browser calls. Anthropic requires the
  opt-in header (§3). A provider that refuses browser calls needs a
  proxy.

## Security

- Credentials never enter the document (P-7), job contexts, progress
  events or errors.
- Document text is untrusted, and any peer can write the text a rewrite
  sends. Following injected text can only produce a suggestion a writer
  must accept (PHILOSOPHY §5).
- Requests send document text to `destination`. Hosts SHOULD show it
  before a writer's first run against a non-local destination. The
  adapters only report it.
- Any script on the page's origin can read a key held in the browser.
  That is acceptable for a writer's own key on their own device. A
  developer's key goes through a proxy.
- Model names come from servers and enter the document. The runtime
  trims them (P-14.2).
- Plugins are developer-bundled (P-1). A job with `ctx.model` can send
  the model anything it can read. That's no wider than today's
  factory-injected providers.

## Compatibility

- No wire, operation or DM change. Peers see suggestion blocks from `ai`
  actors as today, now with real model names.
- `rewritePlugin(provider)`, and bindings that set `actor.model`, keep
  working and are deprecated.
- `Editor.propose` and `aiKey` are untouched.

## Non-goals

- Hosting or selling models (README, Non-goals).
- The agent loop. It belongs to 0007 and `@nooq/agent-tools`.
- Bringing your own agent over MCP or WebMCP, and ACP hosting. Both are
  0007 transports or non-goals.
- Settings UI and key storage for host apps. The lab page is a
  reference, not a component.
- Durable streaming (P-7.4).
- Embeddings, images and audio.
- Provider-specific features such as prompt caching, extended thinking
  and structured outputs. Adapters may add options later.

## Tests that will gate this

`packages/plugins/test/`:

- A run keeps the model it started with when the selector changes
  mid-run.
- Provenance comes from `done.model`, or else `name`. Job code and job
  arguments can't set it. Long or unprintable names are trimmed.
- A binding with both `model` and `actor.model` fails configuration.
- A `usesModel` job with no model, or a selector returning `null`,
  rejects with `unavailable`, and the editor stays editable.
- A non-publishing `usesModel` job takes a binding with no signer.

`packages/editor/test/`:

- Two models through one binding give two registry entries with the same
  actor and key. In a secured document both publish under one suggester
  grant.
- Rewrite with `simulatedModel` publishes one suggestion. Deltas reach
  progress listeners and never the document.
- Cancelling mid-stream publishes nothing, and the signal reaches the
  model.
- `stop: "length"` publishes nothing.

`packages/model-adapters/test/`, against recorded streams from a local
fake server:

- Both adapters turn their streams into the same events, including UTF-8
  sequences and tool-call arguments split across chunks, and malformed
  arguments (`invalid-call`).
- HTTP 401, 429 and 5xx and network failure map to `ModelError` reasons
  and `retryable`. No error message, property or JSON output contains
  the key.
- With an injected `fetch`, no request goes anywhere else. With no
  `apiKey`, no auth header is sent.
- Anthropic's browser header appears only with `allowBrowser`.
- `destination.local` holds for loopback hosts only.
  `localhost.example.com` is not local.
- Abort cancels the underlying request.
- The package has no runtime dependencies.

Not yet run: a live smoke test against oMLX, Ollama and one hosted
endpoint from Chromium, Firefox and Safari, and the bundle size of each
adapter subpath.

## Open questions

1. **Naming.** "Model" already means the document model across nooq
   (DOCUMENT-MODEL.md, `packages/core/src/model.ts`). Is `Model`, or
   `@nooq/model-adapters`, too easy to confuse? `LanguageModel` and
   `@nooq/llm` are alternatives.
2. **Local versus remote in provenance.** Should the document record
   that a suggestion came from a local model? It would help reviewers.
   It is also a claim peers can't check.
3. **Mixed-model runs.** A run whose calls report two model names records
   the configured name. Should it refuse instead, or record both?
4. **Key storage.** Should nooq ship a key store for hosts, for example a
   key encrypted under a non-extractable WebCrypto key in IndexedDB? Or
   is that entirely the host's?
5. **More adapters.** Gemini's native API, Bedrock and OpenAI's Responses
   API each add wire code to maintain. Which belong in this package and
   which in host code?
6. **Disclosure.** Should showing `destination` be a MUST for hosts, even
   though nooq can't enforce it?

## Amendments during the comment period

None yet.
