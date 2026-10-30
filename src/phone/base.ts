import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_MAX_EDGE } from '../config.js';
import { Recording } from '../flow/recording.js';
import { matchSelector, percentPoint, selectorFor, textPattern, type Selector } from '../flow/selectors.js';
import { sleep } from '../util/exec.js';
import { findByText, type UiElement, type UiSnapshot } from './ui.js';

export type Platform = 'android' | 'ios';
export type Direction = 'up' | 'down' | 'left' | 'right';
export type Box = [number, number, number, number];

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
}

export interface Target {
  ref?: number;
  text?: string;
  x?: number;
  y?: number;
}

export interface LogOptions {
  pkg?: string;
  level?: string;
  lines?: number;
  crashes?: boolean;
  clear?: boolean;
}

/** Keys the agent can press. Each platform supports the ones its hardware has. */
export const KEY_NAMES = [
  'back', 'home', 'recents', 'enter', 'delete', 'backspace', 'tab', 'escape', 'space',
  'menu', 'search', 'power', 'volume_up', 'volume_down', 'up', 'down', 'left', 'right',
];

/** How our key names are written in Maestro flows. */
const MAESTRO_KEYS: Record<string, string> = {
  home: 'Home',
  enter: 'Enter',
  delete: 'Backspace',
  backspace: 'Backspace',
  tab: 'Tab',
  power: 'Lock',
  volume_up: 'Volume Up',
  volume_down: 'Volume Down',
};

/**
 * A phone as the agent sees it, whatever the platform.
 *
 * Every coordinate the agent sends or receives is in screenshot pixels: screenshots are
 * scaled so the long edge is at most SCREENSHOT_MAX_EDGE, and this class converts to the
 * platform's UI units (pixels on Android, points on iOS).
 *
 * While a test recording is active, each action is also written down as a Maestro
 * command with a selector that will find the same element again.
 */
export abstract class PhoneBase {
  abstract readonly platform: Platform;
  abstract readonly id: string;
  /** App id of the system Settings app, so agents can just say "settings". */
  protected abstract readonly settingsApp: string;

  recording?: Recording;
  protected elements: UiElement[] = [];
  protected last?: UiSnapshot;
  /** Screen size in UI units. */
  protected screen?: { w: number; h: number };
  /** Screenshot pixels per UI unit: 1 on Android, 2 or 3 on iOS. */
  protected pixelRatio = 1;

  // ---- what each platform provides (all coordinates in UI units) ----

  protected abstract dumpUi(): Promise<UiSnapshot>;
  /** A screenshot whose long edge is at most maxEdge pixels. */
  protected abstract capture(maxEdge: number): Promise<Screenshot>;
  abstract tapDevicePoint(x: number, y: number, long?: boolean): Promise<void>;
  /** Type into whatever has focus. */
  abstract inputText(text: string): Promise<void>;
  abstract erase(count: number): Promise<void>;
  /** Press one of KEY_NAMES; throws if this phone has no such key. */
  abstract pressKey(name: string): Promise<void>;
  /** Drag and hold still before lifting, so lists move exactly as far as the finger. */
  abstract dragDevice(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  abstract swipeDevice(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  protected abstract launch(appId: string, fresh: boolean): Promise<void>;
  protected abstract openLink(url: string): Promise<void>;
  protected abstract stopApp(appId: string): Promise<void>;
  protected abstract clearApp(appId: string): Promise<void>;
  protected abstract uninstallApp(appId: string): Promise<void>;
  abstract install(file: string): Promise<string>;
  abstract packages(): Promise<string[]>;
  abstract logs(opts: LogOptions): Promise<string>;
  /** Crash reports since the last check. */
  abstract newCrashes(): Promise<string | undefined>;
  abstract shell(command: string): Promise<string>;
  /** Make the phone predictable for automation. */
  abstract prepare(): Promise<void>;

  // ---- coordinates ----

  /** Screenshot pixels per UI unit. */
  protected get scale(): number {
    if (!this.screen) return 1;
    const pixels = Math.max(this.screen.w, this.screen.h) * this.pixelRatio;
    return Math.min(1, SCREENSHOT_MAX_EDGE / pixels) * this.pixelRatio;
  }

  protected toScreen(v: number): number {
    return Math.round(v * this.scale);
  }

  protected toDevice(v: number): number {
    return Math.round(v / this.scale);
  }

  // ---- reading the screen ----

  async ui(): Promise<UiSnapshot> {
    const snap = await this.dumpUi();
    this.last = snap;
    this.elements = snap.elements;
    this.screen = { w: snap.width, h: snap.height };
    return snap;
  }

  async screenshot(): Promise<Screenshot> {
    return this.capture(SCREENSHOT_MAX_EDGE);
  }

  /** The platform starts reporting "booted" a few seconds before the home screen is drawn. */
  async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.ui().catch(() => undefined);
      if (snap?.pkg && snap.elements.length > 0) return;
      await sleep(1000);
    }
  }

