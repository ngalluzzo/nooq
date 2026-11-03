/**
 * The image view + wire: the picture, the caption line (the block's text,
 * the surface's ordinary editor), and the file limb — paste or drop an
 * image FILE and the host's onImageFile hook answers with {src, digest?},
 * or the honest §8 notice ("This host stores no images"). Never a silent
 * failure; the digest field rides from day one (0014 fills it with meaning).
 */
import { defineDOMPlugin, defineTextPolicy, type BlockViewContext, type SurfacePluginContext } from "@nooq/plugins/dom";
import { blockRow } from "@nooq/design";
import { image, imagePlugin } from "./index.ts";
import { digestOfBlobSrc } from "@nooq/sync";

export interface ImageHostOptions {
  /** The host's storage: a file in, a durable reference out. Digest optional —
   *  verifiable when the host can, plain when it cannot. */
  onImageFile?(file: File): Promise<{ src: string; digest?: string }>;
  /** 0014: the blob channel — resolve a digest to verified bytes (the
   *  session's BlobStore does this: re-hash on arrival, cache forever).
   *  Hosts without blob storage render a named error, never a broken img. */
  fetchBlob?(digest: string): Promise<Uint8Array>;
}

/** Object URLs by digest: content-addressed means immutable — one URL, kept. */
const objectUrls = new Map<string, string>();

export const imageDOM = (host: ImageHostOptions = {}): import("@nooq/plugins/dom").DOMPlugin => defineDOMPlugin({
  id: "nooq.image.dom", forPlugin: imagePlugin,
  views: [{
    type: image.type,
    textPolicy: defineTextPolicy({ defaultMode: "plain", enter: "newline" }),
    mount(ctx: BlockViewContext) {
      const text = ctx.mountTextEditor({ label: "Image caption" });
      const caption = text.element as HTMLTextAreaElement;
      caption.classList.add("nq-image-caption");
      caption.setAttribute("placeholder", "Write a caption…");
      const img = document.createElement("img");
      img.className = "nq-image-picture";
      img.alt = "";
      const shell = document.createElement("figure");
      shell.className = "nq-image";
      shell.append(img, caption, ctx.children.element);
      const element = blockRow({ content: [shell], kind: "paragraph", actor: "human" });
      let renderedDigest: string | null = null;
      const honest = (problem: string | undefined): void => {
        if (problem === undefined) { shell.removeAttribute("data-error"); delete shell.dataset.problem; }
        else { shell.setAttribute("data-error", problem); }
      };
      return { element, update(block) {
        const src = typeof block.fields.src === "string" ? block.fields.src : "";
        // §9: alt is the field when present, the caption otherwise — never empty on purpose.
        const alt = typeof block.fields.alt === "string" && block.fields.alt !== "" ? block.fields.alt : block.text?.s ?? "";
        img.alt = alt;
        // 0014: a nooq-blob: src resolves through the host's verified channel.
        const blobDigest = digestOfBlobSrc(src);
        if (blobDigest === null) {
          renderedDigest = null;
          honest(undefined);
          if (img.getAttribute("src") !== src) img.src = src;
          return;
        }
        if (blobDigest === renderedDigest) return; // already rendered (or in flight)
        renderedDigest = blobDigest;
        // The named digest must agree with the digest field when both exist.
        const fieldDigest = typeof block.fields.digest === "string" ? block.fields.digest : undefined;
        if (fieldDigest !== undefined && fieldDigest !== blobDigest) { honest("The image's source and its digest disagree."); img.removeAttribute("src"); return; }
        if (!host.fetchBlob) { honest("This host cannot fetch stored images."); img.removeAttribute("src"); return; }
        void host.fetchBlob(blobDigest).then(bytes => {
          let url = objectUrls.get(blobDigest);
          if (url === undefined) {
            const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg";
            url = URL.createObjectURL(new Blob([bytes.slice() as unknown as BlobPart], { type }));
            objectUrls.set(blobDigest, url);
          }
          honest(undefined);
          img.src = url;
        }).catch(() => { honest("The image could not be fetched or verified."); img.removeAttribute("src"); });
      }, destroy() { text.destroy(); } };
    },
  }],
  /** The file limb: image files by paste or drop, on the surface root. */
  surface({ root, signal, snapshot, run }: SurfacePluginContext) {
    const announce = (message: string): void => {
      root.dispatchEvent(new CustomEvent("nq:image-host", { bubbles: true, detail: { message } }));
    };
    const imageFileOf = (items: DataTransferItemList | readonly DataTransferItem[] | null): File | null => {
      if (!items) return null;
      for (const item of Array.from(items as DataTransferItemList)) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) return file;
      }
      return null;
    };
    const lastRow = (): string | undefined =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-nq-block]")).filter(el => root.contains(el)).at(-1)?.dataset.nqBlock;
    const receive = (file: File, after: string | undefined): void => {
      if (!host.onImageFile) { announce("This host stores no images."); return; }
      void host.onImageFile(file)
        .then(({ src, digest }) => {
          const target = after ?? [...snapshot().roots].at(-1);
          if (target === undefined) return;
          run("nooq.block.insert", { type: image.type, parent: null, fields: { src, ...(digest !== undefined ? { digest } : {}) } });
        })
        .catch(() => announce("The image upload failed."));
    };
    const onPaste = (event: ClipboardEvent): void => {
      const file = imageFileOf(event.clipboardData?.items ?? null);
      if (!file) return;
      event.preventDefault();
      receive(file, document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>("[data-nq-block]")?.dataset.nqBlock ?? lastRow() : lastRow());
    };
    const onDragOver = (event: DragEvent) => { if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault(); };
    const onDrop = (event: DragEvent) => {
      const file = imageFileOf(event.dataTransfer?.items ?? null);
      if (!file) return;
      event.preventDefault();
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-nq-block]") : null;
      receive(file, row?.dataset.nqBlock ?? lastRow());
    };
    root.addEventListener("paste", onPaste, { signal });
    root.addEventListener("dragover", onDragOver, { signal });
    root.addEventListener("drop", onDrop, { signal });
  },
});
