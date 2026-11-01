/**
 * Host settings shared by every Storybook-shaped surface: the theme attribute
 * and the axe exclusions for component-isolated audits. Plain values and
 * functions only — no Storybook imports — so the design package's own preview
 * and the plugin-agent's independent browser harness run one definition.
 */
import { PREFIX } from "./tokens.ts";

/** The attribute a host sets to opt a subtree into a nooq theme. */
export const themeAttribute = `data-${PREFIX}-theme`;

/** Apply a theme (`"light"` or `"dark"`) to an element, typically `document.documentElement`. */
export function applyStoryTheme(element: HTMLElement, theme: string): void {
  element.setAttribute(themeAttribute, theme);
}

/**
 * Page-level rules that judge a whole document, not a component in isolation.
 * Every isolated story audit disables exactly these.
 */
export const pageLevelAxeRuleIds = ["page-has-heading-one", "landmark-one-main", "region"] as const;

/** The same exclusions in axe.run() shape. */
export const pageLevelAxeRuleOverrides: Record<string, { enabled: boolean }> =
  Object.fromEntries(pageLevelAxeRuleIds.map((id) => [id, { enabled: false }]));

/** The same exclusions in @storybook/addon-a11y `config.rules` shape. */
export const pageLevelA11yRules: Array<{ id: string; enabled: boolean }> =
  pageLevelAxeRuleIds.map((id) => ({ id, enabled: false }));
