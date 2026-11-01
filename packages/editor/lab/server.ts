/**
 * Serves the lab page (bundled by Bun from its HTML import) and the
 * reference documents as Yjs updates.
 */

import page from "./page/bench.html";
import { refUpdate, type RefDocName } from "./refdocs.ts";

export function startLabServer(): { url: string; stop(): void } {
  // EB-8: prewarm the reference-doc cache OUTSIDE every measured load —
  // first-request generation (~0.9s for ref-huge) otherwise lands inside
  // load 1's fetch on the page clock.
  // The cache keys by name:docId and the bench page requests `lab-${docName}`
  // (bench.ts) — prewarm those exact keys or load 1 pays server-side generation.
  for (const name of ["ref-small", "ref-large", "ref-huge"] as const) refUpdate(name, `lab-${name}`);
  const server = Bun.serve({
    port: 0,
    development: false,
    routes: {
      "/": page,
      "/doc/:name": (req) => {
        const name = req.params.name as RefDocName;
        const id = new URL(req.url).searchParams.get("id") ?? `lab-${name}`;
        return new Response(new Blob([refUpdate(name, id) as unknown as BlobPart]), { headers: { "content-type": "application/octet-stream" } });
      },
    },
  });
  return { url: server.url.href, stop: () => server.stop(true) };
}
