# @nooq/plugins

The developer-bundled plugin API from [proposal 0002](../../proposals/0002-plugin-api.md).
Definitions and the runtime are DOM-free. `@nooq/editor` supplies the document,
authorization, signing, and surface adapters. Plugins are trusted application
code; this API is not a security sandbox or a runtime installer.

## Use a plugin

```ts
import { Editor, createSurface } from "@nooq/editor";
import { callouts, insertCallout, cycleTone } from "@nooq/plugin-callouts";
import { calloutsDOM } from "@nooq/plugin-callouts/dom";

const editor = new Editor({
  docId: "notes", actor: { actorId: "human:me" }, plugins: [callouts],
});
const surface = createSurface(editor, { plugins: [calloutsDOM] });
document.body.append(surface.element);
const result = editor.commands.run(insertCallout, { parent: null });
if (result.status === "applied") {
  editor.commands.run(cycleTone, { block: result.selection!.block });
}
```

On teardown, call `editor.close()` to abort jobs and dispose mounted surfaces.

A bare `Editor` has no feature plugins. The reference application explicitly
installs `referencePlugins`, `referenceDOM`, and `referenceJobBindings()` from
`@nooq/editor/reference`. Writing basics are independently available as
`essentials` from `@nooq/plugins/essentials`. The Callouts package imports only
public APIs and works independently of that preset. Unknown content remains
stored, synchronized, and visible through a generic fallback, including children.

## Define features

`defineBlock` supplies an exact stored type, label, text mode, creation defaults,
and pure diagnostics. `create()` returns fields and optional rendered text;
the command context supplies fresh IDs and the active actor's attribution.
Defaults are never written while reading old content.

`defineCommand<Args>` supplies `id`, `label`, a runtime `validateArgs` type
guard, and synchronous `prepare(ctx, args)`. The context contains a detached,
recursively frozen `snapshot`, `actor`, `isAlive`, `parentOf`, `createBlock`,
and optional logical selection. Return `not-applicable`, or `ready` with an
intent, operation batch, and optional `{ block, anchor, head }` selection.

`editor.commands.run` validates, prepares, authorizes, and commits once without
yielding. Results are `applied`, `not-applicable`, `denied` (including retryable
readiness failures), or `failed`. Empty batches do not log. Ordinary commands
cannot choose the actor, signer, transaction ID, or clocks. Provenance records
the selected command's plugin. `commands.preview` prepares/validates without
mutation; execution prepares again and may allocate different IDs.

`prepareCommand` remains a standalone preparation helper for tools; it does not
authorize or commit. Use editor dispatch for actual editing.

## Compose and dispose

`definePlugin` groups blocks, commands, and jobs under an ID, semantic package
version, and `apiVersion: 1`. Optional `requires` contains semver ranges. The
registry validates IDs, versions, missing dependencies, and cycles before the
editor starts. Setup runs dependencies first with lexicographic ties.

Conflicting contributions fail unless the host explicitly selects an owner:

```ts
new Editor({
  docId, actor, plugins: [essentials, replacement],
  resolve: { "command:nooq.text.split": "my.replacement" },
});
createSurface(editor, {
  plugins: [essentialsDOM, paragraphDOM],
  resolve: { "view:nooq.paragraph/v1": "my.paragraph-view" },
});
```

Overrides must preserve the original contract; matching IDs cannot prove
semantic compatibility. Typed references and string dispatch both invoke the
selected provider's validator. Text bindings dispatch through `nooq.text.edit`
when registered, so overriding that command also affects typing.

Optional synchronous `setup(scope)` gets an abort signal, per-editor state,
immutable snapshots, change subscriptions, selectors, and cleanup registration.
Cleanup runs once in reverse dependency order, including partial setup failure.
Events carry the local revision, local/remote origin, changed block IDs,
field/text/structure changes, roots/access flags, and the local transaction
when known. Awareness does not advance the document revision. Observers cannot
dispatch durable repair loops. Errors are isolated and observable through
`onError`, `editor.onError`, and `editor.errors`.

`editor.diagnose(id)` evaluates only that block on demand and caches by its
stored data. Typing in an unrelated block never runs a diagnostic sweep.

## Views and actions

