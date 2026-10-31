# @nooq/plugin-callouts

A working developer-bundled plugin consuming only public nooq APIs.

Install `callouts` in `EditorOptions.plugins` and, in a browser, `calloutsDOM`
from `@nooq/plugin-callouts/dom` in `createSurface`'s plugins. The package
exports `callout`, `insertCallout`, and `cycleTone`. The default view uses the
host rich-text binding, exposes a labelled tone button, and retains the host child
container. `calloutsPlainDOM` preserves the earlier textarea presentation.
Its slash-menu action inserts a sibling and consumes the slash in one command;
if that source text changed, it leaves the document untouched.
The headless package needs no DOM and has no editor/Yjs imports.
It uses `defineBlockSchema`, `field.enum`, and standard insertion/cycling commands;
the field contract is declared once. The manifest version is 1.1.0 with API 1.

Stored type: `nooq.callout/v1`. Tone cycles through info, warning, and success.
Diagnostics report invalid tones without rewriting stored fields. Other
fields and marks survive unchanged. Peers without this plugin see the generic
fallback and retain identical document data. See the
[API guide](../plugins/README.md) for a runnable integration example.

This demonstrates the runtime boundary. Full seed-plugin release criteria,
including format-specific export mappings, remain tracked in proposal 0002.
