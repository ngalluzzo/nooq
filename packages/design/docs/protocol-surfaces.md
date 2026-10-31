# Protocol surfaces

Most design systems style buttons and cards. nooq also has to show the document model: who wrote each block, whether an AI proposal still applies, what a digest pins. This section maps each spec concept a writer can encounter to the component and tokens that show it. When the spec changes, this table changes in the same PR.

| Spec | What the writer sees | Component | Tokens |
| --- | --- | --- | --- |
| DM-2 block ID | Nothing by default. Wherever one is shown (a link to a block, a debug view), in `digest` type. | Digest | `digest`, `graphite-muted` |
| DM-2 fingerprint | Truncated `sha256:9f2c1a…e81a`, click to copy the full value. | Digest | `digest`, `paper-sunken` |
| DM-3.4 tombstone | The block, struck through, with "Deleted" and Restore. | BlockRow (`deleted`) | `graphite-muted` |
| DM-4.8 edit-vs-delete | "Deleted with 2 later edits", so the writer knows restoring brings back work. | BlockRow (`laterEdits`) | `graphite-muted` |
| DM-5 actor descriptor | A chip: mark, name, model if AI, kind word if not human. | ActorChip | `ink`, `peer-*`, `pencil`, `machine` |
| DM-5 per-block attribution | The change bar in the gutter, colored by the last writer. | BlockRow | `change-bar`, `gutter` |
| DM-5 adoption provenance | "Proposed by qwen3-8b · accepted by Maya." Both actors, always. | SuggestionCard (`accepted`) | `ink` |
| DM-6 proposal | A card with the exact diff: insertions pencilled in, deletions struck. | SuggestionCard | `pencil-soft`, `pencil-text` |
| DM-6.1 evidence | The content and structure digests the proposal was made against. | SuggestionCard, Digest | `digest` |
| DM-6.2 fresh | Solid pencil tag. Accept is the primary action. | StateTag | `pencil`, `on-pencil` |
| DM-6.2 stale | Dashed pencil tag and outline; one sentence naming who changed what. | StateTag, SuggestionCard | `pencil-text` |
| DM-6.2 conflicted | Stamp tag and outline; one sentence naming what moved or was deleted. | StateTag, SuggestionCard | `stamp`, `stamp-soft` |
| DM-6.3 accept anyway | When not fresh, the button reads "Accept anyway" and is no longer primary. The writer decides. | SuggestionCard | `rule-strong` |
| DM-6.4 reject | Card collapses to "Rejected by Maya · kept in history". | SuggestionCard (`rejected`) | `graphite-muted` |
| DM-6.5 continuous revalidation | The tag and outline change in place, with no toast or animation. | StateTag | none |
| DM-8 sync | A neutral status line. Offline reads as a fact, not a failure (§2). | SyncStatus | `graphite-muted` |
| §7 every block is a plugin | The slash menu shows each block's type id; a third-party block's row looks like a built-in's. | SlashMenu | `digest` |

## Wording that comes from the spec

- Proposal states are always the DM-6.2 words: fresh, stale, conflicted, accepted, rejected. Do not soften them to "outdated" or "needs review".
- The intent string on a transaction (DM-4 `intent`, for example `rewrite-intro`) appears as written, in `ui-caption`, after the state tag.
- Actor kinds read as words in `ui-caption`: AI, Importer, Migration, System. Humans show only their name.
