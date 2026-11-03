# Proposal 0015: tables

**Status: DRAFT — not yet opened. Drafted: 2026-11-03.** A new plugin
package (a "significant change" under GOVERNANCE) — and, unusually, **zero
DOCUMENT-MODEL change**: tables are an instance of the tree the model
already owns. The product decision this proposal exists to make in public:
**honest raggedness** (below).

## The insight

A table is a tree:

```
nooq.table/v1         textless — the grid shell
└─ nooq.table-row/v1  textless — structural: insert, delete, move, drag,
   │                  attribute, supersede — every row op is DM-4's own
   └─ nooq.table-cell/v1  inline text — the CRDT owns the typing
```

Every table operation is an ordinary block operation, already built and
already proven: typing is the cell's inline text (two writers in one cell
**merge properly** — the sequence CRDT, never field-LWW); rows are blocks
(full attribution, history, the drag handle); a column insert is ONE
transaction inserting a cell into every row; concurrent column-and-row adds
converge the CRDT's way. Suggesters propose columns through DM-6's own
machinery. Access control needs nothing new — structural ops are structural
ops.

No model change. No protocol change. No sync change. The work is surface:
the grid view, navigation, and the column gestures.

## The product decision: honest raggedness

Concurrently, Maya adds a column (one cell into each row) while Ren adds a
row (carrying today's cell count). Ren's row arrives one cell short. The
model will not lie about the state, and neither will the surface:

- a short row **renders its gap** and carries a diagnostic naming it;
- "complete row" is **one transaction** that adds the missing cells;
- **no silent auto-padding** — padding would be the model guessing intent,
  and a merged document should show what actually happened.

The alternative considered: enforcing rectangularity in the model (reject
short rows). Rejected because it breaks the offline promise — Ren's row was
legal where he typed it, and the model does not punish legality for
arriving second. (Same grammar as DM-4.9's supersession: converge first,
explain after.)

## The shape of v1

- **Cells hold inline text only.** Nested blocks inside cells are deferred
  openly (BlockNote allows nesting; we name the gap, we do not hide it).
- **Column identity is derived** (column i = the i-th cell of each row) —
  no column objects; a column reorder is one transaction moving each row's
  i-th cell to j. Column widths live as one field on the table (LWW is
  fine: low contention, no content).
- **Navigation**: Tab across (creating a row when tabbing past the last
  cell — the gesture every writer knows), Enter down, arrows at cell
  edges; the caret's path in and out of cells is the surface's own work.
- **Markdown pipes both directions**: `| a | b |` rows import to blocks;
  export emits the same. The round trip is pinned like every other's.

## Stages

1. **Blocks + grid view + cell typing + Tab/Enter + row ops through the
   existing drag handle + pipe export/import** — a table you can fill.
2. **Column gestures** (add/remove/reorder, each one transaction) + the
   ragged-row repair + header-row rendering.
3. **Polish**: column sizing, selection ranges, paste-into-range.

## Costs, honestly

The view is the real work (a grid rendered from a tree, with a caret that
crosses cell boundaries); navigation is the polish mountain; column ops
are O(rows) in transaction size — boring, fast operations, but undo-
atomic, which is the point. No trust-layer, budget, or protocol work.

## Status of the implementation

Not started; opens with stage 1 under this window. Ships as the seventh
plugin through the ordinary path (§7 — links, drag handle, code, math,
image, diagrams, and now tables).