  describe(snap: UiSnapshot): string {
    const lines = [`App: ${snap.pkg || 'unknown'} · screen ${this.toScreen(snap.width)}x${this.toScreen(snap.height)}`];
    const shown = snap.windows.filter((w) => w.elements.length > 0);
    shown.forEach((w, i) => {
      if (shown.length > 1) {
        const name = w.type === 'TYPE_INPUT_METHOD' ? `Keyboard (${w.pkg})` : w.pkg || w.type;
        lines.push(`-- ${name}${i === shown.length - 1 ? ' (on top)' : ''} --`);
      }
      for (const e of w.elements) {
        const [x1, y1, x2, y2] = e.bounds;
        const parts = [`[${e.ref}] ${e.kind}`];
        if (e.label) parts.push(JSON.stringify(e.label));
        if (e.id) parts.push(`id=${e.id}`);
        parts.push(...e.flags);
        parts.push(`@${this.toScreen((x1 + x2) / 2)},${this.toScreen((y1 + y2) / 2)}`);
        lines.push(parts.join(' '));
      }
    });
    if (snap.elements.length === 0) lines.push('(no readable elements; take a screenshot to see the screen)');
    return lines.join('\n');
  }

  /** What the agent sees after every action: any new crash, then the current screen. */
  async observe(settleMs = 500): Promise<string> {
    await sleep(settleMs);
    const crash = await this.newCrashes().catch(() => undefined);
    let screen: string;
    try {
      screen = this.describe(await this.ui());
    } catch (e: any) {
      screen = e.message;
    }
    return crash ? `CRASH DETECTED:\n${crash}\n\n${screen}` : screen;
  }

  // ---- acting on the screen ----

  private async ensureScreen(): Promise<void> {
    if (!this.screen) await this.ui();
  }

