# Proposal 0002: the plugin API

**Status: design draft — 2026-10-31.** Developer-bundled plugins first.
This is a proposed API, not an implemented or ratified contract. Names in
the examples are sketches; the existing document and sync protocols remain
authoritative. A public proposal and review under [GOVERNANCE](../GOVERNANCE.md)
precede adoption.

**Review revision — 2026-10-31.** Clarifies local authorization, acceptance
races, host-bound job identities, diagnostic scheduling, preview IDs, and
proposal evidence coverage following Claude's review and source validation.

## P-1. The decision

A plugin contributes **document features, commands, background jobs, and
optional views**. The host composes them explicitly. All durable changes
become ordinary nooq transactions.

Keep three boundaries:

| Layer | Owns | Does not own |
| --- | --- | --- |
| Document protocol (`@nooq/core`, CRDT adapter) | Identity, operations, merge, provenance, authorization, proposal evaluation | Installed plugins, DOM, providers |
| Plugin runtime (proposed `@nooq/plugins`) | Registration, command dispatch, job lifetime, scoped subscriptions | New wire operations or merge policies |
| Surface (`@nooq/editor`, optional adapters) | Views, selection, menus, shortcuts, accessibility | Authoritative document state |

The reference paragraph, heading, quote, and suggestion UI use the same
registration mechanism as an application plugin. The protocol meaning of
suggestions and their authorization remains in core: replacing their UI
cannot redefine acceptance or confer write access.

The initial runtime loads trusted TypeScript/JavaScript supplied by the
embedding application. Installation, a marketplace, remote code loading,
and a sandbox are separate work. These plugins execute with the host's
privileges; a narrow context is an API boundary, not a security boundary.

## P-2. What a plugin looks like

Definitions are inert values. Importing a headless plugin does not open a
connection, touch `document`, or mutate an editor. A definition can be
reused by multiple editors; mutable state belongs to an editor instance.

```ts
import { defineBlock, defineCommand, definePlugin } from "@nooq/plugins";
import type { BlockId } from "@nooq/core";

export const callout = defineBlock({
  type: "acme.callout/v1",
  label: "Callout",
  text: "inline", // editing affordance; storage is still DM-3
  create: () => ({ fields: { tone: "info" }, text: { s: "", marks: [] } }),
  diagnose(block) {
    return ["info", "warning"].includes(String(block.fields.tone))
      ? []
      : [{ field: "tone", message: "Unknown callout tone" }];
  },
});

export const toggleTone = defineCommand<{ block: BlockId }>({
  id: "acme.callout.toggleTone",
  label: "Toggle callout tone",
  validateArgs(input): input is { block: BlockId } {
    return typeof input === "object" && input !== null
      && "block" in input && typeof input.block === "string";
  },
  prepare(ctx, { block }) {
    const target = ctx.snapshot.blocks[block];
    if (!ctx.isAlive(block) || target?.type !== callout.type) {
      return { status: "not-applicable" };
    }
    return {
      status: "ready",
      intent: "toggle-callout-tone",
      ops: [{
        op: "setField",
        block,
        key: "tone",
        value: target.fields.tone === "warning" ? "info" : "warning",
      }],
    };
  },
});

export const callouts = definePlugin({
  id: "acme.callouts",
  version: "1.0.0",
  apiVersion: 1,
  contributes: { blocks: [callout], commands: [toggleTone] },
});
```

`defineBlock`, `defineCommand`, and `definePlugin` preserve type inference
and check definition shape. They do not register globally. A command
reference carries its argument type into dispatch:

```ts
const editor = new Editor({
  docId,
  actor,
  plugins: [essentials, callouts],
});

editor.commands.run(toggleTone, { block: calloutId });
```

`essentials` is an explicit preset of ordinary first-party plugins. A bare
editor has the transaction runtime and generic content fallback; it does
not silently install a feature set. Registry-based dispatch by string ID
also exists for menus and application configuration, with runtime argument
validation supplied by the command. Typed calls still cross that validation
boundary; TypeScript types alone do not validate runtime input.

## P-3. Registration and composition

A plugin has `id`, package `version`, `apiVersion`, optional
`requires: Record<PluginId, VersionRange>`, contributions, and optional
`setup(ctx)`. Dependencies are declared and checked, never fetched.
The first runtime supports API version 1 exactly.

Compilation happens synchronously before an editor becomes editable:

1. Reject duplicate plugin IDs, incompatible versions, missing required
   plugins, and dependency cycles.
2. Resolve contribution conflicts and validate UI references to commands
   and jobs. A reference to an unavailable feature is a configuration error.
3. Build immutable lookup tables. Dependency order governs setup; ties
   use lexicographic plugin IDs, never package import order.
4. Create per-editor scopes. Mount surfaces independently; start expensive
   work only on explicit invocation or after initial editing is available.

Plugins are fixed for an editor's lifetime in v1. Configuration changes
recreate the plugin runtime around the same document; they never remove
document content. There is no hot replacement protocol yet.

