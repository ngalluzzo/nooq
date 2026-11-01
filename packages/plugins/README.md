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

For common text blocks, the additive authoring recipes remove repeated validation
and command code:

```ts
import { defineBlockSchema, field, cycleFieldCommand, insertBlockCommand } from "@nooq/plugins";
const note = defineBlockSchema({ type: "example.note/v1", label: "Note", text: "inline",
  fields: { tone: field.enum(["info", "warning", "success"], "info") },
});
const insert = insertBlockCommand(note, { id: "example.note.insert", label: "Insert note" });
const cycle = cycleFieldCommand(note, "tone", { id: "example.note.cycle", label: "Cycle tone" });
```

Register these definitions in an ordinary `definePlugin`. `setFieldCommand`
provides an explicitly chosen, schema-validated field value. String, finite
number, and boolean descriptors are also available. Schemas validate supported
local authoring and report diagnostics; unknown stored data is retained. Defaults
apply only to newly created blocks. `apiVersion` remains 1.

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
require an explicit `keyOrder`. Unavailable actions and `not-applicable` commands
fall through; applied, started, denied, and failed results consume the shortcut.

Views can subscribe to changes and use the guarded review/accept/reject
services. They cannot dispatch from mount/update or after disposal. Disposing a
view aborts an acceptance that is still validating. Custom-view accessibility
remains the author's responsibility; the host text binding is labelled and
the Callouts example includes a keyboard-accessible tone button.

`ctx.mountRichText({ label, marks? })` supplies a ProseMirror-backed contenteditable
binding for any plugin block. It exposes `element`, `selection()`,
`focus({ anchor, head })`, `toggleMark(name)`, and idempotent `destroy()`; no engine
objects escape. Offsets are UTF-16. Strong, emphasis, and code marks are supported;
unknown marks survive as opaque stored data. Mod-B/Mod-I/Mod-backtick toggle marks.
Host key actions run first; otherwise Enter inserts a newline. Paste currently
inserts plain text. The host owns remote selection mapping, composition handling,
rollback after denied edits, and cleanup. One text binding is allowed per view.

Both text bindings retain the same text-command override behavior. The exported
`insertAfterSelection` argument factory handles common slash-menu placement.
Rich bindings are scoped to individual blocks, with opt-in document selection
coordinating ranges and compatible structural joins. Collaborative undo, rich
clipboard codecs, and arbitrary mark definitions remain separate work. See [proposal 0004](../../proposals/0004-plugin-authoring-v2.md).

### Text policies

Declare `textPolicy: defineTextPolicy({defaultMode: "rich", enter: "newline"})`
on a view and mount its text with `ctx.mountTextEditor({label})`. Import both
public types and the factory from `@nooq/plugins/dom`. Applications choose a
surface-wide presentation with `createSurface(editor, {plugins, textMode: "plain"})`.
The preference is fixed at mount; remounting never migrates stored data. The
binding exposes mode, element, selection, focus, toggleMark, and destroy; plain
mode returns false from toggleMark. Explicit mountText/mountRichText retain their
fixed presentation and legacy key behavior.

Writing Basics defaults to plain text with `enter: {command: splitBlock}`;
Callouts defaults to rich text with literal newlines. Policy Enter takes
precedence over global Enter shortcuts. Shift+Enter inserts a newline, and
cancelable beforeinput paragraph/line-break events use the same command path.
Commands receive the current UTF-16 block selection, mapped through admitted
remote text even before its queued render. Composition Enter does not split.
Declined splits never fall back to a different edit; rejected replacements
restore text and the original directional range. Optional marks restricts
formatting actions while preserving existing and opaque marks.

These are authoring policies, not admission rules. Rich clipboard codecs,
dynamic policies, and collaborative undo are separate work.

### Document-wide text selection

Enable the surface coordinator when composing rich views:

