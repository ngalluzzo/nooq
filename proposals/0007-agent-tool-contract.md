# Proposal 0007: the agent tool contract

**Status: DRAFT — not yet opened. Drafted: 2026-11-01. Decision of record:
none yet.** Covers DOCUMENT-MODEL Draft 1.10 (DM-6.7, root-list
evidence), a new plugin API section (P-13, extending proposals/0002 P-7),
and one new package. The DM text below lands in DOCUMENT-MODEL.md when
the proposal opens. A new module is a significant change under
GOVERNANCE, so this needs an issue open for at least 7 days.

PHILOSOPHY §6 says nooq defines "the tools, transactions, and provenance
schema an intelligent actor uses." The tools are the missing part.

## Problem

Jobs (P-7) cover AI work that nooq starts. Nothing covers an agent that
calls nooq: one that reads, decides, reads again and then edits, across
many turns.

| Finding | Evidence |
| --- | --- |
| §6 names a contract with no callable surface. | No tool definitions in `packages/`. Legacy `Editor.propose` takes raw ops and evidence IDs. |
| A capture lives for one job run. An agent's reads and its edit are separate calls. | `JobContext.capture()`, `packages/plugins/src/jobs.ts` |
| An agent driving the surface types as the writer, so AI text lands as human text. | PHILOSOPHY §5, "Broken when" |
| DM-4.3 edits are UTF-16 splices. Models miscount offsets. | DM-4.3 |
| Edits to the root list can't be pinned by evidence. In a flat document, an agent can't add or delete a top-level paragraph. | `ProposalCapture.proposal` throws on `cover(null)` |

## Change

### 1. Root-list evidence (DM-6.7)

Ops place blocks by numeric index (DM-4.1, DM-4.4), so a root-level edit
depends on the roots before its position. DM-6 has no way to pin them.

**DM-6.7 Root-list evidence.** A proposal's `evidence` MAY contain one
root entry:

```json
{ "roots": 12, "rootsDigest": "sha256:…" }
```

- `rootsDigest` is the fingerprint (DM-2) over exactly
  `{roots: [<the first n live root IDs of the base, in order>]}`, where
  `n` is `roots`. Suggestion blocks count, because indexes count them.
- `n` is the length of the shortest prefix of the base's live roots that
  contains every base root which precedes, in the batch's working state,
  a root position the batch writes to, and every root the batch moves or
  deletes.
- `evaluate` compares the first `n` current live roots against
  `rootsDigest`. Fewer than `n` live roots, or a different digest, is
  drift with reason `roots`, and the proposal is `conflicted` (DM-6.2).
- Publication MUST append the suggestion block to the end of the root
  list, so publishing never disturbs its own prefix.

Only a prefix is pinned, so a root added below an agent's insertion point
leaves the suggestion `fresh`. Settling an older suggestion inside
the prefix conflicts a newer one, which is correct: its indexes are now
off by one. Deleting a late root pins every root before it. That is
coarse, and it joins DM-10.4.

P-7.2 lifts its `unsupported-evidence` rule for root-list inserts, moves
and deletes. Restore, tombstone dependencies and access changes stay
unsupported.

### 2. Agent sessions (P-13)

An **agent session** is a publishing job that the agent drives. It uses
P-7 unchanged for identity, capture, evidence, authorization and
publication. It adds bases that outlive a call, agent-friendly edits,
tool schemas and limits.

```ts
const editor = new Editor({
  docId, actor, plugins,
  agentBindings: [{ name: "assistant", actor: agentActor, signer: agentSigner,
                    limits: { unsettled: 20, opsPerProposal: 200 } }],
});
const tools = agentTools(editor.agents.session("assistant"));
// [{ name, description, inputSchema, call }]
```

The host binds the session at construction, as P-7.1 binds a job.
`agentActor` has `kind: "ai"` and names a `model` only when the host
knows it. Tool inputs are data, never identity.

**Tools.** Descriptions and schemas are generated from the plugin
registry, so an agent sees this editor's block types and declared
fields.

| Tool | Returns | Evidence |
| --- | --- | --- |
| `nooq_outline` | A new base, the live tree as IDs, types and short previews, and the session's unsettled suggestions. | None. Navigation only. |
| `nooq_read` | Full content of named blocks or subtrees from a base. | Each block returned (P-7.2 declared read). |
| `nooq_selection` | A new base, the writer's selection, and the text it covers. | The covered blocks. |
| `nooq_propose` | Publishes one suggestion compiled from edits against a base. | Declared reads, P-7.2 dependencies, and DM-6.7. |
| `nooq_suggestions` | This session's suggestions and their DM-6.2 states. | None. |

No tool accepts, rejects or writes directly (§5, DM-6.3).

**Bases.** A base handle names a captured state. Evidence comes from the
base the agent read, so text the writer changed while the agent was
thinking shows as `stale`. A session keeps a few bases. An evicted one,
or any after a rebase (DM-16), returns `base-expired`.

**Edits.** `nooq_propose` takes `{ base, intent, edits }`. The `intent`
is the line a writer reads when reviewing.