**Overrides are explicit.** Duplicate contribution slots fail unless the
host selects their owner. For example, two DOM bundles providing a view
for `nooq.paragraph/v1` require:

```ts
createSurface(editor, {
  plugins: [essentialsDOM, customParagraphDOM, calloutsDOM],
  resolve: { "view:nooq.paragraph/v1": "acme.paragraph" },
});
```

The value is the providing plugin's ID. The same rule applies to headless
slots through `EditorOptions.resolve`, for example
`"command:nooq.paragraph.insert"`. A selection must name a present provider
of that slot. No last-registration-wins rule or global numeric priority.

Replacing a command preserves its argument/result contract. Replacing a
block definition preserves its stored type's meaning; incompatible stored
data needs a new version. Type declarations and conformance tests check
compatibility where possible; matching IDs alone cannot prove it.
Dependencies refer to plugin identity, not implicit capability discovery.

Menus may have an explicit display order, with contribution ID as the
tie-breaker. Shortcut collisions require a host-selected ordered chain;
only `not-applicable` advances to the next binding. An error never falls
through and unexpectedly runs another edit.

## P-4. Stored content outlives its plugin

Plugin ID, npm version, API version, and stored block type are distinct:

- `acme.callouts` identifies a code provider.
- `1.0.0` versions that provider's implementation.
- `apiVersion: 1` selects the extension contract.
- `acme.callout/v1` defines persisted content semantics.

A block definition supplies creation defaults, diagnostics, and editing
affordances. `create()` returns fields and optional rendered text, never
identity, attribution, children, or CRDT internals. A public command-context
helper creates the full block with the active actor and a fresh ID. Child
insertions are separate DM-4 operations in the same transaction.

`text: "inline" | "none"` describes the intended editing UI. It does not
rewrite existing content or add a replicated tree grammar. All child
relationships still follow DM-3/4. Layout plugins may guide which children
users create, but cannot introduce their own merge-time tree constraints.

**Plugin diagnostics are not admission rules.** Commands should construct
valid content and may decline an action using diagnostics. Incoming
transactions are admitted using the shared document protocol, independently
of installed plugins. No plugin-defined `filterRemoteTransaction` hook.
Otherwise two peers with different plugin sets could reject different
updates. Cross-field invariants also cannot be guaranteed by a local
validator when DM-3.2 merges field registers independently.

`diagnose(block)` is a pure, synchronous check of that block's supplied
data, with no document queries, network access, or mutation. The runtime
runs it on demand for an inspected block or a subscribed diagnostics
panel, after the editor is editable and outside the input-to-paint path.
Results are cached by definition and block revision; a change invalidates
only that block's result, and unused diagnostics are not recomputed. An
explicit document-wide audit runs as a cancellable job. Commands may use
a cheap check of their own targets within the command's existing budget;
neither rendering every block nor saving requires a diagnostic sweep.

Unknown types, versions, fields, and mark names survive load, sync, copy,
and native export without rewriting. The surface provides a generic block
shell showing the type and available text, with children still reachable
and raw fields inspectable. Specialized editing may be unavailable;
generic move/delete/restore remain possible through ordinary commands.
Missing views must never make blocks silently disappear.

Creation defaults apply only to new blocks. Never fill missing defaults
by writing while reading an existing block. Plugin caches, DOM state,
provider credentials, and job progress stay outside the document.

Mark contributions initially describe existing **string mark names** and
their presentation/toggle commands. The current model has no mark
attributes or inline object nodes. Links with attributes, mentions, or
other richer inline semantics need an explicit document-model decision;
the plugin API must not pretend the storage protocol already supports them.

## P-5. Commands are synchronous, atomic intent

The minimum command contract is:

```ts
interface Command<Args> {
  id: string;
  label: string;
  validateArgs: (input: unknown) => input is Args;
  prepare(ctx: CommandContext, args: Args):
    | { status: "not-applicable" }
    | {
        status: "ready";
        intent: string;
        ops: readonly Op[];
        selection?: SelectionRequest;
      };
}
```

`CommandContext` provides an immutable snapshot, the active actor,
live-block/parent queries, optional surface selection, and the block
creation helper. It provides no live mutable document. `SelectionRequest`
is local state: block IDs and UTF-16 offsets, applied after the transaction.
It is never a wire operation. Headless callers supply targets explicitly.

`run()` validates arguments, captures current state, calls `prepare`,
validates the whole operation batch, checks local authorization, and
commits once, without yielding between preparation and commit. The runtime
allocates the transaction ID, Lamport/causality metadata, and signing
context. Ordinary commands cannot choose a different actor or signer;
public proposal/adoption services handle their protocol-defined exceptions.
The dispatching plugin is recorded in `actor.plugin` without changing the
human/importer/etc. actor kind.

Typed references and string dispatch use the same argument validator.
A no-argument command validates `undefined`. Validators must be pure,
synchronous, and cheap; all resulting operations also receive core
validation. Invalid arguments return `failed` without preparing an edit.

