import type { PasteBlock } from "@nooq/plugins/essentials";

const paragraph = "nooq.paragraph/v1";
const list = "nooq.list/v1";
const discarded = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "template", "svg", "math", "noscript"]);
const flowSelector = "p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,hr,pre,div,section,article,table,tr";
const inlineTags: Readonly<Record<string, string>> = {
  b: "strong", strong: "strong", i: "em", em: "em", code: "code",
  u: "underline", s: "strike", strike: "strike", del: "strike", mark: "highlight",
};
const MAX_HTML = 512_000;
const MAX_TEXT = 64_000;
const MAX_BLOCKS = 1_000;
const MAX_DEPTH = 64;

function safeLink(raw: string): string | undefined {
  const value = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return;
  if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
  if (/^(#|\/(?![\/\\])|\.\.?\/)/.test(value)) return value;
}

function wordList(element: Element) {
  const style = element.getAttribute("style") ?? "";
  const info = /\bmso-list:\s*(l\d+)\s+level(\d+)\s+(lfo\d+)/i.exec(style);
  if (!info) return;
  const marker = Array.from(element.querySelectorAll("[style]"))
    .find(node => /\bmso-list:\s*ignore\b/i.test(node.getAttribute("style") ?? ""));
  const label = marker?.textContent?.trim();
  const kind = label && /^\d+[.)]$/.test(label) ? "number" : label && /^[•·●○▪◦§\uf0b7\uf0a7o]$/.test(label) ? "bullet" : undefined;
  if (kind) return { key: info[1]! + info[3]!, level: Math.min(MAX_DEPTH, Number(info[2])), kind, marker };
}

/** Decode a clipboard fragment into values. Its DOM stays in a detached template. */
export function decodeHTMLPaste(document: Document, html: string): PasteBlock[] | undefined {
  if (!html || html.length > MAX_HTML) return;
  const template = document.createElement("template");
  try { template.innerHTML = html; }
  catch { return; } // A host may enforce Trusted Types for HTML parsing.
  let characters = 0, blockCount = 0;
  const check = (depth: number) => { if (depth > MAX_DEPTH) throw new RangeError("Clipboard HTML is nested too deeply"); };
  const count = (block: PasteBlock) => {
    if (++blockCount > MAX_BLOCKS) throw new RangeError("Too many clipboard blocks");
    return block;
  };

  function inline(nodes: readonly Node[], depth: number, options: { marker?: Element; dropOffice?: boolean; pre?: boolean } = {}): Pick<PasteBlock, "text" | "fields"> {
    let s = "";
    const marks: string[][] = [];
    const fields: Record<string, string> = {};
    const links = new Map<string, string>();
    const lineBreak = () => {
      if (++characters > MAX_TEXT) throw new RangeError("Clipboard text is too large");
      s += "\n";
      marks.push([]);
    };
    const push = (raw: string, names: readonly string[]) => {
      const text = options.pre ? raw : raw.replace(/[\t\r\n\f ]+/g, " ");
      const part = !options.pre && (!s || /[ \n]$/.test(s)) ? text.replace(/^ +/, "") : text;
      characters += part.length;
      if (characters > MAX_TEXT) throw new RangeError("Clipboard text is too large");
      if (!part) return;
      s += part;
      for (let i = 0; i < part.length; i++) marks.push([...names]);
    };
    const marksAt = (element: HTMLElement, tag: string, inherited: readonly string[]): string[] => {
      const next = new Set(inherited);
      const semantic = inlineTags[tag];
      if (semantic && !(tag === "b" && element.id.startsWith("docs-internal-guid"))) next.add(semantic);
      const style = element.style;
      const weight = style?.fontWeight;
      if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) next.add("strong");
      else if (weight && (weight === "normal" || /^\d+$/.test(weight))) next.delete("strong");
      if (/^(italic|oblique)/.test(style?.fontStyle ?? "")) next.add("em");
      else if (style?.fontStyle === "normal") next.delete("em");
      const decoration = style?.textDecorationLine || style?.textDecoration || "";
      if (/\bunderline\b/.test(decoration)) next.add("underline");
      if (/\bline-through\b/.test(decoration)) next.add("strike");
      if (tag === "a") {
        const url = safeLink(element.getAttribute("href") ?? "");
        if (url) {
          let token = links.get(url);
          if (!token) { token = `link:${crypto.randomUUID()}`; links.set(url, token); fields[token] = url; }
          for (const name of next) if (name.startsWith("link:")) next.delete(name);
          next.add(token);
        }
      }
      return [...next].sort();
    };
    const walk = (node: Node, inherited: readonly string[], depth: number) => {
      check(depth);
      if (node.nodeType === 3) { push(node.nodeValue ?? "", inherited); return; }
      if (node.nodeType !== 1) return;
      const element = node as HTMLElement, tag = element.tagName.toLowerCase();
      if (discarded.has(tag) || element === options.marker || (tag === "o:p" && options.dropOffice && !element.textContent?.trim())) return;
      if (tag === "br") { lineBreak(); return; }
      if (tag === "img") { push(element.getAttribute("alt") ?? "", inherited); return; }
      const names = marksAt(element, tag, inherited);
      const paragraphBreak = tag === "p" || tag === "div";
      if (paragraphBreak && s && !s.endsWith("\n")) lineBreak();
      for (const child of Array.from(element.childNodes)) walk(child, names, depth + 1);
      if (paragraphBreak && s && !s.endsWith("\n")) lineBreak();
      if (tag === "td" || tag === "th") push(" ", []);
    };
    const ancestors: HTMLElement[] = [];
    for (let element = nodes[0]?.parentElement; element; element = element.parentElement) ancestors.push(element);
    const inherited = ancestors.reverse().reduce<string[]>((names, element) => marksAt(element, element.tagName.toLowerCase(), names), []);
    for (const node of nodes) walk(node, inherited, depth + 1);
    if (!options.pre) {
      const end = s.search(/[ \n]+$/);
      if (end !== -1) { s = s.slice(0, end); marks.length = end; }
    }
    return { text: { s, marks }, ...(Object.keys(fields).length ? { fields } : {}) };
  }

  const textBlock = (type: string, nodes: readonly Node[], depth: number, fields: PasteBlock["fields"] = {}, options?: Parameters<typeof inline>[2]) => {
    const rendered = inline(nodes, depth, options);
    return count({ type, ...rendered, fields: { ...fields, ...rendered.fields }, children: [] });
  };

  function semanticList(element: Element, depth: number): PasteBlock[] {
    check(depth);
    const kind = element.localName === "ol" ? "number" : "bullet";
    return Array.from(element.children).flatMap(item => {
      if (item.localName !== "li") return [];
      const children = Array.from(item.childNodes);
      const nested = children.filter((child): child is Element => child.nodeType === 1 && /^(ol|ul)$/.test((child as Element).localName));
      const block = textBlock(list, children.filter(child => !nested.includes(child as Element)), depth, { kind });
      block.children = nested.flatMap(child => semanticList(child, depth + 1));
      return [block];
    });
  }

  function flow(nodes: readonly Node[], depth: number): PasteBlock[] {
    check(depth);
    const blocks: PasteBlock[] = [], pending: Node[] = [];
    const wordStack: { level: number; block: PasteBlock }[] = [];
    let wordKey: string | undefined;
    const flush = () => {
      if (!pending.length) return;
      const item = textBlock(paragraph, pending.splice(0), depth);
      if (item.text?.s) { blocks.push(item); wordKey = undefined; wordStack.length = 0; }
    };
    for (const node of nodes) {
      if (node.nodeType !== 1) { pending.push(node); continue; }
      const element = node as HTMLElement, tag = element.tagName.toLowerCase();
      if (discarded.has(tag)) continue;
      const word = tag === "p" ? wordList(element) : undefined;
      if (word) {
        flush();
        if (word.key !== wordKey) wordStack.length = 0;
        wordKey = word.key;
        while (wordStack.length && wordStack.at(-1)!.level >= word.level) wordStack.pop();
        const item = textBlock(list, Array.from(element.childNodes), depth, { kind: word.kind }, { marker: word.marker, dropOffice: true });
        (wordStack.at(-1)?.block.children ?? blocks).push(item);
        wordStack.push({ level: word.level, block: item });
        continue;
      }
      if (!element.matches(flowSelector) && !element.querySelector(flowSelector)) { pending.push(node); continue; }
      flush();
      wordKey = undefined; wordStack.length = 0;
      if (tag === "ul" || tag === "ol") { blocks.push(...semanticList(element, depth + 1)); continue; }
      if (tag === "hr") { blocks.push(count({ type: "nooq.divider/v1", children: [] })); continue; }
      const heading = /^h([1-6])$/.exec(tag);
      if (!heading && !["p", "blockquote", "pre", "tr"].includes(tag) && element.querySelector(flowSelector)) {
        blocks.push(...flow(Array.from(element.childNodes), depth + 1)); continue;
      }
      const type = heading ? "nooq.heading/v1" : tag === "blockquote" ? "nooq.quote/v1" : paragraph;
      const office = !!element.getElementsByTagName("o:p").length;
      const block = textBlock(type, Array.from(element.childNodes), depth, heading ? { level: Number(heading[1]) } : {},
        { dropOffice: office, pre: tag === "pre" });
      if (!office || block.text?.s.trim()) blocks.push(block);
    }
    flush();
    return blocks;
  }

  try {
    const blocks = flow(Array.from(template.content.childNodes), 0);
    return blocks.some(block => block.type !== paragraph || block.text?.s) ? blocks : undefined;
  } catch (error) {
    if (error instanceof RangeError) return;
    throw error;
  }
}
