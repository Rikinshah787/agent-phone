import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneBase, type LogOptions, type Screenshot } from '../phone/base.js';
import type { UiSnapshot } from '../phone/ui.js';
import { exec, sleep } from '../util/exec.js';
import { simctl } from './simulators.js';
import { parseIosUi } from './ui.js';

/** USB HID keyboard usage ids, which is what `axe key` sends. */
const HID_KEYS: Record<string, number> = {
  enter: 40,
  escape: 41,
  delete: 42,
  backspace: 42,
  tab: 43,
  space: 44,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
};

const BUTTONS: Record<string, string> = { power: 'lock' };

/** An iPhone or iPad simulator on this Mac, driven with simctl and AXe. */
export class IosPhone extends PhoneBase {
  readonly platform = 'ios' as const;
  protected readonly settingsApp = 'com.apple.Preferences';
  /** iOS doesn't say which app is in front, so remember what we last launched. */
  private lastApp?: string;
  private knownCrashes?: Set<string>;
  private readonly tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-phone-ios-'));

  constructor(readonly id: string) {
    super();
  }

  private async axe(args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await exec('axe', [...args, '--udid', this.id], { timeoutMs });
    if (r.code !== 0) throw new Error(`axe ${args[0]} failed: ${r.stderr.trim() || r.stdout.toString('utf8').trim()}`);
    return r.stdout.toString('utf8');
  }

  async shell(command: string): Promise<string> {
    // There is no shell inside an iOS simulator, so this runs on the Mac with $UDID set.
    const r = await exec('/bin/sh', ['-c', command], { timeoutMs: 120_000, env: { ...process.env, UDID: this.id } });
    const parts = [r.stdout.toString('utf8').trim(), r.stderr.trim() && `stderr: ${r.stderr.trim()}`, r.code !== 0 && `exit code ${r.code}`];
    return parts.filter(Boolean).join('\n') || '(no output)';
  }

  /** A clean status bar (9:41, full battery) so screenshots don't change between runs. */
  async prepare(): Promise<void> {
    await simctl(['status_bar', this.id, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100']).catch(() => undefined);
    await this.newCrashes();
  }

  protected async dumpUi(): Promise<UiSnapshot> {
    let lastError = '';
    // Usually a second or two; the first read after boot, or on a small CI machine, can take 45s.
    // Mid-transition, iOS can return an empty tree, so that counts as "try again" too.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const snap = parseIosUi(await this.axe(['describe-ui'], 90_000));
        if (snap.elements.length > 0 || attempt === 3) {
          if (!this.measured && snap.width) await this.measurePixelRatio(snap.width);
          return snap;
        }
        lastError = 'the screen was empty (an animation was probably still running)';
      } catch (e: any) {
        lastError = e.message;
      }
      await sleep(1000);
    }
    throw new Error(`Couldn't read the screen layout: ${lastError}`);
  }

  private measured = false;

  /** Screenshots are in pixels and the accessibility tree in points; 3x on current iPhones. */
  private async measurePixelRatio(pointWidth: number): Promise<void> {
    const file = await this.rawScreenshot();
    this.pixelRatio = (await this.imageSize(file))[0] / pointWidth;
    this.measured = true;
  }

  private async rawScreenshot(): Promise<string> {
    const file = path.join(this.tmp, 'screen.png');
    await simctl(['io', this.id, 'screenshot', '--type=png', file], 30_000);
    return file;
  }

