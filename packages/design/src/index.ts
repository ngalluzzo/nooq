/**
 * @nooq/design — the nooq design system.
 *
 * Load `@nooq/design/tokens.css` and `@nooq/design/nooq.css` (and
 * `@nooq/design/fonts.css` for the self-hosted faces), then build UI with the
 * functions below. They return plain DOM nodes.
 */

export { ANNOUNCE_QUIET, announcer, type Announcer, type AnnouncerTiming } from "./components/announcer.ts";
export { actorChip, inkVar, KIND_LABEL, type ActorChipProps, type Ink } from "./components/actor-chip.ts";
export { accessPanel, ROLE_WORDS, type AccessPanelEntry, type AccessPanelProps } from "./components/access-panel.ts";
export { blockContainer, CONTAINER_TONES, setBlockContainerTone, type BlockContainerProps, type ContainerTone } from "./components/block-container.ts";
export { blockHistoryPanel, type BlockHistoryEntry, type BlockHistoryPanelProps } from "./components/block-history.ts";
export { blockRow, changeBarKind, deletedLabel, type BlockKind, type BlockRowProps } from "./components/block-row.ts";
export { button, toAriaShortcut, type ButtonProps } from "./components/button.ts";
export { checkbox, selectField, segmentedControl, textField, toggle, type CheckboxProps, type FieldBase, type FieldOption, type SelectFieldProps, type SegmentedControlProps, type TextFieldProps, type ToggleProps } from "./components/form-controls.ts";
export { digest, truncateDigest, type DigestProps } from "./components/digest.ts";
export { dialog, type DialogAction, type DialogCloseReason, type DialogHandle, type DialogOptions } from "./components/dialog.ts";
export { documentHeader, type DocumentHeaderProps } from "./components/document-header.ts";
export { loading, LOADING_DELAY, type LoadingHandle, type LoadingOptions } from "./components/loading.ts";
export { notice, type NoticeAction, type NoticeKind, type NoticeProps } from "./components/notice.ts";
export { caret, presenceCaret, type PresenceCaretProps } from "./components/presence-caret.ts";
export { presenceRoster, type PresenceRosterPeer, type PresenceRosterProps } from "./components/presence-roster.ts";
export { computePlacement, popover, type Box, type ComputePlacementInput, type Placement, type PopoverCloseReason, type PopoverHandle, type PopoverOptions, type PopoverSide } from "./components/popover.ts";
export { shortcutSheet, type ShortcutSheetEntry, type ShortcutSheetGroup, type ShortcutSheetProps } from "./components/shortcut-sheet.ts";
export { slashMenu, type SlashMenuItem, type SlashMenuProps } from "./components/slash-menu.ts";
export { stateTag, SUGGESTION_STATES, type StateTagProps, type SuggestionState } from "./components/state-tag.ts";
export { suggestionCard, type DiffSegment, type SuggestionCardProps } from "./components/suggestion-card.ts";
export { syncStatus, syncText, type SyncState, type SyncStatusProps } from "./components/sync-status.ts";
export { tooltip, type TooltipHandle, type TooltipOptions } from "./components/tooltip.ts";
export { draftPreview, workingState, type WorkingStateActor, type WorkingStateProps } from "./components/working-state.ts";
export { checkContrast, contrastRatio, CONTRAST_PAIRS, luminance, type ContrastPair, type ContrastResult } from "./contrast.ts";
export { glyph, type GlyphName } from "./glyphs.ts";
export { PEER_INKS, peerInk, type PeerInk } from "./peer.ts";
export { cssVar, PREFIX, resolveColor, THEMES, tokensToCss, type ThemeId, type Tokens } from "./tokens.ts";
export { applyStoryTheme, pageLevelA11yRules, pageLevelAxeRuleIds, pageLevelAxeRuleOverrides, themeAttribute } from "./story-settings.ts";
export { animateWordmark, mark, renderWordmarkFrame, wordmark, type AnimateOptions, type LogoProps, type WordmarkAnimation } from "./brand/wordmark.ts";
export { logoFrame, PIECE_LENGTH, REST, TIMINGS, type LogoFrame, type Phase, type Timing, type TimingName } from "./brand/geometry.ts";
