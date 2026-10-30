import fs from 'node:fs';
import path from 'node:path';
import { PhoneBase, type LogOptions, type Screenshot } from '../phone/base.js';
import type { UiSnapshot } from '../phone/ui.js';
import { shq, sleep } from '../util/exec.js';
import { downscale, encodePng } from '../util/png.js';
import type { Adb } from './adb.js';
import { parseUi } from './ui.js';

const KEYCODES: Record<string, string> = {
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

const UI_DUMP = '/data/local/tmp/agent-phone-ui.xml';
const SCREEN_RAW = '/data/local/tmp/agent-phone-screen.raw';

/** An Android emulator or USB-connected phone, driven through adb. */
export class AndroidPhone extends PhoneBase {
  readonly platform = 'android' as const;
  protected readonly settingsApp = 'com.android.settings';
  private crashLines = -1;
  private allWindows = true;

  constructor(
    private readonly adb: Adb,
    readonly id: string,
  ) {
    super();
  }

  async sh(command: string, timeoutMs?: number): Promise<string> {
    return (await this.adb.shell(this.id, command, timeoutMs)).out;
  }

  async shell(command: string): Promise<string> {
    const r = await this.adb.shell(this.id, command, 120_000);
    const parts = [r.out.trim(), r.err && `stderr: ${r.err}`, r.code !== 0 && `exit code ${r.code}`].filter(Boolean);
    return parts.join('\n') || '(no output)';
  }

  /**
   * No animations, screen always on, unlocked, and no on-screen keyboard (typing goes
   * through the emulator's hardware keyboard), which also stops Gboard's stylus
   * tutorial from popping up over apps.
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

  protected async dumpUi(): Promise<UiSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // --windows (undocumented) includes dialogs, popups and the keyboard; older Androids lack it.
      // The old dump is removed first so a failed dump can't return a stale screen.
      const flag = this.allWindows ? '--windows ' : '';
      const out = await this.sh(`rm -f ${UI_DUMP}; uiautomator dump ${flag}${UI_DUMP} >/dev/null 2>&1; cat ${UI_DUMP}`, 20_000);
      const start = out.search(/<displays|<hierarchy/);
      if (start >= 0) return parseUi(out.slice(start));
      if (this.allWindows && attempt === 0) this.allWindows = false;
      await sleep(700);
    }
    throw new Error("Couldn't read the screen layout (the app may be animating non-stop). Take a screenshot instead.");
  }

  protected async capture(maxEdge: number): Promise<Screenshot> {
    // Writing to a file then reading it back is ~2x faster than streaming screencap's stdout.
    const raw = await this.adb.execOut(this.id, `screencap ${SCREEN_RAW} && cat ${SCREEN_RAW}`, 30_000);
    const w = raw.readUInt32LE(0);
    const h = raw.readUInt32LE(4);
    const header = raw.length - w * h * 4;
    if (w <= 0 || h <= 0 || header < 12 || header > 32) {
      // Unusual pixel format: fall back to the device's own PNG at full size.
      const png = await this.adb.execOut(this.id, 'screencap -p', 30_000);
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    }
    this.screen = { w, h };
    const s = Math.min(1, maxEdge / Math.max(w, h));
    const ow = Math.round(w * s);
    const oh = Math.round(h * s);
    return { png: encodePng(downscale(raw.subarray(header), w, h, ow, oh), ow, oh), width: ow, height: oh };
  }

  async newCrashes(): Promise<string | undefined> {
    const lines = (await this.sh('logcat -d -b crash')).split('\n').filter((l) => l.trim());
    const before = this.crashLines;
    this.crashLines = lines.length;
    if (before < 0 || lines.length <= before) return undefined;
    return lines.slice(before, before + 40).join('\n');
  }

  // ---- input ----

  async tapDevicePoint(x: number, y: number, long = false): Promise<void> {
    await this.sh(long ? `input swipe ${x} ${y} ${x} ${y} 800` : `input tap ${x} ${y}`);
  }

  async inputText(text: string): Promise<void> {
    PhoneBase.checkTypable(text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.sh(`input text ${shq(lines[i].replace(/ /g, '%s'))}`);
      if (i < lines.length - 1) await this.sh('input keyevent KEYCODE_ENTER');
    }
  }

  async erase(count: number): Promise<void> {
    if (count > 0) await this.sh(`input keyevent KEYCODE_MOVE_END ${'KEYCODE_DEL '.repeat(count)}`);
  }

  async pressKey(name: string): Promise<void> {
    const code = KEYCODES[name.toLowerCase()] ?? (/^(KEYCODE_[A-Z0-9_]+|\d+)$/.test(name) ? name : undefined);
    if (!code) throw new Error(`Unknown key "${name}". Use one of: ${Object.keys(KEYCODES).join(', ')}, or any KEYCODE_* name.`);
    await this.sh(`input keyevent ${code}`);
  }

  async swipeDevice(x1: number, y1: number, x2: number, y2: number, durationMs = 400): Promise<void> {
    await this.sh(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(' ')} ${Math.round(durationMs)}`);
  }

  /** `input swipe` lifts the finger while moving, which flings lists an unpredictable distance. */
  async dragDevice(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const pts = [0, 1 / 3, 2 / 3, 1].map((t) => [Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t)]);
    const moves = pts.slice(1).map(([x, y]) => `input motionevent MOVE ${x} ${y}`);
    const out = await this.sh(
      [`input motionevent DOWN ${pts[0][0]} ${pts[0][1]}`, ...moves, 'sleep 0.25', `input motionevent UP ${x2} ${y2}`].join('; '),
    );
    // Android 9 and older have no `input motionevent`; a slow swipe is the closest substitute.
    if (/usage|unknown|error/i.test(out)) await this.swipeDevice(x1, y1, x2, y2, 1500);
  }

  // ---- apps ----

  protected async openLink(url: string): Promise<void> {
    const out = await this.sh(`am start -W -a android.intent.action.VIEW -d ${shq(url)}`);
    if (/Error|Exception|unable to resolve/i.test(out)) throw new Error(`Could not open ${url}:\n${out.trim()}`);
  }

  /** With fresh, the app's task is cleared so leftover screens from other apps can't sit on top. */
  protected async launch(appId: string, fresh: boolean): Promise<void> {
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
    // 0x10008000 = FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK
    const out = await this.sh(`am start -W ${fresh ? '-f 0x10008000 ' : ''}-n ${shq(activity)}`);
    if (/Error|Exception/i.test(out)) throw new Error(`Could not open ${appId}:\n${out.trim()}`);
  }

  private async pm(command: string, appId: string): Promise<void> {
    const r = await this.adb.shell(this.id, `${command} ${shq(appId)}`);
    const out = `${r.out}${r.err}`.trim();
    if (r.code !== 0 || /Failure|Error/i.test(out)) throw new Error(`${command} ${appId} failed: ${out || `exit code ${r.code}`}`);
  }

  protected stopApp(appId: string): Promise<void> {
    return this.pm('am force-stop', appId);
  }

  protected clearApp(appId: string): Promise<void> {
    return this.pm('pm clear', appId);
  }

  protected uninstallApp(appId: string): Promise<void> {
    return this.pm('pm uninstall', appId);
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
    const r = await this.adb.run(['-s', this.id, 'install', '-r', '-t', '-g', abs], 300_000);
    const out = `${r.stdout.toString('utf8')}\n${r.stderr}`.trim();
    if (!/Success/.test(out)) throw new Error(`Install failed:\n${out}`);
    const added = (await this.packages()).filter((p) => !before.has(p));
    return added.length ? `Installed ${added.join(', ')}` : `Installed ${path.basename(abs)} (updated an existing app)`;
  }

  async logs(opts: LogOptions): Promise<string> {
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
