import type { AdbDevice } from './android/adb.js';
import { Adb } from './android/adb.js';
import { ensureAvd, listAvds } from './android/avd.js';
import { Device } from './android/device.js';
import { bootEmulator, checkAcceleration, stopEmulator } from './android/emulator.js';
import { PROFILES, resolveProfile, type DeviceProfile, type ProfileSpec } from './android/profiles.js';
import { DEFAULT_ANDROID } from './config.js';
import { ensureInstalled, type ProgressFn } from './sdk/installer.js';

export interface StartOptions extends ProfileSpec {
  android?: number;
  headless?: boolean;
  wipe?: boolean;
  onProgress?: ProgressFn;
}

export interface Started {
  device: Device;
  profile: DeviceProfile;
  api: number;
  avd: string;
}

/** Tracks the phones this process knows about and which one the agent is currently using. */
export class Phones {
  readonly adb = new Adb();
  private devices = new Map<string, Device>();
  private current?: string;

  /** Install whatever is missing, create the virtual device if needed, and boot it. */
  async start(opts: StartOptions): Promise<Started> {
    const api = opts.android ?? DEFAULT_ANDROID;
    const profile = resolveProfile(opts);
    const report = opts.onProgress ?? (() => {});
    await ensureInstalled(api, undefined, report);
    await checkAcceleration();
    const avd = await ensureAvd(profile, api);
    report(`Booting ${profile.name} with Android API ${api}`);
    const serial = await bootEmulator(this.adb, avd, { headless: opts.headless, wipe: opts.wipe, onProgress: report });
    const device = await this.attach(serial);
    await device.prepare();
    await device.waitUntilReady();
    return { device, profile, api, avd };
  }

  private async attach(serial: string): Promise<Device> {
    let device = this.devices.get(serial);
    if (!device) {
      device = new Device(this.adb, serial);
      this.devices.set(serial, device);
      await device.newCrashes(); // baseline, so only crashes from now on get reported
    }
    this.current = serial;
    return device;
  }

  /** The device to act on: the one asked for, else the last one used, else the only one connected. */
  async get(serial?: string): Promise<Device> {
    const online = (await this.adb.devices()).filter((d) => d.state === 'device');
    const list = online.map((d) => d.serial).join(', ') || 'none';
    const wanted = serial ?? this.current;
    if (wanted && online.some((d) => d.serial === wanted)) return this.attach(wanted);
    if (serial) throw new Error(`Device ${serial} is not connected. Connected: ${list}.`);
    if (online.length === 1) return this.attach(online[0].serial);
    if (online.length === 0) throw new Error('No phone is running. Start one with phone_start.');
    throw new Error(`Several devices are connected (${list}). Pass serial to choose one.`);
  }

  async stop(serial?: string): Promise<string> {
    const device = await this.get(serial);
    if (!device.serial.startsWith('emulator-')) throw new Error(`${device.serial} is a physical phone; it can't be shut down from here.`);
    await stopEmulator(this.adb, device.serial);
    this.devices.delete(device.serial);
    if (this.current === device.serial) this.current = undefined;
    return `Shut down ${device.serial}.`;
  }

  async status(): Promise<string> {
    const lines = ['Connected devices:'];
    const online: AdbDevice[] = this.adb.available() ? await this.adb.devices() : [];
    if (online.length === 0) lines.push('  none');
    for (const d of online) {
      const avd = d.serial.startsWith('emulator-') ? await this.adb.avdName(d.serial) : undefined;
      const what = avd ? `emulator ${avd}` : `physical phone ${d.model ?? ''}`.trim();
      lines.push(`  ${d.serial}  ${d.state}  ${what}${d.serial === this.current ? '  (current)' : ''}`);
    }
    lines.push('', 'Device profiles for phone_start:');
    for (const p of PROFILES) {
      lines.push(`  ${p.id.padEnd(12)} ${p.name}: ${p.width}x${p.height} px, ${p.density} dpi, ${p.ramMb / 1024} GB RAM`);
    }
    lines.push('  ...or pass width, height and density to match any other phone.');
    const avds = listAvds();
    if (avds.length) lines.push('', `Phones created so far: ${avds.join(', ')}`);
    return lines.join('\n');
  }
}