Results distinguish `applied`, `not-applicable`, `denied`, and `failed`.
`applied` means locally committed, not acknowledged by a network peer.
Signing or delivery failures use a separate observable error channel.
A thrown exception, invalid batch, Promise returned from `prepare`, or
authorization denial leaves the document unchanged. An empty batch is
`not-applicable` and does not append a log entry.

### P-5.1 Local authorization before mutation

The runtime needs a new pure core primitive, provisionally
`authorizeLocal(state, transaction, principal)`, rather than calling the
current physical-update classifier on guessed effects. `principal` is a
host-established actor/key binding; preparing keys and checking that the
signing capability matches its public key happens outside the typing path.
In a secured document, an unavailable signing capability cannot produce a
local commit. Signing the resulting update still happens asynchronously.

Local authorization checks the complete logical transaction against the
current state: document mode, readiness of genesis/grants, signer/author
binding, granted kind and role, owner-only access changes, and the exact
proposal and settlement rules for adoption. Permissions come from the
pre-commit access header; a batch cannot grant itself permission to run.
Classifying targets follows the validated operation sequence, including
blocks created earlier in the same batch. The runtime owns the one log
append and preserves protocol-controlled identity and attribution.
Open documents retain DM-13's open-mode behavior, including the prohibition
on gaining an access header without forking to a secured document.

The primitive returns `allow`, `hold`, or `deny`, with a reason. Only
`allow` reaches mutation. A secured document awaiting genesis, or a job
whose actor lacks a locally known grant, yields `hold`; dispatch reports
`denied` with a retryable `not-ready` reason, without a log entry, mutation,
or automatic queued edit. A later explicit invocation can try again.
Absence of `access` must never make a secured document behave as open.
Genesis uses a dedicated bootstrap path with its asynchronous identity
verification completed before publication, outside ordinary commands.

Shared core policy helpers govern role, kind, access, and adoption checks
for both local and remote paths. Their inputs remain independently derived:
local checks classify validated logical operations; remote admission
decodes and inspects the **actual CRDT update before applying it**. Remote
checks of signatures, clock ranges, causal readiness, log contents, and
physical effects remain mandatory. An operation list supplied by a peer
cannot substitute for inspecting its update. Tests must establish policy
agreement for valid locally authored batches while still rejecting a
malicious update whose declared operations disguise different effects.

This is an implementation prerequisite, not a capability already supplied
by `Editor.apply()` or `applyCaptured()`. It does not promise immediate
remote admission: another peer may still await the causal base or grants,
and signing/delivery failures remain observable separately.

### P-5.2 Preparation and previews

Preparation must be cheap and side-effect-free apart from reserving fresh
IDs. It may run to preview an action, but execution always prepares again
against current state. No network, hashing the whole document, nested
dispatch, or arbitrary transaction-rewriting middleware in this path.
IDs allocated during a discarded preview or shortcut probe are inert:
they create no block, intent-log entry, awareness record, or externally
held reservation. A later execution may allocate different IDs; preview
IDs must not become durable references.

One Enter/split action, one paste insertion, or one block insertion with
slash-text removal is one batch. Remote transactions do **not** run local
commands again. Observers receive committed changes, not an opportunity
to veto or rewrite them. Undo is not implied by this command API; a future
history service must handle CRDT changes and provenance explicitly.

## P-6. Views are separate and incremental

Headless plugins must work in server tools and tests without a DOM. A
package can export a separate DOM bundle, importing its headless
definitions. Framework-specific adapters can wrap the same contracts.
No ProseMirror or Yjs object is required by the public plugin context.

```ts
export const calloutsDOM = defineDOMPlugin({
  id: "acme.callouts",
  forPlugin: callouts,
  views: [{
    type: callout.type,
    mount(ctx) {
      const element = document.createElement("aside");
      const text = ctx.mountText();
      element.append(text.element, ctx.children.element);
      return {
        element,
        update(block) {
          element.dataset.tone = block.fields.tone === "warning"
            ? "warning" : "info";
        },
        destroy() { text.destroy(); },
      };
    },
  }],
});
```

The surface invokes `update` with initial state before display, then when
the block's rendered inputs change. Instances are keyed by block ID and
survive moves and text changes. The surface owns the child container and
its ordering. A view may place it, but must not independently render or
discard its child instances.

`mountText()` binds to the current block and supplies the standard text
editing controller, including selection mapping and composition handling.
It subscribes to text deltas independently of the enclosing view's
`update`. Custom controls dispatch registered commands; they never mutate
the document directly. The first adapter can use the existing textarea
surface; a rich-text adapter must preserve the same nooq transaction path.

A view owns its subtree, not the editor root, remote cursors, or another
block's selection. The host restores logical selection across structural
updates and owns viewport anchoring. A faulty view is replaced by the
generic fallback for that block; the rest of the document keeps working.
Synchronous JavaScript cannot be forcibly interrupted in this trust model;
fault handling does not make an infinite loop safe.