  private async imageSize(file: string): Promise<[number, number]> {
    const out = (await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file])).stdout.toString('utf8');
    return [Number(/pixelWidth: (\d+)/.exec(out)?.[1]), Number(/pixelHeight: (\d+)/.exec(out)?.[1])];
  }

  protected async capture(maxEdge: number): Promise<Screenshot> {
    if (!this.screen) await this.ui();
    const file = await this.rawScreenshot();
    let [w, h] = await this.imageSize(file);
    if (this.screen?.w) this.pixelRatio = w / this.screen.w;
    if (Math.max(w, h) > maxEdge) {
      await exec('sips', ['-Z', String(maxEdge), file]);
      [w, h] = await this.imageSize(file);
    }
    return { png: fs.readFileSync(file), width: w, height: h };
  }

  /** New crash reports for apps in this simulator since the last check. */
  async newCrashes(): Promise<string | undefined> {
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ips')) : [];
    if (!this.knownCrashes) {
      this.knownCrashes = new Set(files);
      return undefined;
    }
    const fresh = files.filter((f) => !this.knownCrashes!.has(f));
    fresh.forEach((f) => this.knownCrashes!.add(f));
    const reports = fresh
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .filter((text) => text.includes(this.id))
      .map((text) => text.split('\n').slice(0, 40).join('\n'));
    return reports.length ? reports.join('\n\n') : undefined;
  }

  // ---- input (points) ----

  async tapDevicePoint(x: number, y: number, long = false): Promise<void> {
    const at = ['-x', String(Math.round(x)), '-y', String(Math.round(y))];
    await this.axe(long ? ['touch', ...at, '--down', '--up', '--delay', '1.0'] : ['tap', ...at]);
  }

  async inputText(text: string): Promise<void> {
    PhoneBase.checkTypable(text);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.axe(['type', lines[i]]);
      if (i < lines.length - 1) await this.pressKey('enter');
    }
  }

  async erase(count: number): Promise<void> {
    for (let left = count; left > 0; left -= 100) {
      const n = Math.min(left, 100);
      await this.axe(['key-sequence', '--keycodes', Array(n).fill(HID_KEYS.backspace).join(','), '--delay', '0.02']);
    }
  }

  async pressKey(name: string): Promise<void> {
    const key = name.toLowerCase();
    if (key === 'back') throw new Error("iPhones have no back button. Tap the app's own back button (usually top-left) or swipe from the left edge.");
    if (key === 'home') return this.goHome();
    if (BUTTONS[key]) return void (await this.axe(['button', BUTTONS[key]]));
    const code = HID_KEYS[key] ?? (/^\d+$/.test(name) ? Number(name) : undefined);
    if (code === undefined) {
      throw new Error(`"${name}" isn't available on an iPhone. Use one of: home, power, ${Object.keys(HID_KEYS).join(', ')}.`);
    }
    await this.axe(['key', String(code)]);
  }

  /**
   * Current iPhones have no home button: you swipe up from the bottom edge. AXe's
   * `button home` is ignored on them, so do the gesture.
   */
  private async goHome(): Promise<void> {
    if (!this.screen) await this.ui();
    const { w, h } = this.screen!;
    await this.swipeDevice(w / 2, h - 2, w / 2, h * 0.45, 250);
  }

  async swipeDevice(x1: number, y1: number, x2: number, y2: number, durationMs = 400): Promise<void> {
    const pts = [x1, y1, x2, y2].map((v) => String(Math.round(v)));
    await this.axe(['swipe', '--start-x', pts[0], '--start-y', pts[1], '--end-x', pts[2], '--end-y', pts[3], '--duration', (durationMs / 1000).toFixed(2)]);
  }

  async dragDevice(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const pts = [x1, y1, x2, y2].map((v) => String(Math.round(v)));
    await this.axe(['drag', '--start-x', pts[0], '--start-y', pts[1], '--end-x', pts[2], '--end-y', pts[3], '--duration', '0.8', '--steps', '40']);
  }

  // ---- apps ----

  protected async openLink(url: string): Promise<void> {
    await simctl(['openurl', this.id, url]);
  }

  protected async launch(appId: string, fresh: boolean): Promise<void> {
    if (fresh) await this.stopApp(appId);
    await simctl(['launch', this.id, appId]);
    this.lastApp = appId;
  }

  protected async stopApp(appId: string): Promise<void> {
    const r = await exec('xcrun', ['simctl', 'terminate', this.id, appId]);
    // Terminating an app that isn't running is fine.
    if (r.code !== 0 && !/found nothing to terminate|not running|No such process/i.test(r.stderr)) {
      throw new Error(`Couldn't stop ${appId}: ${r.stderr.trim()}`);
    }
  }

  /** Empty the app's data folder and reset its permissions, like a fresh install. */
  protected async clearApp(appId: string): Promise<void> {
    await this.stopApp(appId);
    const data = (await simctl(['get_app_container', this.id, appId, 'data'])).trim();
    if (!data || data === '/' || !data.includes('/Containers/Data/')) throw new Error(`Unexpected data folder for ${appId}: ${data}`);
    for (const entry of fs.readdirSync(data)) fs.rmSync(path.join(data, entry), { recursive: true, force: true });
    await simctl(['privacy', this.id, 'reset', 'all', appId]).catch(() => undefined);
  }

  protected async uninstallApp(appId: string): Promise<void> {
    await simctl(['uninstall', this.id, appId]);
  }

  async packages(): Promise<string[]> {
    const plist = await simctl(['listapps', this.id]);
    const r = await exec('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist });
    const apps = JSON.parse(r.stdout.toString('utf8'));
    return Object.entries<any>(apps)
      .filter(([, info]) => info.ApplicationType === 'User')
      .map(([id]) => id)
      .sort();
  }

  /** Install a simulator build: a .app folder, or a .zip / .tar.gz / .ipa containing one. */
  async install(file: string): Promise<string> {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`No file at ${abs}`);
    let app = abs;
    if (!abs.endsWith('.app')) {
      const dir = fs.mkdtempSync(path.join(this.tmp, 'install-'));
      const r = /\.(tar\.gz|tgz)$/.test(abs)
        ? await exec('tar', ['-xzf', abs, '-C', dir])
        : await exec('ditto', ['-x', '-k', abs, dir]);
      if (r.code !== 0) throw new Error(`Couldn't unpack ${path.basename(abs)}: ${r.stderr.trim()}`);
      const found = (await exec('find', [dir, '-maxdepth', '3', '-name', '*.app', '-type', 'd'])).stdout.toString('utf8').trim().split('\n')[0];
      if (!found) throw new Error(`No .app inside ${path.basename(abs)}. Build for the simulator (-sdk iphonesimulator).`);
      app = found;
    }
    const plist = path.join(app, 'Info.plist');
    const bundleId = (await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).stdout.toString('utf8').trim();
    await simctl(['install', this.id, app], 300_000);
    return `Installed ${bundleId || path.basename(app)}`;
  }

  async logs(opts: LogOptions): Promise<string> {
    if (opts.clear) return 'iOS simulator logs can\'t be cleared; read a shorter time window instead.';
    if (opts.crashes) return (await this.newCrashes()) ?? 'No new crash reports.';
    const lines = opts.lines ?? 150;
    const predicates: string[] = [];
    if (opts.pkg) {
      const app = (await simctl(['get_app_container', this.id, opts.pkg, 'app']).catch(() => '')).trim();
      const exe = app ? (await exec('plutil', ['-extract', 'CFBundleExecutable', 'raw', path.join(app, 'Info.plist')])).stdout.toString('utf8').trim() : '';
      predicates.push(exe ? `(process == "${exe}" OR subsystem == "${opts.pkg}")` : `subsystem == "${opts.pkg}"`);
    }
    const level = opts.level?.toLowerCase();
    if (level === 'error' || level === 'warn') predicates.push('(messageType == error OR messageType == fault)');
    const args = ['spawn', this.id, 'log', 'show', '--last', '5m', '--style', 'compact'];
    if (level === 'debug' || level === 'verbose') args.push('--debug', '--info');
    if (level === 'info') args.push('--info');
    if (predicates.length) args.push('--predicate', predicates.join(' AND '));
    const out = (await simctl(args, 60_000)).split('\n').filter((l) => l.trim() && !l.startsWith('Timestamp'));
    const text = out.slice(-lines).join('\n').trim();
    return text || 'No matching log lines in the last 5 minutes.';
  }

  /** iOS's accessibility tree names the app, not its bundle id, so fall back to what we launched. */
  override async startTest(app?: string, clearState = false): Promise<string> {
    const appId = app ?? this.lastApp;
    if (!appId) throw new Error('Pass app (the bundle id, e.g. com.example.MyApp) to start recording.');
    return super.startTest(appId, clearState);
  }
}