  private async resolve(t: Target): Promise<{ x: number; y: number; what: string; element?: UiElement }> {
    let element: UiElement | undefined;
    if (t.ref !== undefined) {
      element = this.elements.find((e) => e.ref === t.ref);
      if (!element) throw new Error(`There is no element [${t.ref}] on the last screen read. Read the screen again for fresh numbers.`);
    } else if (t.text) {
      // The agent usually acts on the screen it was just shown, so try that before re-reading.
      element = findByText(this.elements, t.text);
      if (!element) {
        const snap = await this.ui();
        element = findByText(snap.elements, t.text);
        if (!element) throw new Error(`Nothing on screen matches "${t.text}".\n\n${this.describe(snap)}`);
      }
    }
    if (element) {
      const [x1, y1, x2, y2] = element.bounds;
      const label = element.label ? ` "${element.label}"` : '';
      return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2), what: `[${element.ref}] ${element.kind}${label}`, element };
    }
    if (t.x !== undefined && t.y !== undefined) {
      await this.ensureScreen();
      return { x: this.toDevice(t.x), y: this.toDevice(t.y), what: `(${t.x}, ${t.y})` };
    }
    throw new Error('Say what to act on: ref (number from the screen list), text (visible text), or x and y.');
  }

  /** The selector a recording should use for a resolved target. */
  private selectorOf(p: { x: number; y: number; element?: UiElement }): Selector {
    if (p.element && this.last) return selectorFor(p.element, this.last);
    return { point: percentPoint(p.x, p.y, this.screen?.w ?? 1, this.screen?.h ?? 1) };
  }

  async tap(t: Target, long = false): Promise<string> {
    const p = await this.resolve(t);
    const selector = this.selectorOf(p);
    await this.tapDevicePoint(p.x, p.y, long);
    this.recording?.act(long ? 'longPressOn' : 'tapOn', selector);
    return `${long ? 'Long-pressed' : 'Tapped'} ${p.what}`;
  }

  protected static checkTypable(text: string): void {
    if (/[^\x20-\x7e\n]/.test(text)) {
      throw new Error('Only plain ASCII text can be typed for now (no emoji or accented letters).');
    }
  }

  async type(text: string, opts: Target & { clear?: boolean; submit?: boolean }): Promise<string> {
    PhoneBase.checkTypable(text);
    let what = 'the focused field';
    let field: UiElement | undefined;
    if (opts.ref !== undefined || opts.text || opts.x !== undefined) {
      const p = await this.resolve(opts);
      const selector = this.selectorOf(p);
      await this.tapDevicePoint(p.x, p.y);
      this.recording?.act('tapOn', selector);
      await sleep(300);
      what = p.what;
      field = p.element;
    }
    if (opts.clear) {
      const count = Math.max(field?.textLength ?? 0, field ? 0 : 64);
      await this.erase(count);
      if (count > 0) this.recording?.add({ eraseText: count });
    }
    await this.inputText(text);
    text.split('\n').forEach((line, i, all) => {
      if (line) this.recording?.add({ inputText: line });
      if (i < all.length - 1) this.recording?.add({ pressKey: 'Enter' });
    });
    if (opts.submit) {
      await this.pressKey('enter');
      this.recording?.add({ pressKey: 'Enter' });
    }
    return `Typed ${JSON.stringify(text)} into ${what}${opts.submit ? ' and pressed Enter' : ''}`;
  }

  /** Scroll so content further in `direction` comes into view, within a box (default: whole screen). */
  async scrollDevice(direction: Direction, box?: Box): Promise<void> {
    await this.ensureScreen();
    const b = box ?? [0, 0, this.screen!.w, this.screen!.h];
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const dx = (b[2] - b[0]) * 0.25;
    const dy = (b[3] - b[1]) * 0.25;
    const moves = {
      down: [cx, cy + dy, cx, cy - dy],
      up: [cx, cy - dy, cx, cy + dy],
      right: [cx + dx, cy, cx - dx, cy],
      left: [cx - dx, cy, cx + dx, cy],
    } as const;
    const [x1, y1, x2, y2] = moves[direction].map(Math.round);
    await this.dragDevice(x1, y1, x2, y2);
  }

  async scroll(direction: Direction, ref?: number): Promise<string> {
    let element: UiElement | undefined;
    if (ref !== undefined) {
      element = this.elements.find((el) => el.ref === ref);
      if (!element) throw new Error(`There is no element [${ref}] on the last screen read.`);
    }
    await this.scrollDevice(direction, element?.bounds);
    if (this.recording) {
      // Maestro's swipe direction is the finger's direction, the opposite of the scroll direction.
      const finger = { down: 'UP', up: 'DOWN', left: 'RIGHT', right: 'LEFT' }[direction];
      const from = element && this.last ? selectorFor(element, this.last) : undefined;
      const command = from ? { swipe: { from, direction: finger } } : direction === 'down' ? 'scroll' : { swipe: { direction: finger } };
      this.recording.scroll(direction, command);
    }
    return `Scrolled ${direction}${ref !== undefined ? ` inside [${ref}]` : ''}`;
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<string> {
    await this.ensureScreen();
    const [a, b, c, d] = [x1, y1, x2, y2].map((v) => this.toDevice(v));
    await this.swipeDevice(a, b, c, d, durationMs);
    if (this.recording && this.screen) {
      const { w, h } = this.screen;
      this.recording.add({ swipe: { start: percentPoint(a, b, w, h), end: percentPoint(c, d, w, h), duration: Math.round(durationMs) } });
    }
    return `Swiped from (${x1}, ${y1}) to (${x2}, ${y2})`;
  }

  async key(name: string): Promise<string> {
    const lower = name.toLowerCase();
    await this.pressKey(lower);
    this.recording?.add(lower === 'back' ? 'back' : { pressKey: MAESTRO_KEYS[lower] ?? name });
    return `Pressed ${name}`;
  }

  // ---- apps ----

  protected appIdOf(target: string): string {
    return target.toLowerCase() === 'settings' ? this.settingsApp : target;
  }

  /**
   * Open an app by its id (package name or bundle id), a URL / deep link, or "settings".
   * With fresh, the app starts on its launch screen rather than where it was left.
   */
  async open(target: string, fresh = false): Promise<string> {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      await this.openLink(target);
      this.recording?.add({ openLink: target });
      return `Opened ${target}`;
    }
    const appId = this.appIdOf(target);
    await this.launch(appId, fresh);
    // stopApp: false matches phone_open, which brings a running app forward rather than restarting it.
    this.recording?.add({ launchApp: { appId, stopApp: false } });
    return `Opened ${appId}`;
  }

  async appAction(action: 'stop' | 'clear' | 'uninstall', target: string): Promise<string> {
    const appId = this.appIdOf(target);
    if (action === 'stop') {
      await this.stopApp(appId);
      this.recording?.add({ stopApp: appId });
      return `Stopped ${appId}`;
    }
    if (action === 'clear') {
      await this.clearApp(appId);
      this.recording?.add({ clearState: appId });
      return `Cleared all data for ${appId}`;
    }
    await this.uninstallApp(appId);
    return `Uninstalled ${appId}`;
  }

  // ---- tests ----

  /** Restart the app from scratch and begin recording what the agent does as a test. */
  async startTest(app?: string, clearState = false): Promise<string> {
    const appId = app ? this.appIdOf(app) : (await this.ui()).pkg;
    if (!appId) throw new Error('Could not tell which app is open. Pass app (its package name or bundle id).');
    this.recording = undefined;
    await this.stopApp(appId);
    if (clearState) await this.clearApp(appId);
    await this.launch(appId, true);
    this.recording = new Recording(appId);
    this.recording.add({ launchApp: clearState ? { appId, clearState: true } : { appId } });
    return `Recording a test for ${appId}. It was restarted${clearState ? ' with its data cleared' : ''}, which is how the test will begin.`;
  }

  /** Check whether something is (or isn't) on screen, waiting briefly for it to settle. */
  async check(sel: Selector, visible: boolean, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = matchSelector(sel, (await this.ui()).nodes).length > 0;
      if (found === visible) return true;
      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
  }

  async assert(what: { text?: string; id?: string; checked?: boolean }, visible = true): Promise<{ ok: boolean; message: string }> {
    if (!what.text && !what.id) throw new Error('Pass text or id to check for.');
    const sel: Selector =
      what.id || what.checked !== undefined
        ? {
            ...(what.text ? { text: textPattern(what.text) } : {}),
            ...(what.id ? { id: what.id } : {}),
            ...(what.checked !== undefined ? { checked: what.checked } : {}),
          }
        : textPattern(what.text!);
    const label = [what.text && `"${what.text}"`, what.id && `id=${what.id}`, what.checked !== undefined && (what.checked ? '(on)' : '(off)')]
      .filter(Boolean)
      .join(' ');
    const ok = await this.check(sel, visible);
    if (ok) this.recording?.add({ [visible ? 'assertVisible' : 'assertNotVisible']: sel });
    const state = visible ? 'is visible' : 'is not visible';
    const recorded = ok && this.recording ? ' Added to the test.' : '';
    return { ok, message: ok ? `Check passed: ${label} ${state}.${recorded}` : `Check FAILED: expected ${label} ${state}, but it ${visible ? 'is not' : 'is'}.` };
  }

  saveTest(name: string, file: string): { file: string; yaml: string; steps: number } {
    if (!this.recording) throw new Error('No test is being recorded. Start one with phone_test_start.');
    const yaml = this.recording.toYaml(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml);
    return { file, yaml, steps: this.recording.length };
  }
}
