/**
 * A tiny element builder. Components return real DOM nodes so they work in
 * ProseMirror node views and decorations, and inside any framework.
 */

export type Child = Node | string | number | false | null | undefined | readonly Child[];

type Listener = (event: Event) => void;
export type Attrs = {
  class?: string | false | null | undefined | readonly (string | false | null | undefined)[];
  /** Inline style; custom properties (`--nq-peer`) included. */
  style?: Record<string, string>;
} & Record<string, unknown>;

export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyAttrs(node: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      const cls = Array.isArray(value) ? cx(...value) : String(value);
      if (cls) node.setAttribute("class", cls);
    } else if (key === "style") {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) (node as HTMLElement).style.setProperty(prop, v);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as Listener);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}
