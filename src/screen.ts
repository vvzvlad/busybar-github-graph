import { device } from "@shared/device";
import type { DisplayDrawParams } from "@busy-app/busy-lib";

/** One display element as DisplayDraw takes it. */
export type Element = DisplayDrawParams["elements"][number];

/** Front display of the app. */
export interface Screen {
  /** Draws a whole frame; elements of the previous frame that are not in it are cleared. */
  show(elements: Element[]): void;
  /** Stops drawing: frames asked for after this are dropped. */
  close(): void;
}

/** Whether two elements have the same fields with the same values; the app's elements hold plain values only. */
function same(a: Element | undefined, b: Element): boolean {
  if (a === undefined) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => x[key] === y[key]);
}

/** A picture with nothing in it: what an xpmbitmap is turned into to hide it. */
const NOTHING = ["! XPM2", "1 1 1 1", ". c none", "."].join("\n");

/**
 * The element made invisible, keeping its id and type: the firmware refuses to change the type under an id. Text
 * becomes fully transparent, pictures empty.
 */
function hidden(e: Element): Element {
  return (e.type === "xpmbitmap" ? { ...e, data: NOTHING } : { ...e, color: "#00000000" }) as Element;
}

/**
 * Keeps at most one display request in flight: a frame asked for while one is on its way waits, and a newer one
 * replaces it. Only the elements that changed since the last frame are sent: a blink redraws one pixel, not the graph.
 */
export function createScreen(app: string, report: (err: unknown) => void): Screen {
  /** What is on the displays now: element id → the element as sent; null when unknown. */
  let shown: Map<string, Element> | null = new Map();
  let next: Element[] | null = null;
  let busy = false;
  let closed = false;

  async function flush(): Promise<void> {
    busy = true;
    while (next && !closed) {
      const elements = next;
      next = null;
      const before = shown;
      // Until the requests are answered the screen is unknown: a failed one leaves it so, and the next frame starts over.
      shown = null;
      try {
        // Clearing by ids the display may not have would be refused whole: an unknown screen is cleared all at once.
        if (!before) await device.DisplayClear({ application_name: app });
        const ids = elements.map((e) => e.id);
        const gone = before ? [...before.values()].filter((e) => ids.indexOf(e.id) < 0) : [];
        const changed = before ? elements.filter((e) => !same(before.get(e.id), e)) : elements;
        // Drawn before the old ones are cleared, which are hidden in the same request: a view with none of the last
        // one's ids never shows over its remains, and the display is not left empty between the two.
        const sent = [...changed, ...gone.map(hidden)];
        if (sent.length > 0) await device.DisplayDraw({ application_name: app, priority: 50, elements: sent });
        if (gone.length > 0) await device.DisplayClear({ application_name: app, element_ids: gone.map((e) => e.id) });
        shown = new Map(elements.map((e): [string, Element] => [e.id, e]));
      } catch (err) {
        report(err);
      }
    }
    busy = false;
  }

  return {
    show(elements) {
      if (closed) return;
      next = elements;
      if (!busy) void flush();
    },
    close() {
      closed = true;
    },
  };
}
