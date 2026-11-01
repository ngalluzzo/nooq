# Proposal 0004: plugin authoring v2

Status: slices 1–4 and compatible leaf-block merging implemented; subtree restructuring, native IME acceptance, and performance gates remain open. Additive to plugin API version 1.
Date: 2026-10-31.

## Decision

Make common plugins concise to author, compose, and verify. Preserve the
headless command boundary, host authorization, captured job evidence, and
unknown-content preservation established in proposal 0002. Continue to ship
developer-bundled plugins. Runtime installation and isolation are separate work.

Package versions, SDK/API versions, and stored block versions are independent.
This slice needs no breaking `apiVersion: 2` or stored-content migration. Existing
`defineBlock`, `defineCommand`, and textarea views remain supported.

## Comparisons informing the design

| System | Useful pattern | nooq decision |
| --- | --- | --- |
| [Tiptap](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/extension) | Configured extensions, commands, input/paste rules, shortcuts | Route editing contributions through the existing authorized command path. |
| [BlockNote](https://www.blocknotejs.org/docs/features/custom-schemas/custom-blocks) | Property schemas, content modes, custom block views and portable HTML | Derive common authoring behavior from typed fields; give arbitrary blocks host-owned text. |
| [Lexical](https://lexical.dev/docs/extensions/intro) | Framework-independent dependency composition and shared outputs | Add typed configuration and service contracts when the next seed consumers establish their requirements. |
| [Obsidian](https://docs.obsidian.md/plugins/guides/lifecycle-management) | Resources scoped to plugin lifetime | Text views, event listeners, and composition work belong to the host's disposal scope. |
| [Gutenberg](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-deprecation/) | Historical compatibility fixtures | Preserve old content and test explicit compatibility; concurrent migrations need a protocol proposal. |
| [VS Code](https://code.visualstudio.com/api/references/contribution-points) | Declarative actions, placements, visibility and enablement | Build consistent action discovery across surfaces after the first recipe proves the authoring boundary. |

## Slice 1: declarative Callouts and rich text

`defineBlockSchema` accepts a stored type, label, text mode, fields, optional
initial text, and optional additional diagnostics. `field.enum`, `field.string`,
`field.number`, and `field.boolean` describe supported values and creation
defaults. `FieldValues` and field commands infer values from these definitions.

The helper returns an ordinary `BlockDefinition`. Defaults produce fresh data
only at creation. Diagnostics report missing or unfamiliar values; they do not
rewrite them. These authoring schemas do not impose new remote admission rules.
Other trusted custom commands still have the ordinary operation API.

`insertBlockCommand`, `cycleFieldCommand`, and `setFieldCommand` return ordinary
commands. They validate arguments, check target liveness and exact type, and
produce operation batches for the host to authorize and commit. Insertion
allocates a fresh identity, checks placement, and optionally consumes exactly a
current slash in the same transaction. Cycling invalid stored enum data declines;
an explicit valid set action can repair that field without touching other data.

`insertAfterSelection` centralizes the slash-menu placement argument factory.
This is the first reusable action helper, not a complete toolbar/palette system.

### Rich-text surface

`BlockViewContext.mountRichText({ label, marks })` returns a labelled host-owned
contenteditable element and engine-independent selection, focus, mark-toggle,
and disposal operations. Supported marks are `strong`, `em`, and `code`.
The default Enter behavior is a literal newline; registered host key actions
take precedence. Paste currently inserts plain text. Children retain their
separate host-owned slot.

The binding uses ProseMirror and shares the mark-aware splice diff with the
experimental full-document surface. Offsets and mark arrays are UTF-16, matching
the core operation contract. Unfamiliar stored marks remain opaque in the
projection and survive supported formatting operations.

All text mutations use the selected `nooq.text.edit` command when present,
otherwise the existing authorized host text service. Failed, declined, deleted,
or disposed targets cannot leave optimistic durable edits. The binding restores
the admitted projection after denial. Remote updates map selection through
splices; native selection is captured before an asynchronous observer can lag
behind an incoming patch or a formatting action. Composition defers presentation
updates and maps local splices onto the latest admitted text.

This is a block-scoped binding. It does not yet unify all custom block views into
one document-wide ProseMirror view, promise cross-block native selection in the
plugin surface, add collaborative undo, or implement general import/export.
Native IME and performance gates remain distinct from simulated browser checks.

`calloutsDOM` uses rich text. `calloutsPlainDOM` retains the textarea presentation
for existing applications and compatibility tests. The stored type remains
`nooq.callout/v1`; the feature manifest advances to 1.1.0.

### Agent and evidence

The new `callout-rich.json` brief requires contenteditable and a RichFormatting
story. A `recipes` tool section documents the public helpers. Scaffold and
Storybook guidance distinguish rich text assertions from textarea values.

Protected checks assert the requested text mode, native keyboard formatting of
an emoji, opaque-mark preservation, peer convergence, selection stability,
composition-event rebasing, slash insertion, disposal, and Storybook play/axe in
both themes. Legacy textarea checks remain. A textarea candidate cannot satisfy
a rich-text brief, even if its own stories pass.

The SDK fingerprint includes the rich-text implementation and the shared PM
diff. Revision IDs are captured before asynchronous writes and disk writes are
serialized so the saved evidence cannot overwrite an earlier revision under the
same index. The final package is independently checked after generation.

## Slice 2: shared actions and host toolbars

`defineAction` names one command or job, an argument factory, optional `slash`
and `toolbar` placements, keyboard shortcuts, a visibility predicate, and an
availability predicate returning `true` or a disabled reason. Typed targets infer
the argument shape. Definitions and placement arrays are copied and frozen.
`DOMPlugin.actions` registers them; duplicate IDs and ambiguous shortcuts fail
at surface creation, with explicit `keyOrder` resolving shortcut precedence.

The public `surface.actions` service lists metadata/availability and executes by
ID for a block. A view receives a lifetime-bound `ctx.actions` service and
`ctx.mountActionToolbar`. Host toolbars retain stable buttons, update on document
and selection changes, provide keyboard navigation and accessible disabled
reasons, and preserve selection during pointer activation. The slash menu uses
the same availability and execution path, including while it is already open.

Listing never prepares a command or allocates an identity. Availability is
advisory and predicates are synchronous/read-only. Invocation rechecks block
liveness and availability, builds current arguments, and uses the selected
command or job runtime. Authorization still occurs there. Hidden/disabled
actions, disposed views, and deleted targets cannot invoke stale actions.
Invalid predicates fail closed and report errors. Job results include the
host-owned cancellation handle.

Callouts now consumes shared insertion/tone actions and a host toolbar; its
Ctrl+Shift+Y shortcut uses the same tone action. Invalid stored tones remain
unchanged and explain why cycling is disabled. Legacy menus, keys, textarea
views, and manual controls remain compatible. The existing generated artifacts
remain unchanged as historical evidence; the current agent fixture consumes the
updated public Callouts package through its independent checks. The agent's
contract includes the new action types and host implementation.

This slice does not add a built-in palette, asynchronous availability, provider
state subscriptions, generalized formatting actions, or document-wide selection.
It completes the shared-action portion of the writing milestone. The next
surface slice must address text policies and composition across blocks, including
the browser experience budgets described below.

## Slice 3: text policies and application presentation

`defineTextPolicy` declares a view's default plain/rich presentation, supported
formatting actions, and Enter behavior. `ctx.mountTextEditor` mounts host-owned
text; the application's `textMode` option overrides presentation without rewriting
stored content. Explicit legacy bindings retain their fixed presentation.

Writing Basics dispatches the registered split command on Enter; Callouts keeps
literal newlines. Shift+Enter and cancelable beforeinput line-break events use the
same authorized command boundary. Pending remote text maps the native range
before dispatch. Declined splits cannot become a different edit, and rejected
replacements restore the original directional selection. Existing/unknown marks,
fields, children, and identity remain preserved. Generic fallback content follows
the presentation preference and has a readable single-column layout.

The agent contract and complete-package fixtures exercise the policy/binding pair
in both modes. The implementation landed in `a61b282` and `1a4a7f5`; this checkpoint
completes the agent guidance, documentation, and browser evidence. Shared actions
is now `d000901` in the reconciled history.

The earlier integrated slice passed 525 repository tests, 156 Storybook checks,
typechecking, a static build, and native keyboard checks in both modes.
[Historical browser evidence](evidence/0004-text-policy-browser-budgets.json)
records the exact measured source hashes: rich EB-5 passed five samples with
visible-to-editable p95 1 ms. Rich small/idle EB-6 retained all expected characters
and focus but failed the budget (50.8 ms p95 versus 16.7 ms, maximum 69.5 ms versus
50 ms). Zero font requests means font-delay behavior was not exercised. These
measurements predate the subsequent editor performance work; they are not a
benchmark of the current checkout. Large/storm, selection-fuzz, and native IME
gates remain open.

The next slice is document-wide selection that preserves arbitrary plugin blocks,
children, opaque marks, and the selected command boundary. The private
full-document ProseMirror experiment does not yet meet that contract.

## Slice 4: document-wide text selection

An opt-in `selectionMode: "document"` surface with `textMode: "rich"` coordinates
native selection across the existing plugin text bindings. It preserves custom
views and child slots instead of converting them into the private experiment's
fixed block schema. The public `surface.selection` service uses directional
block-ID/UTF-16 endpoints and supports read/set/clear, text extraction, replacement,
and mark toggles. Default block-mode behavior remains unchanged.

The native interaction path supports mouse dragging, horizontal Shift extension,
document-edge extension, select-all, and plain-text clipboard operations. Clipboard
text excludes plugin chrome. Mixed and nested Writing Basics, Callouts, and
unfamiliar fallback blocks are covered. Textarea bindings and incompatible DOM
ordering are barriers. Selected text can be replaced or cleared atomically;
blocks, fields, types, and children remain, even when their text becomes empty.
Cross-range Enter inserts a literal newline. Structural merging/deletion needs
separate block compatibility rules and is deliberately not inferred here.

`editor.commands.batch(command, inputs)` prepares one selected command repeatedly
against one immutable snapshot and commits one authorized operation batch. A
later declined, invalid, or throwing preparation prevents all writes; it cannot
partially clear a range. The selected `nooq.text.edit` override and plugin identity
are retained. Formatting requires support throughout the span and preserves opaque
marks. A regression test also corrects the Yjs adapter: explicit plain insertion
must not inherit adjacent marks, matching core text semantics.

Both endpoints map through admitted text updates before execution. A structural
change to span membership cancels selection instead of expanding it to unintended
content. Denied edits retain the directional range. Disposal, legacy barriers,
and focus moving outside the surface prevent stale mutations. Selection stays
local, with no new stored schema or migration.

Storybook covers replacement, formatting, denial, real remote delivery, and clean
copy in both themes. `bun run --cwd packages/design test:selection-browser` builds
Storybook and independently drives real Chromium mouse drags and clipboard/key
shortcuts; it asserts preserved block IDs, nested content, and no page errors.
Unit tests cover atomicity, authorization, UTF-16/opaque marks, stale ranges,
remote mapping, disposal, and peer convergence. Native cross-range IME, touch
handles, vertical/word extension, rich clipboard, drag/drop editing, undo, and
performance qualification remain open. No new model-generation run is claimed.

The text-policy checkpoint is committed as `2376988`; this selection slice is the
next reviewable increment. Its native tests do not supersede the historical
performance failures recorded above.

Integrated verification: 540 repository tests passed (eight opt-in lab tests
skipped), 168 Storybook checks passed across both themes, and typechecking and
the static build passed. The independent native gate passed in Chromium
156.0.8078.4 with no page errors. CI now runs both the Storybook and native gates;
the workflow itself has not been run remotely as part of this local verification.

## Slice 4b: compatible structural merging

Document mode now joins compatible ranges during replacement, cut/paste, and
Backspace/Delete; a collapsed boundary joins neighboring text blocks. The first
block in document order survives with its type, fields, prefix, replacement text,
and marked suffix. Other participating blocks become ordinary tombstones without
rewriting their retained content. The caret lands between replacement and suffix.

Compatibility is explicit and headless: `textMerge: "same-type"` on a registered
block definition, identical types and fields, consecutive siblings under one
parent, and no children on any participant. Writing Basics opts in. Nested leaf
siblings work; cross-parent spans, containers, custom opt-out types, differing
fields, and intervening non-text blocks cannot merge. Ordinary mixed replacement
continues to preserve structure; explicit `surface.selection.merge()` declines
at these barriers. Boundary deletion never falls through to an empty-block
shortcut that could remove children.

The selected `nooq.text.merge` prepares the selected text edit for the survivor
and selected deletes for absorbed blocks, then commits once. A later declined,
throwing, or mismatched preparation prevents all writes. The standard recipe
accepts exactly its planned operations; transforming overrides need a compatible
merge override. Failed compatible merges do not fall back to text-only editing.
The standard merge owns the final caret; the surface honors an override's final
selection.

The small composition prerequisite is `ctx.prepare(command, args)`, sharing one
immutable snapshot with no dispatch or partial commits. Child contexts carry the
selected child provider's identity; the final transaction retains the outer
provider identity and passes normal authorization. Recursive preparation, async
results, and escaped preparation contexts are rejected. `ctx.blockDefinition`
exposes the selected headless policy. There is no change to the persisted schema,
wire format, or plugin API version.

Tests cover forward/backward marked ranges, empty boundaries, nested siblings,
barriers, selected provider refusals and transformations, signed reader denial,
remote endpoint mapping, and peer convergence. Storybook exercises the editing
flows in both themes, and the independent native Chromium gate covers real drag,
clipboard, boundary deletion, and typing after a join. Subtree joins/reparenting,
cross-type conversion, undo, native cross-range IME, and performance acceptance
remain open. Unseen concurrent edits to an absorbed block follow existing CRDT
and tombstone semantics; this slice does not relocate them automatically.

Verification for slice 4b: a stable checkout passed 550 repository tests (eight
opt-in lab skips), 180 Storybook checks across both themes, typechecking, and the
native Chromium gate with no page errors. Native multiline paste followed by
typing also exposed a rich-text parsing bug; the text schema now preserves literal
whitespace so a subsequent native edit cannot normalize a newline into a space.
The shared working tree passed the 39 relevant plugin/selection tests and
typechecking after integration. No performance or cross-range IME qualification
is claimed by these results.

## Subsequent slices and acceptance criteria

1. **Writing basics and Callouts:** finish public surface composition, selectable
   text policies, shared actions, and document-wide selection. Prove compatibility
   and actual browser experience budgets before expanding the catalog.
2. **Review and AI writing:** typed provider/configuration contracts, scoped
   incremental subscriptions, unavailable states, and reusable job UI. Preserve
   identity bindings and original-base evidence. Broader evidence and concurrent
   settlement require separate protocol work.
3. **Export:** a snapshot-owned shared content representation, per-block mappings,
   encoders, assets, cancellation, and block-addressed loss reporting. Start with
   HTML/PDF and historical fixtures while the catalog is small.
4. **Columns and lists:** child slots, structural editing, deterministic tolerant
   projections after concurrent moves, and matching export mappings.
5. **Code, media, tables:** decorations, asset lifetime/transfer, then grid identity
   and concurrency. Each capability needs a concrete seed consumer and conformance
   tests before it becomes a generalized public service.

Extract shared testing/preview helpers into a public testing package when the
second plugin archetype needs them. Keep author-generated stories independent
from host-owned acceptance checks. Track source size, repair rounds, elapsed
time, and check results across distinct archetypes; one successful Callouts run
does not establish a general plugin-generation success rate.

## Verification

The integrated proof is [generated rich Callouts](../packages/plugin-agent/examples/callouts-rich/README.md).
Its source is unchanged from the successful oMLX run. The original report and a
separate current-contract host verification record preserve both fingerprints.
Repository checks passed 490 tests (seven opt-in performance tests skipped),
typechecking, 130 Storybook tests, and a static Storybook build. Three consecutive
browser runs of the generated package passed after making selection setup
independent of platform-specific Home-key behavior.

Slice 1 is committed as `a2a3159`. Slice 2 passed the full 502-test suite in its
isolated checkout, then the relevant 394-test suite after integration with the
other editor changes (seven opt-in performance tests skipped in each). The
integrated tree passes typechecking, 142 Storybook tests across both themes,
and the static Storybook build. Native Chromium keyboard/pointer checks confirm
the shared shortcut, selection retention on toolbar clicks, and subsequent
rich-text formatting, with no page errors. The agent's five complete-package
tests include independent runtime/browser/Storybook gates and negative cases.

The new tests cover fresh arguments and selection, non-mutating discovery,
hidden/disabled/invalid predicates, open-menu updates, shortcut collisions,
deletion/disposal, cancellable jobs, and secured authorization denial. These
checks do not establish performance budgets or native IME compatibility. Slice 2
was implemented and validated by the host; the earlier oMLX artifacts are not
presented as a new generation run.

Run repository typechecking and tests, normal host Storybook, and the independent
rich Callouts validator. Focused tests cover recipe semantics, preservation,
authorization/decline behavior, lifecycle, UTF-16 offsets, selection races,
legacy compatibility, and real Chromium interactions. Record the generated
package's exact source hash, SDK fingerprint, model usage, and remaining gates.
