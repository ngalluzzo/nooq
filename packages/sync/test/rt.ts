import type { RenderedText } from "@nooq/core";

/** Unmarked rendered text (mirror of the other packages' test helper). */
export function rt(s: string): RenderedText {
  return { s, marks: s.split("").map(() => []) };
}