Surface contributions also include slash items, toolbar actions, shortcuts,
and panels. Each action references a command or job, rather than embedding
another document mutation path. Panels can use read-only selectors over
tombstones and the intent log, allowing the suggestion plugin to provide
settled history without a special branch in the surface renderer.

The host supplies keyboard navigation and focus conventions. Plugin views
must expose accessible names and keyboard-complete actions. Accessible
stories and the EB-6/7 checks are part of built-in plugin conformance.

## P-7. Async work has a different lifetime

AI generation, import parsing, and export rendering run as registered
jobs. `editor.jobs.start(job, args)` returns a handle with `result`,
`cancel()`, and local progress subscriptions. Jobs receive an abort signal
and read/proposal services, not the synchronous command context.

Application configuration injects model providers into plugin factories:
`rewritePlugin({ generate })`. The document stores provider/model
provenance as appropriate, never credentials. Local and remote providers
implement the same contract; offline unavailability affects that job,
never editing or initialization.

### P-7.1 Host-bound identity

At editor construction, the host binds each publishing job registration
to one actor descriptor and signing capability. These bindings are separate
from plugin definitions and job arguments, fixed for that runtime, and
referenced through an opaque handle; plugin contexts do not expose keys.
Different identities require distinct host bindings/job registrations or
a newly configured runtime, not an `actor` or `signer` argument to `start()`.
A plugin manifest grants no document permissions.

The proposed host configuration makes the binding boundary explicit:

```ts
const editor = new Editor({
  docId,
  actor,
  plugins: [essentials, rewritePlugin({ generate })],
  jobBindings: [{ job: rewriteJob, actor: aiActor, signer: aiSigner }],
});

editor.jobs.start(rewriteJob, { blocks: [blockId] }); // data, not identity
```

`rewriteJob` is the registered job reference; `aiActor` and `aiSigner` are
host-owned configuration. Unknown/duplicate job bindings and incompatible
actor/key pairs fail configuration; a valid binding without a current
document grant is handled by the publication readiness check.

The public proposal service owns capture and publication. It supplies the
bound actor's full descriptor, including kind and plugin provenance, and
routes publication through P-5.1 immediately before commit. A binding is
configuration, not a cached authorization verdict: grants and readiness
are checked against current state on every publication. An ungranted AI
cannot publish by borrowing the writer's identity, even if job execution
itself was allowed to finish.

### P-7.2 Capture and evidence coverage

For a rewrite, the required sequence is:

1. Capture one immutable base snapshot **before** invoking the model.
   The capture service freezes the base synchronously, retains an opaque
   base handle, and computes digests asynchronously over that same base.
2. Declare the document data read by the job and derive its inputs from
   the captured view. Build resulting ops against that base's text and
   structure, never a later view or a cached snapshot from another job.
3. The service derives the mandatory operation dependencies, unions them
   with declared reads, and constructs evidence from the captured base.
   Dependencies discovered after generation still use the original base;
   callers cannot supply their own digest entries or omit required ones.
4. Publish an ordinary suggestion block with those exact ops, evidence,
   base root digest, bound actor descriptor, and captured display context.
   Publication does not replace the base with the current document.
5. Derive its current `fresh`/`stale`/`conflicted` status using DM-6. If a
   covered dependency changed during generation, that drift remains visible.

The captured view exposes declared live block data (`id`, `type`, `fields`,
`text`, and `children`), not an unrestricted `DocState`. A job declares
`readBlocks` and, when it consumes descendant content, `readSubtrees`.
Additional reads can expand that scope through the same base handle.
Undeclared external document reads violate the job contract; arbitrary
trusted JavaScript cannot be prevented from making them. Every supported
entry carries **both** content and structure digests, deduplicated by ID
and sorted. The service applies these minimum coverage rules:

| Dependency | Evidence from the captured base |
| --- | --- |
| Read an existing block's data | That block, including a source block that is never modified |
| Read a subtree's content | Every live block in that subtree; an ancestor's structure digest does not cover descendant text/fields |
| `textEdit` or `setField` | Every existing target, even if omitted from declared reads |
| Insert into an existing block's child list | The destination parent, pinning its child order/membership |
| Move or delete an existing subtree | Every live block in that subtree, its source parent, and the destination parent for a move |
| Refer to a block inserted earlier in the same batch | No invented base digest for the new ID; cover the earlier insertion's existing dependencies and validate the batch in order |

Reads of child order or membership require the containing block's evidence;
observing a child's data alone does not pin its placement. More complex
selectors must declare their whole read/traversal scope, including the
container whose membership may change. Merely covering the current query
results is insufficient to detect a new matching child.

**Representability is a publication check.** Current DM-6 evidence cannot
pin the document's root list, tombstone content, or header/log/attribution
data. `evaluate()` compares only listed block digests; it does not compare
`base.rootDigest`. Comparing that digest unconditionally would also fail:
publishing the suggestion itself changes the live root digest.

