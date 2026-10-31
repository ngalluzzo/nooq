/**
 * The lab driver (EXPERIENCE-BUDGETS.md EB-2.1). Every browser call the
 * budgets make goes through this module, so the driver can change
 * (Bun.WebView is experimental) without touching a test.
 */

/** One Chrome DevTools Protocol trace event, as Chrome reports it. */
export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  pid: number;
  tid: number;
  dur?: number;
  id2?: { local?: string; global?: string };
  args?: Record<string, any>;
}

export interface LabOptions {
  /** EB-2: 4× CPU throttling. */
  throttle?: number;
  width?: number;
  height?: number;
  /** Delay (ms) or block requests by resource type before they reach the page (EB-5, EB-8). */
  requests?: Partial<Record<"Font" | "Fetch" | "XHR" | "WebSocket" | "Script", number | "block">>;
}

export interface Lab {
  view: Bun.WebView;
  browser: string;
  open(url: string): Promise<void>;
  evaluate<T>(script: string): Promise<T>;
  click(selector: string): Promise<void>;
  scrollTo(selector: string): Promise<void>;
  /** Trusted keystrokes through the input pipeline: keyDown then keyUp (EB-2.1). */
  press(key: string): Promise<void>;
  /** Run `during` while Chrome traces; returns every trace event. */
  trace(during: () => Promise<void>): Promise<TraceEvent[]>;
  close(): void;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  End: { code: "End", keyCode: 35 },
  " ": { code: "Space", keyCode: 32, text: " " },
};

function keyInfo(key: string): { code: string; keyCode: number; text?: string } {
  if (KEYS[key]) return KEYS[key]!;
  const upper = key.toUpperCase();
  return { code: /[a-z]/i.test(key) ? `Key${upper}` : "", keyCode: upper.charCodeAt(0), text: key };
}

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "benchmark",
  "cc",
  "input",
  "latencyInfo",
];

export async function openLab(options: LabOptions = {}): Promise<Lab> {
  const view = new Bun.WebView({
    backend: { type: "chrome", url: false, ...(process.env.BUN_CHROME_PATH ? { path: process.env.BUN_CHROME_PATH } : {}) },
    width: options.width ?? 1280,
    height: options.height ?? 800,
  });
  // The first navigation sets up the CDP session; everything below must precede the real page.
  await view.navigate("about:blank");
  const { product } = await view.cdp<{ product: string }>("Browser.getVersion");
  await view.cdp("Emulation.setCPUThrottlingRate", { rate: options.throttle ?? 4 });
  await view.cdp("Network.enable");
  await view.cdp("Network.setCacheDisabled", { cacheDisabled: true });

  const rules = Object.entries(options.requests ?? {});
  if (rules.length > 0) {
    view.addEventListener("Fetch.requestPaused", (event: Event) => {
      const { requestId, resourceType } = (event as MessageEvent<any>).data;
      const rule = options.requests?.[resourceType as keyof NonNullable<LabOptions["requests"]>];
      if (rule === "block") void view.cdp("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      else setTimeout(() => void view.cdp("Fetch.continueRequest", { requestId }), rule ?? 0);
    });
    await view.cdp("Fetch.enable", { patterns: rules.map(([resourceType]) => ({ resourceType, requestStage: "Request" })) });
  }

  return {
    view,
    browser: product,
    open: (url) => view.navigate(url),
    evaluate: (script) => view.evaluate(script),
    click: (selector) => view.click(selector),
    scrollTo: (selector) => view.scrollTo(selector, { block: "center" }),
    async press(key) {
      const { code, keyCode, text } = keyInfo(key);
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await view.cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      await view.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async trace(during) {
      const events: TraceEvent[] = [];
      let complete!: () => void;
      const done = new Promise<void>((resolve) => (complete = resolve));
      const collect = (event: Event) => events.push(...(event as MessageEvent<any>).data.value);
      view.addEventListener("Tracing.dataCollected", collect as EventListener);
      view.addEventListener("Tracing.tracingComplete", () => complete(), { once: true });
      await view.cdp("Tracing.start", { traceConfig: { includedCategories: TRACE_CATEGORIES }, transferMode: "ReportEvents" });
      await during();
      await view.cdp("Tracing.end");
      await done;
      view.removeEventListener("Tracing.dataCollected", collect);
      return events;
    },
    close: () => view.close(),
  };
}

/**
 * Keystroke-to-presentation latencies (EB-6), from Chrome's EventLatency
 * slices: input event creation to the frame that showed its effect.
 * A key press that never produced a frame has no slice; `missing` counts them.
 */
export function keystrokeLatencies(events: TraceEvent[], pressed: number): { latencies: number[]; missing: number; vsyncMs: number | undefined } {
  const begins = new Map<string, TraceEvent>();
  const latencies: number[] = [];
  let vsyncMs: number | undefined;
  for (const event of events) {
    if (event.name !== "EventLatency") continue;
    const key = `${event.pid}:${event.id2?.local ?? event.id2?.global}`;
    if (event.ph === "b") begins.set(key, event);
    else if (event.ph === "e") {
      const begin = begins.get(key);
      if (!begin || begin.args?.event_latency?.event_type !== "KEY_PRESSED") continue;
      vsyncMs ??= begin.args.event_latency.vsync_interval_ms;
      latencies.push((event.ts - begin.ts) / 1000);
    }
  }
  return { latencies, missing: Math.max(0, pressed - latencies.length), vsyncMs };
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? NaN) };
}

/** EB-2.1: every budget writes its numbers as JSON for the regression gate. */
export async function writeResult(name: string, result: unknown): Promise<void> {
  await Bun.write(new URL(`results/${name}.json`, import.meta.url), JSON.stringify(result, null, 2) + "\n");
}

export const FRAME_MS = 1000 / 60;
