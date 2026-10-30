import type { AdbDevice } from './android/adb.js';
import { Adb } from './android/adb.js';
import { ensureAvd, listAvds } from './android/avd.js';
import { bootEmulator, checkAcceleration, stopEmulator } from './android/emulator.js';
import { AndroidPhone } from './android/phone.js';
import { PROFILES, resolveProfile, type ProfileSpec } from './android/profiles.js';
import { DEFAULT_ANDROID } from './config.js';
import { IosPhone } from './ios/phone.js';
import * as sims from './ios/simulators.js';
import type { Platform, PhoneBase } from './phone/base.js';
import type { Phone } from './phone/phone.js';
import { describeMac, loadMacConfig, RemoteMac, RemotePhone } from './remote/mac.js';
import { ensureInstalled, type ProgressFn } from './sdk/installer.js';
import { exec } from './util/exec.js';

export interface StartOptions extends ProfileSpec {
  platform?: Platform;
  android?: number;
  /** iOS version, e.g. "26.5". Default: the newest installed. */
  ios?: string;
  headless?: boolean;
  wipe?: boolean;
  onProgress?: ProgressFn;
}

export interface Started {
  device: Phone;
  /** e.g. "Pixel 8 (Android API 35)" or "iPhone 17 (iOS 26.5)". */
  description: string;
}

const IOS_NEEDS_MAC =
  "iPhone simulators only run on macOS, so this computer can't start one by itself. " +
  'Connect it to a Mac you can SSH into (your own, or a rented cloud Mac): `agent-phone ios connect user@your-mac`. ' +
  'Or run agent-phone on the Mac directly.';

const isMac = process.platform === 'darwin';

/** Tracks the phones this process knows about and which one the agent is currently using. */
export class Phones {
  readonly adb = new Adb();
  private devices = new Map<string, Phone>();
  private current?: string;
  private mac?: RemoteMac;

  /** local: never forward to another Mac (used by `agent-phone host` on the Mac itself). */
  constructor(private readonly opts: { local?: boolean } = {}) {}

  /** The Mac to use for iPhones, if one is configured and we're not that Mac's host process. */
  private remoteMac(): RemoteMac | undefined {
    if (this.opts.local) return undefined;
    if (!this.mac) {
      const config = loadMacConfig();
      if (config) this.mac = new RemoteMac(config);
    }
    return this.mac;
  }

  /** Install whatever is missing, create the virtual device if needed, and boot it. */
  async start(opts: StartOptions): Promise<Started> {
    return opts.platform === 'ios' ? this.startIos(opts) : this.startAndroid(opts);
  }

  private async startAndroid(opts: StartOptions): Promise<Started> {
    const api = opts.android ?? DEFAULT_ANDROID;
    const profile = resolveProfile(opts);
    const report = opts.onProgress ?? (() => {});
    await ensureInstalled(api, undefined, report);
    await checkAcceleration();
    const avd = await ensureAvd(profile, api);
    report(`Booting ${profile.name} with Android API ${api}`);
    const serial = await bootEmulator(this.adb, avd, { headless: opts.headless, wipe: opts.wipe, onProgress: report });
    const device = await this.attachLocal(serial, 'android');
    await device.prepare();
    await device.waitUntilReady();
    return { device, description: `${profile.name} (Android API ${api})` };
  }

  private async startIos(opts: StartOptions): Promise<Started> {
    const report = opts.onProgress ?? (() => {});
    const mac = this.remoteMac();
    if (mac) {
      report(`Starting an iPhone on ${describeMac(mac.config)}`);
      const { onProgress: _, platform: __, ...params } = opts;
      const r = await mac.request<{ id: string; description: string }>('start', params, (msg) => report(msg.message));
      const device = new RemotePhone(mac, r.id);
      this.devices.set(r.id, device);
      this.current = r.id;
      return { device, description: `${r.description} on ${describeMac(mac.config)}` };
    }
    if (!isMac) throw new Error(IOS_NEEDS_MAC);
    await ensureAxe(report);
    const sim = await sims.findOrCreate(opts.device, opts.ios);
    const version = (await sims.runtimes()).find((r) => r.identifier === sim.runtime)?.version ?? '';
    report(`Booting ${sim.name} with iOS ${version}`);
    await sims.boot(sim.udid, { headless: opts.headless });
    const device = await this.attachLocal(sim.udid, 'ios');
    await device.prepare();
    report('Booted. Waiting for the home screen to be readable');
    await device.waitUntilReady(180_000);
    return { device, description: `${sim.name.replace(/^agent-phone /, '')} (iOS ${version})` };
  }

  private async attachLocal(id: string, platform: Platform): Promise<PhoneBase> {
    let device = this.devices.get(id) as PhoneBase | undefined;
    if (!device) {
      device = platform === 'ios' ? new IosPhone(id) : new AndroidPhone(this.adb, id);
      this.devices.set(id, device);
      await device.newCrashes(); // baseline, so only crashes from now on get reported
    }
    this.current = id;
    return device;
  }

  /** Phones running on this computer: Android devices adb can see, and booted simulators on a Mac. */
  async online(): Promise<{ id: string; platform: Platform }[]> {
    const android = this.adb.available()
      ? (await this.adb.devices()).filter((d) => d.state === 'device').map((d) => ({ id: d.serial, platform: 'android' as const }))
      : [];
    const ios = isMac ? (await sims.booted().catch(() => [])).map((d) => ({ id: d.udid, platform: 'ios' as const })) : [];
    return [...android, ...ios];
  }