The first service therefore returns `unsupported-evidence`, without
publication, for root-order/membership-dependent reads, structural ops
that affect the root list, restore/tombstone-dependent proposals, access
changes, or any other dependency it cannot represent. It must not silently
drop a null parent or a block with no live digest from the coverage set.
Ordinary block-ID-targeted text/field rewrites remain supported even when
the target is a root; those operations do not depend on root placement.
Supported non-root structural batches use the table above. Generated
inserts use fresh IDs and empty child lists (P-4), with child insertions
expressed as subsequent operations.

General root/negative-existence/tombstone guards need a shared DM-6
extension and peer-convergence tests before the service supports them.
It must not hide new validation rules in plugin callbacks or
`Proposal.context`. This strengthens authoring through this service;
it does not redefine `evaluate()` for existing artifacts, prove another
author declared every semantic read, or introduce plugin-dependent remote
admission. A remotely enforceable completeness claim needs a protocol
contract as well. Normal synchronous commands and imports freshly prepared
against current state can still perform the full permitted DM-4 operations.

### P-7.3 Acceptance without a validation race

The document adapter maintains a local monotonic `revision`, advanced
synchronously for every authoritative state change, including local and
remote edits, access changes, and suggestion settlement. It is not a wire
clock and excludes awareness. Even lower-level document mutations must
advance it before plugin observers run; coalesced `onChange` notifications
are not a sufficient revision source.

Acceptance is bound to the exact proposal artifact the writer reviewed.
The runtime uses the following algorithm:

1. Capture an immutable snapshot and its revision in one synchronous
   operation. Check that the suggestion is live/unsettled and its payload
   still matches the reviewed artifact. A different payload requires review
   again; retries must not silently accept a replacement.
2. Asynchronously evaluate evidence against that snapshot. No lock blocks
   typing, sync, or other document changes while digests are computed.
3. Enter the runtime's non-reentrant commit section. Compare the current
   revision with the captured revision **synchronously**. If unequal,
   discard the evaluation and repeat from a new snapshot. A revision
   mismatch is not itself a `stale`/`conflicted` verdict.
4. If equal, check the evaluated status, current authorization (P-5.1),
   lifecycle/cancellation, and the complete adoption batch, then commit
   without yielding or invoking plugin callbacks between comparison and
   mutation. Only the original proposal ops plus protocol settlement ops
   are applied; DM-5/6 provenance remains intact.

V1 allows two automatic evaluation attempts per acceptance invocation.
If both lose the revision race, return a retryable
`changed-during-validation` failure with no mutation. Do not spin, hold
editing behind a lock, synchronously rehash the document, or accept an
old evaluation after retry exhaustion. This prevents duplicate acceptance
in one runtime and after an **observed** remote settlement. It cannot
serialize concurrent acceptances on disconnected peers; that needs a
shared DM-6 settlement rule, not a local revision counter.

Force acceptance is an explicit writer action against the reviewed
artifact and displayed drift, bound to the reviewed state revision. It can
bypass a stable non-fresh verdict, but never the revision comparison,
artifact/lifecycle checks, authorization, or core operation validation.
If that reviewed revision changes, return refreshed drift for review;
do not carry the force approval into an automatic retry. The existing
`acceptChecked` helper alone does not implement this algorithm; calling it
twice without a final synchronous revision comparison is still racy.

### P-7.4 Streaming and completion

Streaming tokens are ephemeral preview state in v1. The finalized proposal
is immutable; each retry publishes a new artifact. Durable collaborative
streaming needs its own contract rather than repeatedly changing the
evidence or ops of an already published proposal.

Import jobs return data for a new synchronous import command, or publish
a proposal against a captured base. Export jobs consume immutable
snapshots. A stale async result must never blindly apply stored numeric
text offsets through a normal command. A job's completion may not steal
focus from writing that happened while it ran.

Cancellation and editor disposal invalidate the job's publication token;
the runtime discards late results even if the provider ignores abort.
Publication already committed before cancellation remains a document
transaction. External side effects require the provider's own cancellation
semantics.

## P-8. Lifetime, events, and failures

`setup(ctx)` is synchronous and optional. Its scope offers read selectors,
change subscriptions, local state, cleanup registration, and an abort
signal. Setup must register work, not perform expensive initialization.
Jobs and views have narrower child scopes. Closing the editor aborts jobs
and disposes subscriptions/resources in reverse dependency order; cleanup
runs once, including after partial setup failure.

Change events identify local versus remote changes, changed block IDs,
field/text/structure changes, and transaction identity when available.
Awareness uses a separate subscription channel. Consumers subscribe to the
smallest relevant selection of state; no mandatory whole-document render
or digest pass per keystroke.

Observers update derived local state. Automatically writing a durable
"repair" transaction in response to every remote edit is outside this
contract: it can cause feedback loops and peer-dependent outcomes.
Document changes remain explicit commands, jobs with guarded publication,
or protocol-defined behavior.

Configuration errors fail construction with the plugin and slot named.
Setup failure rolls back runtime resources, never document content.
Command errors return failure; job errors reject that job; observer errors
are reported without preventing other observers from running. The host's
error channel identifies plugin, phase, and cause. Silent catches are not
the API.

