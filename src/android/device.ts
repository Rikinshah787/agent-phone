import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_MAX_EDGE } from '../config.js';
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

const UI_DUMP = '/data/local/tmp/agent-phone-ui.xml';
const SCREEN_RAW = '/data/local/tmp/agent-phone-screen.raw';

/**
 * One Android device (emulator or USB phone) as the agent sees it.
 *
 * Every coordinate the agent sends or receives is in screenshot pixels: the
 * screenshot is scaled down so its long edge is at most SCREENSHOT_MAX_EDGE, and
 * this class converts to real device pixels.
 */
export class Device {
  private elements: UiElement[] = [];
  private screen?: { w: number; h: number };
  private crashLines = -1;
  private allWindows = true;

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
    snap.windows.forEach((w, i) => {
      if (snap.windows.length > 1) {
        const name = w.type === 'TYPE_INPUT_METHOD' ? `Keyboard (${w.pkg})` : w.pkg || w.type;
        lines.push(`-- ${name}${i === snap.windows.length - 1 ? ' (on top)' : ''} --`);
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

  async tap(t: Target, long = false): Promise<string> {
    const p = await this.resolve(t);
    await this.sh(long ? `input swipe ${p.x} ${p.y} ${p.x} ${p.y} 800` : `input tap ${p.x} ${p.y}`);
    return `${long ? 'Long-pressed' : 'Tapped'} ${p.what}`;
  }

  async type(text: string, opts: Target & { clear?: boolean; submit?: boolean }): Promise<string> {
    if (/[^\x20-\x7e\n]/.test(text)) {
      throw new Error('Only plain ASCII text can be typed for now (no emoji or accented letters).');
    }
    let what = 'the focused field';
    let field: UiElement | undefined;
    if (opts.ref !== undefined || opts.text || opts.x !== undefined) {
      const p = await this.resolve(opts);
      await this.sh(`input tap ${p.x} ${p.y}`);
      await sleep(300);
      what = p.what;
      field = p.element;
    }
    if (opts.clear) {
      const count = Math.max(field?.textLength ?? 0, field ? 0 : 64);
      if (count > 0) await this.sh(`input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(count)}`);
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.sh(`input text ${shq(lines[i].replace(/ /g, '%s'))}`);
      if (i < lines.length - 1) await this.sh('input keyevent KEYCODE_ENTER');
    }
    if (opts.submit) await this.sh('input keyevent KEYCODE_ENTER');
    return `Typed ${JSON.stringify(text)} into ${what}${opts.submit ? ' and pressed Enter' : ''}`;
  }

  /** Scroll so that content further in `direction` comes into view. */
  async scroll(direction: 'up' | 'down' | 'left' | 'right', ref?: number): Promise<string> {
    await this.ensureScreen();
    let box: [number, number, number, number] = [0, 0, this.screen!.w, this.screen!.h];
    if (ref !== undefined) {
      const e = this.elements.find((el) => el.ref === ref);
      if (!e) throw new Error(`There is no element [${ref}] on the last screen read.`);
      box = e.bounds;
    }
    const cx = Math.round((box[0] + box[2]) / 2);
    const cy = Math.round((box[1] + box[3]) / 2);
    const dx = Math.round((box[2] - box[0]) * 0.3);
    const dy = Math.round((box[3] - box[1]) * 0.3);
    const moves = {
      down: [cx, cy + dy, cx, cy - dy],
      up: [cx, cy - dy, cx, cy + dy],
      right: [cx + dx, cy, cx - dx, cy],
      left: [cx - dx, cy, cx + dx, cy],
    };
    await this.sh(`input swipe ${moves[direction].join(' ')} 400`);
    return `Scrolled ${direction}${ref !== undefined ? ` inside [${ref}]` : ''}`;
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<string> {
    await this.ensureScreen();
    const pts = [x1, y1, x2, y2].map((v) => this.toDevice(v));
    await this.sh(`input swipe ${pts.join(' ')} ${Math.round(durationMs)}`);
    return `Swiped from (${x1}, ${y1}) to (${x2}, ${y2})`;
  }

  async key(name: string): Promise<string> {
    const code = KEYS[name.toLowerCase()] ?? (/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(name) ? name : undefined);
    if (!code) throw new Error(`Unknown key "${name}". Use one of: ${KEY_NAMES.join(', ')}, or any KEYCODE_* name.`);
    await this.sh(`input keyevent ${code}`);
    return `Pressed ${name}`;
  }

  // ---- apps ----

  /** Open an app by package name, a URL / deep link, or "settings". */
  async open(target: string): Promise<string> {
    let out: string;
    if (target.toLowerCase() === 'settings') {
      out = await this.sh('am start -W -a android.settings.SETTINGS');
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      out = await this.sh(`am start -W -a android.intent.action.VIEW -d ${shq(target)}`);
    } else {
      const activity = (await this.sh(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shq(target)}`))
        .trim()
        .split('\n')
        .pop()
        ?.trim();
      if (!activity || !activity.includes('/')) {
        throw new Error(`No launchable app with package "${target}" is installed. List installed apps to check the name.`);
      }
      out = await this.sh(`am start -W -n ${shq(activity)}`);
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

  async appAction(action: 'stop' | 'clear' | 'uninstall', pkg: string): Promise<string> {
    const commands = {
      stop: `am force-stop ${shq(pkg)}`,
      clear: `pm clear ${shq(pkg)}`,
      uninstall: `pm uninstall ${shq(pkg)}`,
    };
    const r = await this.adb.shell(this.serial, commands[action]);
    const out = `${r.out}${r.err}`.trim();
    if (r.code !== 0 || /Failure|Error/i.test(out)) throw new Error(`Could not ${action} ${pkg}: ${out || `exit code ${r.code}`}`);
    const done = { stop: 'Stopped', clear: 'Cleared all data for', uninstall: 'Uninstalled' };
    return `${done[action]} ${pkg}`;
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
