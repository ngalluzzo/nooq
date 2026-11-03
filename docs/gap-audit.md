# nooq vs BlockNote: the honest surface gap audit

**Date: 2026-11-02.** What a skeptical evaluator, opening nooq and BlockNote
side by side, reaches for. Ranked by what they'd miss first. Built from
nooq's code (not its aspirations) and BlockNote's current docs.

## Where nooq is AHEAD (say it out loud)

| Capability | nooq | BlockNote |
|---|---|---|
| Offline-first sync | ✅ by design (SW-1) | ⚠️ requires a server |
| Signed provenance (who wrote what, verified) | ✅ DM-12/13, hostile-storm tested | ❌ |
| Access control in the document | ✅ grants, epochs, revocation (0012) | ❌ (host's job) |
| Suggestions as first-class (AI edits are proposals) | ✅ DM-6 | ❌ |
| History / time travel | ✅ DM-14/15 | ❌ |
| Enforced latency budgets | ✅ CI-gated (EB-5/6/7/8) | ❌ |
| Framework: none required (DOM-first) | ✅ | ❌ React-first |
| Zero-cost core | ✅ MIT/Apache, no XL tier | ❌ paid tiers |

## The gaps, ranked by what a user notices first

### Tier 1 — the first five minutes

| Gap | nooq today | BlockNote | Effort |
|---|---|---|---|
| **Lists** (bullet, numbered, checkbox) | ❌ none | ✅ all three, with nesting | Medium — one block type (`nooq.list/v1`) + Enter/Backspace semantics + markdown paste mapping; the split/merge machinery exists |
| **Drag handle** (grab a block, move it) | ❌ | ✅ | Medium — the DM-4 move op and register exist; this is a UI affordance (handle, drop indicator) + a command. The hardest 20% is drag-across-nesting |
| **Headings with levels** | ⚠️ one level | ✅ 6 levels + toggleable | Small — heading gains a `level` field; the field mechanism exists |
| **Divider** (`---` → rule) | ❌ | ✅ | Trivial — a textless block type + markdown mapping |

### Tier 2 — the first hour

| Gap | nooq today | BlockNote | Effort |
|---|---|---|---|
| **Code blocks with highlighting** | ❌ | ✅ (CodeMirror) | Medium — 0003 already decides this: CM embedded in node views. Blocked on the PM surface's node views |
| **Paste from markdown/HTML** | ❌ (types as plain) | ✅ both | Medium — a parser mapping to nooq ops; the export engine's shape (block formatters) inverts |
| **Tables** | 🔵 drafted (proposals/0015) — a table is a tree; ZERO model changes, the work is surface; opens with stage 1 | ✅ (XL tier) | The trap dissolved: every table op is an ordinary block op already built |
| **Images / embeds** | ✅ v1 (plugin-image) — URL + host upload + digest field; blobs drafted as proposals/0014 | ✅ | v1 shipped; the content-addressed blob layer awaits its window |

### Tier 3 — the first week

| Gap | nooq | BlockNote | Effort |
|---|---|---|---|
| **Text colors / alignment** | ❌ | ✅ default props | Small — marks + fields exist |
| **Math (LaTeX)** | ❌ | ✅ | Small as a plugin (KaTeX renders a textless block) — a great first third-party plugin |
| **Mermaid diagrams** | ❌ | ✅ | Same shape as math |
| **i18n** | ❌ hard-coded strings | ✅ | Medium — string audit; low priority until a user asks |
| **Native IME acceptance** | ⚠️ works via textarea; 0004's remainder is the guarantee | ✅ | Already tracked (0004) |

## The recommendation

**Tier 1 in order: lists → heading levels → divider → drag handle.**
Lists are the single most-missed affordance in any block editor — every
note starts as one. Heading levels and divider are small, quick wins that
make the slash menu feel real. The drag handle is the "this is a block
editor" gesture; it demos the plugin API publicly (a plugin can ship it).

Then **paste** (Tier 2's highest feel-per-effort) — an editor that mangles
pasted markdown loses trust in the first paste.

**Tables are the trap.** They're the largest gap and the worst first move:
months of structure work before a user sees anything. Ship Tier 1 + paste
first; the table DM conversation can start when a real user asks.

**Math and diagrams are the §7 showcase:** build them exactly as a plugin
author would — the first proof that the ecosystem works, in public, wearing
the same contribution path links already proved.