`defineDOMPlugin` is exported separately from `@nooq/plugins/dom`. Each view
mounts once per block ID, returns `{ element, update, destroy? }`, and retains
`ctx.children.element`. The surface reconciles children and moves existing
instances. A failed view becomes a generic fallback for that block.

`ctx.mountText()` supplies a textarea binding with splice-based selection
mapping and composition handling. Bindings update independently of the custom
view and survive field edits and moves. `ctx.run` dispatches registered
commands from controls. Menus and keymaps declare command/job references and
argument factories; references are checked before mount. Shortcut collisions
require an explicit `keyOrder`. Only `not-applicable` falls through.

Views can subscribe to changes and use the guarded review/accept/reject
services. They cannot dispatch from mount/update or after disposal. Disposing a
view aborts an acceptance that is still validating. Custom-view accessibility
remains the author's responsibility; the host text binding is labelled and
the Callouts example includes a keyboard-accessible tone button.

## Jobs and proposals

Use `defineJob<Args, Result>({ id, label, validateArgs, publishes, run })`.
Providers are ordinary factory dependencies, as shown by
`rewritePlugin({ generate })` in `@nooq/editor/reference`.

```ts
const feature = rewritePlugin(myProvider);
const editor = new Editor({
  docId, actor, key,
  plugins: [essentials, review, feature.plugin],
  jobBindings: [{ job: feature.job, actor: modelActor, signer: modelKey }],
});
await editor.ready; // verifies configured private/public key pairs
const handle = editor.jobs.start(feature.job, { block: blockId });
handle.onProgress(value => showProgress(value));
const result = await handle.result; // handle.cancel() aborts independently
```

Publishing identities are fixed by the host, never job arguments. The context
exposes no signing key or live document. `ctx.capture()` freezes a base before
generation; `readBlocks` and `readSubtrees` expose declared live content.
`ctx.publish(base, { ops, context?, intent? })` adds mandatory operation
dependencies to declared reads and computes all evidence from that original
base. Publication rechecks current permission; it does not recapture changed
content and pretend an old result is fresh. A completed/cancelled/disposed
job cannot publish late, even if its provider ignores abort.

Current evidence supports ID-targeted text/field changes and non-root
structural batches. Root-list changes, restore/tombstone dependencies, and
access changes return `unsupported-evidence`. Root block text/field changes
are supported; there is no unconditional root-digest comparison. This service
does not prove that arbitrary trusted code declared every semantic read.

`editor.reviewSuggestion(id)` returns the payload, revision, and evaluation
the writer reviews. `accept(id, { reviewed, force? })` checks liveness, payload,
authorization, and a synchronous revision comparison immediately before commit.
It retries a lost normal-validation race at most once. Force approval expires
when the reviewed revision changes. Disconnected concurrent acceptance still
requires a shared protocol solution; this is a local/observed-state guarantee.

## Secured documents and limits

`authorizeLocal` in core validates logical operations before local mutation;
remote admission independently inspects actual CRDT updates. Both share role,
kind, access, and adoption policy. Missing genesis/grants/signers refuse the
edit without optimistic mutation. `editor.initializeAccess(access)` performs
the asynchronous genesis identity check before a synchronous owner commit.
Signing/delivery remain asynchronous and failures use the error channel.

The legacy application-level `propose()` and `aiKey` configuration remain for
compatibility. New publishing plugins use job bindings and captures. Neither
legacy API is passed to plugin contexts.

Native snapshots retain unknown data. Format-specific export adapters,
migrations, undo, attribute-bearing inline marks, dynamic plugin installation,
virtualized/rich-text surfaces, and distributed suggestion settlement remain
separate work. This implementation does not claim production performance at
all document sizes; the repository's browser lab records those budgets.

## Verify changes

Run `bun run typecheck` and `bun test` from the repository root. The integration
suite in `packages/editor/test/plugins.test.ts` exercises the public Callouts
package, missing-plugin peers, overrides, cleanup, permissions, original-base
job evidence, cancellation, and acceptance races. The capture unit tests live
in `packages/plugins/test/jobs.test.ts`; the plugin-agent checks remain separate.

Browser benchmarks are opt-in (`bun run lab`). `NQ_LAB_GATE=report` records
measurements without enforcing the latency budgets; a passing report-mode
run is not a performance-budget pass. The current surface still exceeds the
keystroke frame budget, so performance work remains before the seed releases.
