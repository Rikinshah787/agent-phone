import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_MAX_EDGE } from '../config.js';
import { Recording } from '../flow/recording.js';
import { matchSelector, percentPoint, selectorFor, textPattern, type Selector } from '../flow/selectors.js';
import { shq, sleep } from '../util/exec.js';
import { downscale, encodePng } from '../util/png.js';
import type { Adb } from './adb.js';
import { findByText, parseUi, type UiElement, type UiSnapshot } from './ui.js';

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

const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  delete: 'KEYCODE_DEL',
  backspace: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB',
  escape: 'KEYCODE_ESCAPE',
  space: 'KEYCODE_SPACE',
  menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH',
  power: 'KEYCODE_POWER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
};

export const KEY_NAMES = Object.keys(KEYS);

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

const UI_DUMP = '/data/local/tmp/agent-phone-ui.xml';
const SCREEN_RAW = '/data/local/tmp/agent-phone-screen.raw';

/**
 * One Android device (emulator or USB phone) as the agent sees it.
 *
 * Every coordinate the agent sends or receives is in screenshot pixels: the
 * screenshot is scaled down so its long edge is at most SCREENSHOT_MAX_EDGE, and
 * this class converts to real device pixels.
 *
 * While a test recording is active, each action is also written down as a Maestro
 * command with a selector that will find the same element again.
 */
export class Device {
  private elements: UiElement[] = [];
  private last?: UiSnapshot;
  private screen?: { w: number; h: number };
  private crashLines = -1;
  private allWindows = true;
  recording?: Recording;

  constructor(
    private readonly adb: Adb,
    readonly serial: string,
  ) {}