```ts
const surface = createSurface(editor, {
  plugins: [essentialsDOM, calloutsDOM],
  textMode: "rich",
  selectionMode: "document",
});
surface.selection!.set({
  anchor: { block: firstBlock, offset: 2 },
  head: { block: lastBlock, offset: 5 },
});
const selectedText = surface.selection!.text();
const result = surface.selection!.replace("Replacement text");
```

Document mode requires a registered `nooq.text.edit` command. `surface.selection`
is absent in the default block mode. The service exposes `get`, `set`, `clear`,
`text`, `replace`, `merge`, and `toggleMark`; logical endpoints use block IDs and UTF-16
offsets. Returned values are detached. An invalid set clears the old range.
Selection is local UI state and is never serialized into the document.

Mouse dragging, Shift+Left/Right, Ctrl/Meta+Shift+Home/End, and Ctrl/Meta+A work
across mounted rich-text bindings in model order. Copy joins selected text with
newlines, excluding controls, labels, and stored fields. Cut and plain-text paste
share the range replacement path. Mark toggles require every selected binding to
support the mark and preserve unrelated/opaque marks. Legacy textareas and views
whose child slot precedes their own text form barriers; they keep block editing.

For compatible blocks, replacement, cut/paste, Backspace/Delete, and Enter merge
into the first block in document order (Enter inserts a literal newline).
Compatibility requires the same registered type with `textMerge: "same-type"`,
equal fields, no children, and consecutive siblings under the same parent. Writing
Basics opts in for paragraphs, headings, and quotes; different types never join.
Ordinary replacement across incompatible blocks retains the previous text-only
behavior: insert into the first segment, clear the rest of the selected text, and
keep every block, field, type, and child. Replacement text is unmarked; surviving
prefix and suffix text retains all marks, including unfamiliar marks.

`surface.selection.merge(text = "")` explicitly requests a structural join and
returns `not-applicable` for incompatible ranges, with no text-only fallback.
Backspace at a collapsed start or Delete at a collapsed end uses the same merge
command for the adjacent block. Incompatible boundaries are consumed without
falling through to legacy empty-block deletion. This includes blocks with children.

### Structural merge contracts

`textMerge` belongs to the portable block definition, not its DOM presentation.
Third-party schemas can opt in through `defineBlockSchema({ ..., textMerge:
"same-type" })`. The rule compares every field, including unknown fields, and
permits nested leaf siblings without reparenting. Non-text siblings, different
parents, unknown types, opt-out schemas (including Callouts), and child-bearing
blocks are barriers. The first block's identity, type, and fields survive. Absorbed
blocks become ordinary tombstones retaining their original content and fields;
the operation does not rewrite them or introduce a stored schema migration.

The selected `nooq.text.merge` command owns the atomic transaction and resulting
caret. Its standard recipe prepares the selected `nooq.text.edit` for the survivor
and `nooq.block.delete` for each absorbed sibling. Any refusal, exception, invalid
result, or authorization denial prevents the entire commit. Once a compatible
merge is attempted, failure never falls back to text-only replacement. The recipe
requires each delegated provider to return exactly the planned operations: an
override that transforms text or adds side effects must also provide its own
merge command. Delegated caret requests are replaced by the merge command's caret
at the join. A custom merge command's final caret is honored by the surface.

Commands now have `ctx.blockDefinition(type)` and synchronous
`ctx.prepare(command, args)`. Preparation resolves selected providers, validates
and freezes arguments, shares one frozen snapshot, and never dispatches. Child
contexts see their own provider identity; the final transaction uses the outer
command's identity and authorization. The caller must return the prepared
operations and propagate refusals. Recursion, asynchronous results, and using
`ctx.prepare` after its callback returns are rejected. This is preparation
composition, not nested transactions. Structural compatibility is recomputed at
execution; concurrent unseen edits retain the underlying CRDT/tombstone semantics,
not a promise of automatic relocation from an absorbed block.