  /** iPhones booted on the connected Mac. */
  private async remoteOnline(): Promise<string[]> {
    const mac = this.remoteMac();
    return mac ? mac.request<string[]>('booted').catch(() => []) : [];
  }

  /** The phone to act on: the one asked for, else the last one used, else the only one running. */
  async get(serial?: string): Promise<Phone> {
    const wanted = serial ?? this.current;
    const known = wanted ? this.devices.get(wanted) : undefined;
    if (known instanceof RemotePhone) return known;

    const local = await this.online();
    const found = local.find((d) => d.id === wanted);
    if (found) return this.attachLocal(found.id, found.platform);

    const remote = local.length === 0 || serial ? await this.remoteOnline() : [];
    const all = [...local.map((d) => d.id), ...remote];
    if (serial && remote.includes(serial)) return this.attachRemote(serial);
    if (serial) throw new Error(`Device ${serial} is not connected. Connected: ${all.join(', ') || 'none'}.`);
    if (all.length === 1) return local.length ? this.attachLocal(local[0].id, local[0].platform) : this.attachRemote(remote[0]);
    if (all.length === 0) throw new Error('No phone is running. Start one with phone_start.');
    throw new Error(`Several devices are running (${all.join(', ')}). Pass serial to choose one.`);
  }

  private attachRemote(id: string): Phone {
    let device = this.devices.get(id);
    if (!device) {
      device = new RemotePhone(this.remoteMac()!, id);
      this.devices.set(id, device);
    }
    this.current = id;
    return device;
  }

  async stop(serial?: string): Promise<string> {
    const device = await this.get(serial);
    if (device instanceof RemotePhone) await this.remoteMac()!.request('stop', { id: device.id });
    else if (device.platform === 'ios') await sims.shutdown(device.id);
    else if (device.id.startsWith('emulator-')) await stopEmulator(this.adb, device.id);
    else throw new Error(`${device.id} is a physical phone; it can't be shut down from here.`);
    this.devices.delete(device.id);
    if (this.current === device.id) this.current = undefined;
    return `Shut down ${device.id}.`;
  }

  async status(): Promise<string> {
    const lines = ['Running devices:'];
    const android: AdbDevice[] = this.adb.available() ? await this.adb.devices() : [];
    for (const d of android) {
      const avd = d.serial.startsWith('emulator-') ? await this.adb.avdName(d.serial) : undefined;
      const what = avd ? `Android emulator ${avd}` : `Android phone ${d.model ?? ''}`.trim();
      lines.push(`  ${d.serial}  ${d.state}  ${what}${d.serial === this.current ? '  (current)' : ''}`);
    }
    const ios = isMac ? await sims.booted().catch(() => []) : [];
    for (const d of ios) lines.push(`  ${d.udid}  booted  iOS simulator ${d.name}${d.udid === this.current ? '  (current)' : ''}`);
    const mac = this.remoteMac();
    const remote = await this.remoteOnline();
    for (const id of remote) lines.push(`  ${id}  booted  iOS simulator on ${describeMac(mac!.config)}${id === this.current ? '  (current)' : ''}`);
    if (android.length + ios.length + remote.length === 0) lines.push('  none');

    lines.push('', 'Android profiles for phone_start:');
    for (const p of PROFILES) {
      lines.push(`  ${p.id.padEnd(12)} ${p.name}: ${p.width}x${p.height} px, ${p.density} dpi, ${p.ramMb / 1024} GB RAM`);
    }
    lines.push('  ...or pass width, height and density to match any other phone.');
    const avds = listAvds();
    if (avds.length) lines.push(`  Created so far: ${avds.join(', ')}`);

    if (mac) {
      lines.push('', `iPhone: phone_start with platform "ios" uses the Mac at ${describeMac(mac.config)}.`);
    } else if (isMac) {
      const types = await sims.deviceTypes().catch(() => []);
      const versions = (await sims.runtimes().catch(() => [])).map((r) => r.version);
      lines.push('', `iPhone models for phone_start with platform "ios" (iOS ${versions.join(', ') || 'none installed'}):`);
      lines.push(`  ${types.filter((t) => /^iPhone/.test(t.name)).map((t) => t.name).join(', ')}`);
    } else {
      lines.push('', 'iPhone: needs a Mac. Connect one with `agent-phone ios connect user@your-mac`.');
    }
    return lines.join('\n');
  }
}

/** AXe does the tapping and screen reading on iOS. Install it with Homebrew if it's missing. */
async function ensureAxe(report: ProgressFn): Promise<void> {
  if ((await exec('which', ['axe'])).code === 0) return;
  if ((await exec('which', ['brew'])).code !== 0) {
    throw new Error('agent-phone needs AXe to drive iOS simulators. Install Homebrew (https://brew.sh), then run: brew install cameroncooke/axe/axe');
  }
  report('Installing AXe (iOS simulator automation) with Homebrew');
  const r = await exec('brew', ['install', 'cameroncooke/axe/axe'], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`Installing AXe failed: ${r.stderr.trim()}`);
}