There is no plugin `apply`, `filter`, or `normalize` hook around remote
updates. The public lower-level transaction API remains usable for tools
and adapters, with its existing protocol obligations; it is not a way to
register alternate document semantics.

## P-9. Evolution and export

Do not add `migrate(block) => block` as an automatic write hook. DM-7
requires monotone, idempotent, order-independent migration, but the current
operation set has no identity-preserving type-change operation. A general
type migration also needs concurrency semantics for edits from older peers.
That needs a separate protocol proposal and convergence tests.

For v1, a plugin may register multiple exact stored versions and render
older content through a read-only compatibility projection. Canonical
digests and proposal evidence always use the stored protocol state, never
that display projection. Opening a document cannot rewrite its version,
identity, text, attribution, or fields. An incompatible old block can remain
read-only until an explicit migration protocol exists.

Native document export must preserve unknown data. Format-specific export
contributions will map blocks to a shared export representation; they may
not treat DOM serialization as the document source. When a target format
cannot represent a block, report a loss with its block ID and emit a
visible fallback. The initial registry does not promise a complete PDF,
DOCX, or HTML codec API before the first exporter establishes its needs.

## P-10. Implementation sequence and proof

The current editor exposes `ydoc`, accepts externally assembled
transactions, returns whole projections, and broadcasts unfiltered
`onChange` notifications. `dom.ts` hardcodes text kinds, menu entries, and
the simulated AI rewrite. This proposal defines the next public boundary;
it does not claim these abstractions already exist.

1. **Registry and commands.** Add the headless definitions/runtime; expose
   atomic command dispatch over the current transaction adapter. Keep
   `@nooq/core` free of DOM and plugin dependencies. Bind actor metadata
   and implement P-5.1 local authorization before commit, sharing policy
   helpers with remote admission while retaining physical-update checks.
   Add the synchronous adapter revision required by P-7.3. Incremental
   reads/change sets must avoid whole-document work on the typing path.
2. **Views and built-ins.** Extract paragraph, heading, quote, and suggestion
   presentation, menu actions, and settled history into ordinary plugins.
   Move text editing and selection maintenance into the public surface
   binding. Keep shared suggestion semantics in core. Add the generic
   fallback and an out-of-tree-style callout using public exports only.
3. **Jobs and proposal capture.** Extract the simulated rewrite as a
   provider-backed plugin. Add base-handle capture, mandatory evidence
   closure, explicit unsupported-dependency results, cancellation, and
   revision-checked acceptance. Remove the single special-purpose `aiKey`
   slot in favor of identities bound at job registration by the host.
4. **Further contracts from working features.** Add the first exporter,
   richer inline semantics, shared evidence guards for currently
   unrepresentable dependencies, concurrent suggestion settlement,
   migrations, history, and additional surface adapters with focused
   proposals as needed.

Tests that justify calling the first slice complete:

- A third-party callout inserts, edits, moves, syncs, and restores using
  only public exports. It also works in a headless editor.
- A peer without the plugin retains the same state and root digest;
  a fallback renders its content and children without rewriting them.
- Explicit replacement changes a built-in view/command; accidental
  conflicts, missing dependencies, cycles, and incompatible API versions
  fail clearly. Two editor instances share no mutable plugin state.
- A multi-op command either commits once or leaves no effects; rejected
  local authorization never produces an optimistic unauthorized edit.
- Missing genesis/grants yield a retryable local refusal without mutation;
  wrong keys/kinds, role overreach, and invalid adoptions are denied.
  Valid logical batches and their encoded updates agree on shared policy;
  a malicious physical update cannot pass by declaring harmless ops.
- Job arguments cannot switch the registered actor/signer. Publication
  rechecks current access even after a long-running job. Discarded preview
  IDs leave no document, log, awareness, or durable-reference effects.
- Remote edits do not replay commands or depend on plugin diagnostics.
  Unknown mark/type/field data survives native round trips.
- Diagnostics run only for requested blocks and cache invalidation follows
  block revisions; typing in an unrelated block causes no diagnostic sweep.
- A slow rewrite based on A completing after an edit to B is stale or
  conflicted, never spuriously fresh. Source-only reads, omitted targets,
  descendant content, and child-order/membership changes are covered using
  the original base, including dependencies discovered after generation.
- Root-order-dependent reads/ops and tombstone/header dependencies return
  `unsupported-evidence`; a supported ID-targeted rewrite does not acquire
  an unconditional root-digest comparison. Newly inserted IDs have no
  fabricated base evidence.
- An edit between evaluation and commit causes a retry; sustained revision
  changes exhaust the bounded retry with no mutation. Payload replacement,
  local double acceptance, observed remote settlement, and force-accept
  races are covered; a new revision invalidates the previous force approval.
  Cancellation/disposal prevents late publication and acceptance.
- View/observer/job failures are contained and reported; resource cleanup
  is exact. Reused text nodes preserve selection and composition.
