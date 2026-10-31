# @nooq/design

The nooq design system: tokens, the reference theme, and framework-agnostic DOM
components for the writing surface and the protocol-visible UI (provenance,
AI proposals, sync). The brand book is [`docs/brand-book.md`](docs/brand-book.md);
the spec-to-UI map is [`docs/protocol-surfaces.md`](docs/protocol-surfaces.md).

## Use it

```ts
import "@nooq/design/fonts.css"; // optional: self-hosted Literata + Atkinson Hyperlegible
import "@nooq/design/tokens.css";
import "@nooq/design/nooq.css";
import { suggestionCard } from "@nooq/design";

panel.append(suggestionCard({ state: "fresh", actor: "Rewrite assistant", model: "qwen3-8b", diff, onAccept, onReject }));
```

- Components are plain functions that return DOM nodes, so they work in
  ProseMirror node views and inside any framework.
- Everything shipped is prefixed: custom properties are `--nq-*`, classes are
  `.nq-*`. The theme styles nothing outside its own classes and never sets
  `color-scheme` on the host's `:root`.
- Light is the default. `data-nq-theme="dark"` switches a subtree;
  `data-nq-theme="system"` follows the OS. Themes nest.
- Theme nooq by overriding `--nq-*` tokens. The reference theme uses no value
  that is not a token (§7).

## Work on it

`tokens.json` is the single source of truth. Edit it, then regenerate the CSS:

```sh
bun run tokens          # tokens.json → src/tokens.css
bun run logo            # logo geometry + tokens.json → assets/*.svg
bun run storybook       # living docs at http://localhost:6006
bun test                # unit tests (also run by `bun test` at the repo root)
bun run test:stories    # every story in Chromium, light and dark, with axe
```

`bun run test:stories` needs Chromium once: `bunx playwright install chromium`.

## What the tests hold us to

- **Tokens:** valid names and values, aliases that resolve, a committed
  `tokens.css` that matches `tokens.json`, and no `var(--nq-*)` in the theme
  that the tokens don't define.
- **Contrast:** every pair promised in a usage note meets WCAG 2 (4.5:1 text,
  3:1 marks and control borders) in both themes, including the focus ring.
- **Peer inks:** `peerInk()` matches an independent implementation of the
  published rule and reaches all six inks.
- **Components:** markup, spec wording (DM-6.2 state names, DM-5 adoption
  provenance), keyboard behavior and handlers, in happy-dom.
- **Stories:** each story is a Vitest browser test, run once per theme. Play
  functions exercise real clicks and keys; axe fails the run on any
  violation.
