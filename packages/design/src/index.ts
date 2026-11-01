/**
 * @nooq/design — the nooq design system.
 *
 * Load `@nooq/design/tokens.css` and `@nooq/design/nooq.css` (and
 * `@nooq/design/fonts.css` for the self-hosted faces), then build UI with the
 * functions below. They return plain DOM nodes.
 */

export { actorChip, inkVar, KIND_LABEL, type ActorChipProps, type Ink } from "./components/actor-chip.ts";
export { blockContainer, CONTAINER_TONES, setBlockContainerTone, type BlockContainerProps, type ContainerTone } from "./components/block-container.ts";
export { blockRow, changeBarKind, deletedLabel, type BlockKind, type BlockRowProps } from "./components/block-row.ts";
export { button, toAriaShortcut, type ButtonProps } from "./components/button.ts";
export { checkbox, selectField, segmentedControl, textField, toggle, type CheckboxProps, type FieldBase, type FieldOption, type SelectFieldProps, type SegmentedControlProps, type TextFieldProps, type ToggleProps } from "./components/form-controls.ts";
export { digest, truncateDigest, type DigestProps } from "./components/digest.ts";
export { notice, type NoticeAction, type NoticeKind, type NoticeProps } from "./components/notice.ts";
export { caret, presenceCaret, type PresenceCaretProps } from "./components/presence-caret.ts";
export { computePlacement, popover, type Box, type ComputePlacementInput, type Placement, type PopoverCloseReason, type PopoverHandle, type PopoverOptions, type PopoverSide } from "./components/popover.ts";
export { slashMenu, type SlashMenuItem, type SlashMenuProps } from "./components/slash-menu.ts";
export { stateTag, SUGGESTION_STATES, type StateTagProps, type SuggestionState } from "./components/state-tag.ts";
export { suggestionCard, type DiffSegment, type SuggestionCardProps } from "./components/suggestion-card.ts";
export { syncStatus, syncText, type SyncState, type SyncStatusProps } from "./components/sync-status.ts";
export { tooltip, type TooltipHandle, type TooltipOptions } from "./components/tooltip.ts";
export { checkContrast, contrastRatio, CONTRAST_PAIRS, luminance, type ContrastPair, type ContrastResult } from "./contrast.ts";
export { glyph, type GlyphName } from "./glyphs.ts";
export { PEER_INKS, peerInk, type PeerInk } from "./peer.ts";
export { cssVar, PREFIX, resolveColor, THEMES, tokensToCss, type ThemeId, type Tokens } from "./tokens.ts";
export { applyStoryTheme, pageLevelA11yRules, pageLevelAxeRuleIds, pageLevelAxeRuleOverrides, themeAttribute } from "./story-settings.ts";
export { animateWordmark, mark, renderWordmarkFrame, wordmark, type AnimateOptions, type LogoProps, type WordmarkAnimation } from "./brand/wordmark.ts";
export { logoFrame, PIECE_LENGTH, REST, TIMINGS, type LogoFrame, type Phase, type Timing, type TimingName } from "./brand/geometry.ts";
