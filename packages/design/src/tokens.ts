/**
 * Token model and the tokens.json → CSS compiler.
 *
 * tokens.json is the single source of truth, in the same list-shaped format
 * as the published design system. Names there are unprefixed (`paper`);
 * everything this package ships is prefixed (`--nq-paper`, `.nq-doc-body`)
 * so the theme can sit inside any host page without collisions.
 */

export const PREFIX = "nq";

export type ThemeId = "light" | "dark";
export const THEMES: readonly ThemeId[] = ["light", "dark"];

export interface ColorToken {
  name: string;
  /** A literal, an alias `{other}`, or one of those per theme. */
  value: string | Partial<Record<ThemeId, string>>;
  usage: string;
}

export interface LengthToken {
  name: string;
  value: string;
  usage: string;
}

export interface ShadowToken {
  name: string;
  value: string | Partial<Record<ThemeId, string>>;
  usage: string;
}

export interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
  fontStyle?: "normal" | "italic";
  opticalSize?: number;
  family?: string;
  sample?: string;
  usage?: string;
}

export interface TypeGroup {
  name: string;
  family: string;
  note?: string;
  styles: TypeStyle[];
}

export interface Tokens {
  name: string;
  version: number;
  color: { themes: { id: ThemeId; name: string }[]; tokens: ColorToken[] };
  type: { fonts: unknown[]; families: Record<string, string>; groups: TypeGroup[] };
  spacing: { note?: string; tokens: LengthToken[] };
  radius: { note?: string; tokens: LengthToken[] };
  shadow: { note?: string; tokens: ShadowToken[] };
  editor: { note?: string; tokens: LengthToken[] };
}

const ALIAS = /^\{([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\}$/;

export function cssVar(name: string): string {
  return `--${PREFIX}-${name}`;
}

export function aliasTarget(value: string): string | undefined {
  return ALIAS.exec(value)?.[1];
}

/** The raw value a token declares for a theme; a missing theme inherits the first theme's. */
export function declaredValue(token: { value: string | Partial<Record<ThemeId, string>> }, theme: ThemeId): string {
  if (typeof token.value === "string") return token.value;
  const v = token.value[theme] ?? token.value[THEMES[0]!];
  if (v === undefined) throw new Error(`token has no value for ${theme}`);
  return v;
}

/** A color token's final hex for a theme, following aliases. */
export function resolveColor(tokens: Tokens, name: string, theme: ThemeId, seen: string[] = []): string {
  if (seen.includes(name)) throw new Error(`alias cycle: ${[...seen, name].join(" → ")}`);
  const token = tokens.color.tokens.find((t) => t.name === name);
  if (!token) throw new Error(`unknown color token: ${name}`);
  const value = declaredValue(token, theme);
  const target = aliasTarget(value);
  return target ? resolveColor(tokens, target, theme, [...seen, name]) : value;
}

function cssValue(value: string): string {
  const target = aliasTarget(value);
  return target ? `var(${cssVar(target)})` : value;
}

function themeDeclarations(tokens: Tokens, theme: ThemeId, indent: string): string[] {
  const out: string[] = [];
  for (const t of tokens.color.tokens) out.push(`${indent}${cssVar(t.name)}: ${cssValue(declaredValue(t, theme))};`);
  for (const t of tokens.shadow.tokens) out.push(`${indent}${cssVar(t.name)}: ${declaredValue(t, theme)};`);
  return out;
}

/**
 * Compile tokens.json to tokens.css.
 *
 * Light is the default on :root. Dark applies only where a host opts in with
 * data-nq-theme="dark", or data-nq-theme="system" to follow the OS. A theme
 * never switches on its own inside a host page that has no dark mode.
 * Every theme block re-declares aliases, because a custom property that
 * references var() resolves where it is declared.
 */
export function tokensToCss(tokens: Tokens): string {
  const lines: string[] = [
    `/* ${tokens.name} — generated from tokens.json by scripts/build-tokens.ts. Do not edit. */`,
    "",
    ":root {",
    ...themeDeclarations(tokens, "light", "  "),
    "}",
    "",
  ];
  for (const theme of THEMES) {
    // "system" starts light and flips in the media block below.
    const selector = theme === "light" ? `[data-${PREFIX}-theme="light"], [data-${PREFIX}-theme="system"]` : `[data-${PREFIX}-theme="${theme}"]`;
    lines.push(`${selector} {`, `  color-scheme: ${theme};`, ...themeDeclarations(tokens, theme, "  "), "}", "");
  }
  lines.push(
    "@media (prefers-color-scheme: dark) {",
    `  [data-${PREFIX}-theme="system"] {`,
    "    color-scheme: dark;",
    ...themeDeclarations(tokens, "dark", "    "),
    "  }",
    "}",
    "",
    ":root {",
  );
  for (const family of ["spacing", "radius", "editor"] as const) {
    for (const t of tokens[family].tokens) lines.push(`  ${cssVar(t.name)}: ${t.value};`);
  }
  for (const [key, stack] of Object.entries(tokens.type.families)) lines.push(`  ${cssVar(`font-${key}`)}: ${stack};`);
  lines.push("}", "");
  for (const group of tokens.type.groups) {
    for (const s of group.styles) {
      const decl = [
        `font-family: var(${cssVar(`font-${s.family ?? group.family}`)})`,
        `font-size: ${s.fontSize}`,
        `line-height: ${s.lineHeight}`,
        `font-weight: ${s.fontWeight}`,
      ];
      if (s.letterSpacing) decl.push(`letter-spacing: ${s.letterSpacing}`);
      if (s.fontStyle) decl.push(`font-style: ${s.fontStyle}`);
      if (s.opticalSize !== undefined) decl.push(`font-variation-settings: "opsz" ${s.opticalSize}`);
      lines.push(`.${PREFIX}-${s.name} { ${decl.join("; ")}; }`);
    }
  }
  return lines.join("\n") + "\n";
}
