/**
 * Serves the lab page (bundled by Bun from its HTML import) and the
 * reference documents as Yjs updates.
 */

import page from "./page/bench.html";
import { refUpdate, type RefDocName } from "./refdocs.ts";

export function startLabServer(): { url: string; stop(): void } {
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