- Existing compiler, document/sync/editor tests, accessible stories, and
  experience-budget gates run against the actual implementation.

The first implementation should prove a custom callout, a replaced
paragraph view, and a replaceable rewrite provider. Those exercise the
boundaries before growing the seed catalog in P-11.

## P-11. The ten seed plugins

The seed set supplies a useful writing workflow and tests the public
extension boundaries. Each entry is one independently usable feature
plugin that may contribute multiple related block types, commands, jobs,
and a separate DOM bundle. These are proposed deliverables, not existing
packages or a claim that the API already supports every requirement.

### P-11.1 Catalog and API gaps

The table is in **build order**, after the platform prerequisites in
P-10's first implementation step (the registry/command work). Gaps
must be resolved through public APIs; built-ins get no private escape hatch.

| Order | Seed plugin | First useful version | API gaps to resolve before that slice ships |
| --- | --- | --- | --- |
| 1 | **Writing basics** | Paragraphs, headings, quotes; bold, italic, inline code; atomic split/merge. | Complete the `mountText()` contract for range selection, composition, mark rendering/toggling, and per-block keyboard behavior. Define split/merge commands and post-commit selection. Use existing string marks; identity-preserving conversion between stored block types needs a separate protocol decision. |
| 2 | **Callouts** | Notes, warnings, and tips with configurable icons and colors. | Finalize slash/toolbar contribution shapes and how view controls dispatch typed commands. Expose field updates and theme tokens through public interfaces. This should require only the base contracts, proving an outside author can build a complete block without new core semantics. |
| 3 | **Suggestions & review** | Proposal cards, diffs, accept/reject, provenance, and settled history, independently of AI. | Define the public review service and the token identifying the artifact/state the writer reviewed. Implement P-5.1 authorization and P-7.3 acceptance. Add incremental selectors for proposals, settlements, and history. Global concurrent settlement remains a shared DM-6 gap, not something a card renderer can solve. |
| 4 | **AI writing** | Rewrite, shorten, expand, or change tone for selected blocks, publishing proposals. | Specify a provider-neutral generation request/result contract, output validation, progress, cancellation, and unavailable-provider results. Implement host job bindings and captured reads/operation evidence in P-7. Start with block-ID-targeted text/field edits; broader restructuring must wait for representable guards. |
| 5 | **Document export** | HTML and PDF for the initial blocks; DOCX and ODT follow through the same export model. | Define the shared export representation, per-block contribution registry, format encoder interface, and structured loss reports. Specify snapshot ownership, fonts/assets, pagination, and cancellation. Generate from document snapshots, never by serializing the editing surface. |
| 6 | **Columns & layout** | Two- and three-column layouts, resizing, and responsive stacking. | Finish nested child-view mounting, block-placement commands, keyboard resizing, and local resize previews followed by field commits. Specify deterministic display of concurrent width/child changes and unexpected children. Responsive stacking changes presentation, not stored order; no plugin repair writes after merge. |
| 7 | **Lists & tasks** | Bullets, numbering, checkboxes, nesting, and indent/outdent. | Define the list/item block representation and atomic outline commands, including caret movement across nesting boundaries. Derive numbering from the tree and define tolerant rendering after concurrent moves. Distinguish local creation constraints from shared tree invariants; unsupported merged shapes cannot trigger remote rejection. |
| 8 | **Code blocks** | Language selection, syntax highlighting, literal tabs/newlines, and copy. | Add public text-binding policies and transient decoration support. Highlighting results must identify their source block revision and be discarded or remapped when obsolete. Tokens remain derived presentation, never stored formatting marks; clipboard actions need a host/surface capability. |
| 9 | **Media & attachments** | Images, captions, alt text, and downloadable files available offline. | Define an asset-provider contract for staging, persistent references, local reads, availability, cancellation, and export resolution. Resolve peer transfer, missing-asset UI, and retention of assets referenced by tombstones/history. A URL field alone is insufficient; any asset-transfer wire change requires its own shared contract. |
| 10 | **Tables** | Editable cells and headers; insert/delete rows and columns; keyboard cell navigation. | Specify stable row, column, and cell identities, their mapping to the block tree, and grid selection. Define atomic commands and deterministic projection for concurrent row/column changes, missing cells, and conflicting cell placement. Agree on the export table shape. Formulas and merged cells are later work. |

### P-11.2 Build milestones

The sequence is a dependency and validation order, not a requirement to
finish every future feature of one plugin before starting the next.

1. **Platform gate.** Complete P-10's registry/command foundation,
   authorization, revision tracking, generic fallback, scoped cleanup, and
   the minimum surface binding. These are framework capabilities, not an
   eleventh seed plugin.
2. **Authoring proof — Writing basics, then Callouts.** Extract the existing
   text blocks and ship the custom callout through public exports. Prove
   explicit replacement of a paragraph view, keyboard editing, headless
   commands, and preservation by a peer without the plugin.