Text-only range edits call `editor.commands.batch("nooq.text.edit", inputs)` once. Batch
prepares independent invocations of one selected command against one frozen
snapshot, then validates, authorizes, and commits one operation batch with that
plugin's identity. Any invalid, throwing, empty, or declined invocation prevents
the entire commit. Inputs do not observe each other's proposed edits. This API is
not an asynchronous transaction or a general mixed-command composition mechanism.

Remote text maps both endpoints before execution, including before a queued
render. Changes to span membership (insertions within it, moves, deletions) cancel
the range instead of selecting unintended content. Focus leaving the surface and
disposal invalidate it. Denied/declined edits keep the original selection.

This slice does not qualify native IME replacement of cross-block ranges, touch
selection handles, vertical/word-granularity range extension, rich clipboard
codecs, drag/drop editing, collaborative undo, or performance budgets. Native
cross-block drag/drop is suppressed rather than allowed to edit plugin DOM.
The existing block-scoped composition behavior remains available after collapsing
the range. The independent Chromium gate is:

```sh
bun run --cwd packages/design test:selection-browser
```


### Shared actions

Define an action once and reuse it across host placements:

```ts
import { defineAction, defineDOMPlugin } from "@nooq/plugins/dom";
const cycleAction = defineAction({
  id: "example.note.cycle", label: "Cycle tone", command: cycle,
  args: ctx => ({ block: ctx.block }),
  placements: ["toolbar"], keys: ["Ctrl+Shift+Y"],
  when: ctx => ctx.snapshot.blocks[ctx.block]?.type === note.type,
  enabled: ctx => note.fields.tone.validate(ctx.snapshot.blocks[ctx.block]?.fields.tone)
    || "Choose a supported tone before cycling.",
});
// Register actions: [cycleAction] on defineDOMPlugin.
// Inside mount(ctx), append ctx.mountActionToolbar({label: "Note actions"}).element.
```

Use `placements: ["slash"]` and `args: insertAfterSelection` for insertion.
An action can use both placements and several keys. `command` or `job` accepts a
typed definition (arguments are inferred) or a registered string ID. Exactly one
target is required. Keys use the existing exact modifier order
`Ctrl+Meta+Alt+Shift+<event.key>`; omit unused modifiers. The host's `keyOrder`
resolves collisions with both legacy and shared shortcuts.

`surface.actions.list(blockId, placement?)` exposes immutable metadata and
`enabled`, `hidden`, or `disabled` availability (with a reason). Listing does not
prepare commands, allocate block identities, or authorize operations. `when`
and `enabled` are synchronous, read-only predicates over a frozen snapshot and
selection. Throwing or invalid predicates fail closed and report through the
editor's error channel. External provider/configuration state is not yet an
observable action dependency; use document and selection state in this slice.

`surface.actions.run(actionId, blockId)` rechecks liveness and availability, builds
arguments from current state, then dispatches through the normal command/job
runtime. It returns the command result, `unavailable` with a reason, or `started`
with the job handle. Enabled UI is advisory: authorization can still deny the
command. `ctx.actions.list/run` bind these operations to the current view's
block and lifetime. Disposed views cannot invoke them even after a block returns.

Host toolbars update on document and selection changes, retain stable buttons,
support arrow/Home/End navigation, expose disabled reasons to assistive technology,
and preserve text selection on pointer activation. Mounted toolbars clean up with
their view; calling `destroy()` early is also safe. Open slash menus refresh their
availability. Every invocation rechecks current state, including clicks made
before a scheduled render catches up.

The existing `menus`, `keys`, `ctx.run`, and manual controls remain supported.
Shared action IDs must be unique across the surface, including legacy IDs;
replace a legacy contribution when migrating that action. The public action list
contains shared definitions only. Custom palettes can consume this list; a
built-in palette and portable formatting actions are later work.

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
virtualization, document-wide rich-text plugin composition, and distributed suggestion settlement remain
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
run is not a performance-budget pass. Rich bindings still need the native IME and
browser performance release gates; passing unit or Storybook tests does not
establish those budgets.