  private get scale(): number {
    return this.screen ? Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(this.screen.w, this.screen.h)) : 1;
  }

  private toScreen(v: number): number {
    return Math.round(v * this.scale);
  }

  private toDevice(v: number): number {
    return Math.round(v / this.scale);
  }

  async sh(command: string, timeoutMs?: number): Promise<string> {
    return (await this.adb.shell(this.serial, command, timeoutMs)).out;
  }

  /**
   * Make the device predictable for automation: no animations, screen always on, unlocked,
   * and no on-screen keyboard (typing goes through the emulator's hardware keyboard), which
   * also stops Gboard's stylus tutorial from popping up over apps.
   */
  async prepare(): Promise<void> {
    await this.sh(
      [
        'settings put global window_animation_scale 0',
        'settings put global transition_animation_scale 0',
        'settings put global animator_duration_scale 0',
        'settings put secure show_ime_with_hard_keyboard 0',
        'settings put secure stylus_handwriting_enabled 0',
        'settings put system screen_off_timeout 2147483647',
        'svc power stayon true',
        'input keyevent KEYCODE_WAKEUP',
        'wm dismiss-keyguard',
      ].join('; '),
    );
    await this.newCrashes();
  }

  /** Android reports "boot completed" a few seconds before the home screen is drawn. */
  async waitUntilReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.ui().catch(() => undefined);
      if (snap?.pkg && snap.elements.length > 0) return;
      await sleep(1000);
    }
  }

  // ---- reading the screen ----

  async ui(): Promise<UiSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // --windows (undocumented) includes dialogs, popups and the keyboard; older Androids lack it.
      // The old dump is removed first so a failed dump can't return a stale screen.
      const flag = this.allWindows ? '--windows ' : '';
      const out = await this.sh(`rm -f ${UI_DUMP}; uiautomator dump ${flag}${UI_DUMP} >/dev/null 2>&1; cat ${UI_DUMP}`, 20_000);
      const start = out.search(/<displays|<hierarchy/);
      if (start >= 0) {
        const snap = parseUi(out.slice(start));
        this.last = snap;
        this.elements = snap.elements;
        this.screen = { w: snap.width, h: snap.height };
        return snap;
      }
      if (this.allWindows && attempt === 0) this.allWindows = false;
      await sleep(700);
    }
    throw new Error("Couldn't read the screen layout (the app may be animating non-stop). Take a screenshot instead.");
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

  async screenshot(): Promise<Screenshot> {
    // Writing to a file then reading it back is ~2x faster than streaming screencap's stdout.
    const raw = await this.adb.execOut(this.serial, `screencap ${SCREEN_RAW} && cat ${SCREEN_RAW}`, 30_000);
    const w = raw.readUInt32LE(0);
    const h = raw.readUInt32LE(4);
    const header = raw.length - w * h * 4;
    if (w <= 0 || h <= 0 || header < 12 || header > 32) {
      // Unusual pixel format: fall back to the device's own PNG at full size.
      const png = await this.adb.execOut(this.serial, 'screencap -p', 30_000);
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    }
    this.screen = { w, h };
    const ow = this.toScreen(w);
    const oh = this.toScreen(h);
    const rgb = downscale(raw.subarray(header), w, h, ow, oh);
    return { png: encodePng(rgb, ow, oh), width: ow, height: oh };
  }

  /** What the agent sees after every action: any new crash, then the current screen. */
  async observe(settleMs = 500): Promise<string> {
    await sleep(settleMs);
    const crash = await this.newCrashes();
    let screen: string;
    try {
      screen = this.describe(await this.ui());
    } catch (e: any) {
      screen = e.message;
    }
    return crash ? `CRASH DETECTED:\n${crash}\n\n${screen}` : screen;
  }

  /** Lines added to the crash log buffer since the last check. */
  async newCrashes(): Promise<string | undefined> {
    const lines = (await this.sh('logcat -d -b crash')).split('\n').filter((l) => l.trim());
    const before = this.crashLines;
    this.crashLines = lines.length;
    if (before < 0 || lines.length <= before) return undefined;
    return lines.slice(before, before + 40).join('\n');
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

  /** Tap at real device pixels. Used by the flow runner. */
  async tapDevicePoint(x: number, y: number, long = false): Promise<void> {
    await this.sh(long ? `input swipe ${x} ${y} ${x} ${y} 800` : `input tap ${x} ${y}`);
  }

  async tap(t: Target, long = false): Promise<string> {
    const p = await this.resolve(t);
    this.recording?.act(long ? 'longPressOn' : 'tapOn', this.selectorOf(p));
    await this.tapDevicePoint(p.x, p.y, long);
    return `${long ? 'Long-pressed' : 'Tapped'} ${p.what}`;
  }

  private static checkTypable(text: string): void {
    if (/[^\x20-\x7e\n]/.test(text)) {
      throw new Error('Only plain ASCII text can be typed for now (no emoji or accented letters).');
    }
  }

  /** Type into whatever has focus. */
  async inputText(text: string): Promise<void> {
    Device.checkTypable(text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.sh(`input text ${shq(lines[i].replace(/ /g, '%s'))}`);
      if (i < lines.length - 1) await this.sh('input keyevent KEYCODE_ENTER');
    }
  }

  async erase(count: number): Promise<void> {
    if (count > 0) await this.sh(`input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(count)}`);
  }

  async type(text: string, opts: Target & { clear?: boolean; submit?: boolean }): Promise<string> {
    Device.checkTypable(text);
    let what = 'the focused field';
    let field: UiElement | undefined;
    if (opts.ref !== undefined || opts.text || opts.x !== undefined) {
      const p = await this.resolve(opts);
      this.recording?.act('tapOn', this.selectorOf(p));
      await this.tapDevicePoint(p.x, p.y);
      await sleep(300);
      what = p.what;
      field = p.element;
    }
    if (opts.clear) {
      const count = Math.max(field?.textLength ?? 0, field ? 0 : 64);
      this.recording?.add({ eraseText: count });
      await this.erase(count);
    }
    text.split('\n').forEach((line, i, all) => {
      if (line) this.recording?.add({ inputText: line });
      if (i < all.length - 1) this.recording?.add({ pressKey: 'Enter' });
    });
    await this.inputText(text);
    if (opts.submit) {
      this.recording?.add({ pressKey: 'Enter' });
      await this.sh('input keyevent KEYCODE_ENTER');
    }
    return `Typed ${JSON.stringify(text)} into ${what}${opts.submit ? ' and pressed Enter' : ''}`;
  }

  /** Drag between two points in real device pixels. Used by the flow runner. */
  async swipeDevice(x1: number, y1: number, x2: number, y2: number, durationMs = 400): Promise<void> {
    await this.sh(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.round(durationMs)}`);
  }

  /**
   * Drag a finger and hold still before lifting it, so lists move exactly as far as the
   * finger did. `input swipe` lifts while moving, which flings the list an unpredictable
   * distance; that makes scrolls overshoot and recorded tests flaky.
   */
  async dragDevice(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const pts = [0, 1 / 3, 2 / 3, 1].map((t) => [Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)]);
    const moves = pts.slice(1).map(([x, y]) => `input motionevent MOVE ${x} ${y}`);
    const out = await this.sh(
      [`input motionevent DOWN ${pts[0][0]} ${pts[0][1]}`, ...moves, 'sleep 0.25', `input motionevent UP ${x2} ${y2}`].join('; '),
    );
    // Android 9 and older have no `input motionevent`; a slow swipe is the closest substitute.
    if (/usage|unknown|error/i.test(out)) await this.swipeDevice(x1, y1, x2, y2, 1500);
  }

  /** Scroll so content further in `direction` comes into view, within a box (default: whole screen). */
  async scrollDevice(direction: 'up' | 'down' | 'left' | 'right', box?: [number, number, number, number]): Promise<void> {
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
    const [x1, y1, x2, y2] = moves[direction];
    await this.dragDevice(x1, y1, x2, y2);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', ref?: number): Promise<string> {
    let element: UiElement | undefined;
    if (ref !== undefined) {
      element = this.elements.find((el) => el.ref === ref);
      if (!element) throw new Error(`There is no element [${ref}] on the last screen read.`);
    }
    if (this.recording) {
      // Maestro's swipe direction is the finger's direction, the opposite of the scroll direction.
      const finger = { down: 'UP', up: 'DOWN', left: 'RIGHT', right: 'LEFT' }[direction];
      const from = element && this.last ? selectorFor(element, this.last) : undefined;
      const command = from ? { swipe: { from, direction: finger } } : direction === 'down' ? 'scroll' : { swipe: { direction: finger } };
      this.recording.scroll(direction, command);
    }
    await this.scrollDevice(direction, element?.bounds);
    return `Scrolled ${direction}${ref !== undefined ? ` inside [${ref}]` : ''}`;
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<string> {
    await this.ensureScreen();
    const [a, b, c, d] = [x1, y1, x2, y2].map((v) => this.toDevice(v));
    if (this.recording && this.screen) {
      const { w, h } = this.screen;
      this.recording.add({ swipe: { start: percentPoint(a, b, w, h), end: percentPoint(c, d, w, h), duration: Math.round(durationMs) } });
    }
    await this.swipeDevice(a, b, c, d, durationMs);
    return `Swiped from (${x1}, ${y1}) to (${x2}, ${y2})`;
  }

  async key(name: string): Promise<string> {
    const lower = name.toLowerCase();
    const code = KEYS[lower] ?? (/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(name) ? name : undefined);
    if (!code) throw new Error(`Unknown key "${name}". Use one of: ${KEY_NAMES.join(', ')}, or any KEYCODE_* name.`);
    this.recording?.add(lower === 'back' ? 'back' : { pressKey: MAESTRO_KEYS[lower] ?? name });
    await this.sh(`input keyevent ${code}`);
    return `Pressed ${name}`;
  }

  // ---- apps ----

  private static appIdOf(target: string): string {
    return target.toLowerCase() === 'settings' ? 'com.android.settings' : target;
  }

  /**
   * Open an app by package name, a URL / deep link, or "settings". With fresh, the app's
   * task is cleared so it starts on its launch screen, even if screens from other apps
   * were stacked on top of it.
   */
  async open(target: string, fresh = false): Promise<string> {
    const isLink = /^[a-z][a-z0-9+.-]*:/i.test(target);
    let out: string;
    if (isLink) {
      this.recording?.add({ openLink: target });
      out = await this.sh(`am start -W -a android.intent.action.VIEW -d ${shq(target)}`);
    } else {
      const appId = Device.appIdOf(target);
      const activity = (
        await this.sh(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shq(appId)}`)
      )
        .trim()
        .split('\n')
        .pop()
        ?.trim();
      if (!activity || !activity.includes('/')) {
        throw new Error(`No launchable app with package "${appId}" is installed. List installed apps to check the name.`);
      }
      // stopApp: false matches phone_open, which brings a running app forward rather than restarting it.
      this.recording?.add({ launchApp: { appId, stopApp: false } });
      // 0x10008000 = FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK
      out = await this.sh(`am start -W ${fresh ? '-f 0x10008000 ' : ''}-n ${shq(activity)}`);
    }
    if (/Error|Exception|unable to resolve/i.test(out)) throw new Error(`Could not open ${target}:\n${out.trim()}`);
    return `Opened ${target}`;
  }

  async packages(): Promise<string[]> {
    return (await this.sh('pm list packages -3'))
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort();
  }

  async install(apkPath: string): Promise<string> {
    const abs = path.resolve(apkPath);
    if (!fs.existsSync(abs)) throw new Error(`No file at ${abs}`);
    const before = new Set(await this.packages());
    // -r reinstall keeping data, -t allow debug/test builds, -g grant runtime permissions.
    const r = await this.adb.run(['-s', this.serial, 'install', '-r', '-t', '-g', abs], 300_000);
    const out = `${r.stdout.toString('utf8')}\n${r.stderr}`.trim();
    if (!/Success/.test(out)) throw new Error(`Install failed:\n${out}`);
    const added = (await this.packages()).filter((p) => !before.has(p));
    return added.length ? `Installed ${added.join(', ')}` : `Installed ${path.basename(abs)} (updated an existing app)`;
  }

  async appAction(action: 'stop' | 'clear' | 'uninstall', target: string): Promise<string> {
    const pkg = Device.appIdOf(target);
    const commands = {
      stop: `am force-stop ${shq(pkg)}`,
      clear: `pm clear ${shq(pkg)}`,
      uninstall: `pm uninstall ${shq(pkg)}`,
    };
    const r = await this.adb.shell(this.serial, commands[action]);
    const out = `${r.out}${r.err}`.trim();
    if (r.code !== 0 || /Failure|Error/i.test(out)) throw new Error(`Could not ${action} ${pkg}: ${out || `exit code ${r.code}`}`);
    if (action === 'stop') this.recording?.add({ stopApp: pkg });
    if (action === 'clear') this.recording?.add({ clearState: pkg });
    const done = { stop: 'Stopped', clear: 'Cleared all data for', uninstall: 'Uninstalled' };
    return `${done[action]} ${pkg}`;
  }

  // ---- tests ----

  /** Restart the app from scratch and begin recording what the agent does as a test. */
  async startTest(app?: string, clearState = false): Promise<string> {
    const appId = app ? Device.appIdOf(app) : (await this.ui()).pkg;
    if (!appId) throw new Error('Could not tell which app is open. Pass app (a package name).');
    this.recording = undefined;
    await this.appAction('stop', appId);
    if (clearState) await this.appAction('clear', appId);
    await this.open(appId, true);
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

  async logs(opts: { pkg?: string; level?: string; lines?: number; crashes?: boolean; clear?: boolean }): Promise<string> {
    if (opts.clear) {
      await this.sh('logcat -c');
      this.crashLines = 0;
      return 'Cleared the device log.';
    }
    const lines = opts.lines ?? 150;
    const args = ['logcat', '-d', '-v', 'time'];
    if (opts.crashes) args.push('-b', 'crash');
    let grep: string | undefined;
    if (opts.pkg) {
      const pid = (await this.sh(`pidof ${shq(opts.pkg)}`)).trim().split(/\s+/)[0];
      if (pid) args.push(`--pid=${pid}`);
      else grep = opts.pkg;
    }
    // logcat's -t counts lines before level and name filters apply, so read further back
    // when filtering and keep the matching tail ourselves.
    const filtered = grep !== undefined || opts.level !== undefined;
    args.push('-t', String(filtered ? Math.max(lines * 20, 5000) : lines));
    if (opts.level) args.push(shq(`*:${opts.level.toUpperCase()[0]}`));
    let out = (await this.sh(args.join(' '), 60_000))
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('--------- beginning of'));
    if (grep) out = out.filter((l) => l.includes(grep!));
    const text = out.slice(-lines).join('\n').trim();
    if (!text) return opts.pkg ? `No log lines for ${opts.pkg}${grep ? ' (the app is not running)' : ''}.` : 'The log is empty.';
    return text.length > 20_000 ? `…(earlier lines cut)\n${text.slice(-20_000)}` : text;
  }
}
