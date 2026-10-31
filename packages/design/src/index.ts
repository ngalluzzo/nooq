/**
 * @nooq/design — the nooq design system.
 *
 * Load `@nooq/design/tokens.css` and `@nooq/design/nooq.css` (and
 * `@nooq/design/fonts.css` for the self-hosted faces), then build UI with the
 * functions below. They return plain DOM nodes.
 */

export { actorChip, inkVar, KIND_LABEL, type ActorChipProps, type Ink } from "./components/actor-chip.ts";
export { blockRow, changeBarKind, deletedLabel, type BlockKind, type BlockRowProps } from "./components/block-row.ts";
export { button, toAriaShortcut, type ButtonProps } from "./components/button.ts";
export { digest, truncateDigest, type DigestProps } from "./components/digest.ts";
export { caret, presenceCaret, type PresenceCaretProps } from "./components/presence-caret.ts";
export { slashMenu, type SlashMenuItem, type SlashMenuProps } from "./components/slash-menu.ts";
export { stateTag, SUGGESTION_STATES, type StateTagProps, type SuggestionState } from "./components/state-tag.ts";
export { suggestionCard, type DiffSegment, type SuggestionCardProps } from "./components/suggestion-card.ts";
export { syncStatus, syncText, type SyncState, type SyncStatusProps } from "./components/sync-status.ts";
export { checkContrast, contrastRatio, CONTRAST_PAIRS, luminance, type ContrastPair, type ContrastResult } from "./contrast.ts";
export { glyph, type GlyphName } from "./glyphs.ts";
export { PEER_INKS, peerInk, type PeerInk } from "./peer.ts";
export { cssVar, PREFIX, resolveColor, THEMES, tokensToCss, type ThemeId, type Tokens } from "./tokens.ts";