3. **Proposal workflow — Review, then AI writing.** First review a proposal
   from a non-AI caller. Then plug in a deterministic generation provider
   and a second conforming provider to prove interchangeability. Gate the
   slice on evidence coverage, drift, identity binding, and cancellation.
4. **Portable output — Export.** Establish the export representation while
   the block catalog is small; ship HTML, then PDF. Start DOCX/ODT encoders
   from that shared representation as it stabilizes, without waiting for
   all ten plugins. Define whether review artifacts are included, omitted
   with a report, or rendered as annotations for each output mode.
5. **Structured documents — Columns, then Lists & tasks.** Keep layout early
   in line with the founding roadmap. Add nested-layout and outline
   fixtures and extend the export mappings in the same milestones.
6. **Specialized content — Code, then Media, then Tables.** Exercise derived
   decorations, asset lifetime, and finally grid concurrency. Asset and
   table contracts can be designed earlier; their implementations must
   satisfy the prerequisites above before release.

Thus the first complete vertical slice is **Writing basics → Callouts →
Review → AI writing → HTML/PDF export**, followed immediately by Columns.
Later plugins extend an already working write/review/export workflow.

### P-11.3 Which gaps belong in which layer

Selection, text bindings, decorations, menus, grid navigation, and view
composition belong to the public surface contract. Commands, selectors,
job bindings, asset access, and export dispatch belong to the framework's
runtime/service contracts. A seed plugin should be the concrete consumer
that proves each new interface before it becomes a general abstraction.

Stored block-type conversion, currently unrepresentable proposal evidence,
and concurrent suggestion settlement require document-protocol decisions
and convergence tests (P-7.2, P-7.3, P-9). Asset replication needs an
explicit transport contract if it extends sync. Table concurrency must
first be tested against existing DM-3/4 operations: if the chosen behavior
needs stronger shared invariants, amend the protocol before promising it.
None of these gaps can be closed by a built-in-only mutation hook.

Review remains independent of AI: humans, importers, and other automation
can produce proposals using the same services. AI unavailability affects
generation, not review or ordinary writing. Initial AI scope also does
not restrict the full set of permitted synchronous document commands.

### P-11.4 Composition and shared release criteria

An `essentials` preset composes the selected seed plugins and their optional
surface bundles. It is configuration, not a privileged plugin. The host
explicitly supplies providers, job identities, asset services, and export
backends; optional features are selected before registry compilation so
the preset creates neither dangling contribution references nor implicit
actors/credentials. Every seed remains independently selectable and
replaceable, subject to declared dependencies.

Each seed ships with:

- A public-API example and keyboard-complete, accessible interactions;
  stored-content plugins also demonstrate a headless command path.
- Offline behavior with locally available inputs. A missing model or
  asset has a visible, scoped unavailable state and never blocks writing.
- Collaboration fixtures appropriate to its content, preservation of
  unknown data, and a usable fallback when another peer lacks the plugin.
- A mapping into the shared export representation and tests for the
  formats released so far. A format limitation produces a block-addressed
  loss report and the declared fallback, never silent content loss.
- Lifecycle, cancellation, and failure tests for its contributed services,
  plus the applicable accessibility and experience-budget checks.

Writing basics and Callouts define their portable content mapping as part
of their initial design; the first Export milestone turns those mappings
into executable format tests. Every later stored-content plugin adds its
mapping and tests when it lands. Review, AI, and other service contributions
must also specify the export treatment of the artifacts they produce.

## P-12. Plugin authoring agent pilot

The experimental [Pi agent](../packages/plugin-agent/README.md) now exercises
one bounded archetype: inline-text blocks with fields, pure diagnostics,
and synchronous target-field commands. Its small
[`@nooq/plugins`](../packages/plugins/README.md) authoring package implements
definitions and immutable command preparation. It does not implement the
full composition/runtime contract or install plugins in the editor.

A human-owned brief defines behavior and acceptance cases. A deterministic
scaffold and pinned implemented API context reduce model guesswork. The
model can replace its one source file, run protected checks, and report an
API gap. Pi runs a local model through an OpenAI-compatible loopback endpoint;
generated nooq plugins are never Pi extensions. Candidate execution happens
in a separate macOS sandbox, with bounded repair rounds and preserved source
revisions. Reports include source/API/brief hashes, model usage, test results,
API gaps, and remaining review gates. The agent never edits its oracle or
automatically installs, merges, or publishes a candidate.

The pilot covers core/Yjs agreement, concurrent text edits from a peer without
the plugin, preservation of unknown fields/marks/children, and native JSON
roundtrip. Its static generic preview is not an interactive renderer. A green
pilot report does not satisfy the seed release criteria: authorized editor
dispatch, DOM and accessibility/caret checks, and actual format exports remain
separate required work. The existing evidence-coverage restrictions also
remain; this synchronous pilot does not introduce AI proposal jobs.

Extend the supported archetypes only after their API gaps are resolved. First
measure acceptance and repair cost across varied briefs on exact local model
versions; then add a job queue and parallel workers. Seed build order in P-11
is unchanged: the Callout authoring trial is not a release of the second seed.
