// The web demo's vocabulary, the same as the iOS helper's (resources/ios/Doomship.swift): each
// call logs an event with the wall-clock time, which the screencast's frames share, so captions,
// tap rings and zooms line up with the recording. Positions are CSS pixels.
import type { Locator, Page } from 'playwright-core';
import type { Event } from '../ios/record.ts';

/** An event as logged, with an absolute time (seconds since the epoch). */
export type Marker = Omit<Event, 't' | 't0'> & { t: number; t0?: number };

const now = () => Date.now() / 1000;

export class Demo {
  readonly markers: Marker[] = [];
  private page: Page;
  private touch: boolean;
  private fresh: () => Promise<void>;
  /** `fresh` resolves once the recording has a frame captured after the call. */
  constructor(page: Page, touch: boolean, fresh: () => Promise<void> = async () => {}) {
    this.page = page;
    this.touch = touch;
    this.fresh = fresh;
  }

  private mark(m: Omit<Marker, 't'>) {
    this.markers.push({ ...m, t: now() } as Marker);
  }

  private async box(element: Locator) {
    await element.scrollIntoViewIfNeeded();
    const b = await element.boundingBox();
    if (!b) throw new Error(`${element} is not visible, so there is nothing to point at`);
    return b;
  }

  /** Starts the GIF here: call it once the first screen of the demo is up. */
  async begin() {
    // A heavy page can stall screenshots while it loads; the GIF must not start before the frames do.
    await this.fresh();
    const v = this.page.viewportSize()!;
    this.mark({ event: 'begin', w: v.width, h: v.height });
  }

  /** Shows this text in the band above the screen until the next caption. */
  async caption(text: string) {
    this.mark({ event: 'caption', text });
  }

  /** Taps (or, on a desktop, clicks) the element's centre and draws a ring there. */
  async tap(element: Locator) {
    const b = await this.box(element);
    const t0 = now();
    if (this.touch) await element.tap();
    else await element.click();
    this.markers.push({ event: 'tap', x: b.x + b.width / 2, y: b.y + b.height / 2, t0, t: now() });
  }

  /** Points at a new or changed element: the GIF zooms in on it, outlined, while this holds. */
  async show(element: Locator, seconds = 1.5) {
    const b = await this.box(element);
    this.mark({ event: 'show', x: b.x, y: b.y, w: b.width, h: b.height, seconds });
    await this.page.waitForTimeout(seconds * 1000);
  }

  /** Keeps the screen still, so a viewer can read it. */
  async hold(seconds: number) {
    this.mark({ event: 'hold', seconds });
    await this.page.waitForTimeout(seconds * 1000);
  }

  /** Ends the GIF here: call it after holding on the result. */
  async end() {
    this.mark({ event: 'end' });
  }
}