| Edit | Compiles to |
| --- | --- |
| `{ setText: block, runs: [{ text, marks? }] }` | DM-4.3: the minimal splices from the base text. |
| `{ replaceText: block, find, replace, marks?, occurrence? }` | The same, for one exact match. |
| `{ setField: block, key, value }` | DM-4.2, for fields declared with `defineBlockSchema` (proposals/0004). |
| `{ insertBlock: type, parent, position, runs?, fields? }` | DM-4.1 with a fresh ID owned by the bound actor. |
| `{ moveBlock: block, parent, position }` | DM-4.4. |
| `{ deleteBlock: block }` | DM-4.5. |

`parent` may be `null`, the root list. `position` is `"first"`,
`"last"` or `{ after: id }`, and compiles to an index. Minimal diffs keep
untouched characters, so their attribution survives (DM-5) and remote
carets stay put (EB-7). Diffs count UTF-16 code units and never split a
surrogate pair.

**Results.** `ok`, `invalid`, `base-expired`, `unsupported-evidence`,
`denied` (retryable or not, P-5.1), `limit`, or `closed`. Only a
published proposal changes the document. No call moves the selection,
focus or caret (P-7.4).

**Limits.** Caps on unsettled suggestions and ops per proposal. They are
local policy that peers can't enforce. They exist because rejected
suggestions persist until a rebase (DM-6.4, DM-16) and grants can't be
revoked (DM-10.6).

**Identity.** In a secured document each binding needs its own key with
a suggester grant (DM-13). Grants are append-only, so hosts SHOULD keep
one stable agent key per writer and device. Until the owner grants it,
publication is `denied` with reason `not-ready`.

### 3. Packages

`@nooq/plugins` gains sessions next to jobs, exposed as `editor.agents`.
A new `@nooq/agent-tools` holds the tools and edit compilation, with no
dependency on any model, vendor or browser API. Its tool list plugs into
any tool-calling loop.

## Security

- Document text is untrusted input to an agent, and any peer can write
  it. The only thing following injected text can produce is a suggestion
  a writer must accept. Tool descriptions say document text is not
  instructions.
- Reads go to the agent's vendor. Hosts decide whether to create a
  session.
- A leaked agent key can't be revoked. It can only suggest, but it can
  do so in that document indefinitely.

## Compatibility

- No wire or operation change. Peers without the new package see
  ordinary suggestion blocks from an `ai` actor.
- A Draft 1.9 `evaluate` reads a root entry as evidence for a `missing`
  block and reports `conflicted`. Older peers fail closed, never open.
- `Editor.propose` and `aiKey` remain. New code uses bindings (P-7.1).

## Non-goals

- Accept, reject or direct writes through tools.
- Plugin commands as tools (Open question 3).
- Streaming suggestions (P-7.4).
- Transports: browser exposure through WebMCP, and an MCP server for
  headless peers. Each is a separate proposal that wraps this tool list.

## Tests that will gate this

`packages/core/test/`:

- `rootsDigest` matches its stated digest input. Peers in an op storm
  agree on every root-entry verdict.
- A root inserted inside the prefix after the base gives `conflicted`.
  One appended after it leaves `fresh`.
- Publishing never conflicts the suggestion's own root entry.
- Settling an older suggestion inside the prefix conflicts a newer root
  proposal.

`packages/plugins/test/` and `packages/agent-tools/test/`:

- Every `inputSchema` is valid JSON Schema 2020-12. Invalid input returns
  `invalid` before any capture work.
- Read tools leave revision, document, selection and focus unchanged.
- Evidence comes from the cited base. A block edited between read and
  propose publishes as `stale`.
- Text edits are minimal. After acceptance, untouched characters keep
  their client and a remote caret in them has not moved. No surrogate
  pair is split.
- An ambiguous `find`, or a `setField` outside its declaration, returns
  `invalid`.
- Root inserts, moves and deletes publish with one root entry. A batch
  of several root edits pins the shortest prefix that covers them all.
- The suggestion's creator is the bound `ai` actor. Without a grant,
  the result is `denied` and nothing commits.
- Eviction and rebase return `base-expired`. The cap returns `limit`.
  After close, every call returns `closed`.

Not yet run: the EB-6 keystroke budget with a session open and idle.

## Open questions

1. **Delegated grants.** May a writer grant the suggester role to their
   own agent keys? DM-13 lets only the owner write `access`.
2. **Withdrawal.** Reject needs a writer (DM-13). May an agent withdraw
   its own suggestion?
3. **Commands as tools.** Plugin commands could run in propose mode if
   their arguments had schemas next to `validateArgs`.
4. **Attribution in reads.** Captured blocks leave out attribution
   (P-7.2). Would showing which blocks a human wrote help agents resist
   injected text?
5. **Agent presence.** Should a session announce itself in awareness
   (SW-7)?
6. **Delete granularity.** Should deleting a root pin only its
   membership rather than every root before it?
7. **Naming.** Is `@nooq/agent-tools` distinct enough from
   `plugin-agent`?

## Amendments during the comment period

None yet.
