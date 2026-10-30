import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TAG, host, paths } from '../config.js';
import { systemImage } from '../sdk/installer.js';
import type { DeviceProfile } from './profiles.js';

export function avdName(profile: DeviceProfile, api: number): string {
  return `ap_${profile.id.replace(/[^a-zA-Z0-9]+/g, '_')}_api${api}`;
}

export function listAvds(): string[] {
  if (!fs.existsSync(paths.avd)) return [];
  return fs
    .readdirSync(paths.avd)
    .filter((f) => f.endsWith('.ini'))
    .map((f) => f.slice(0, -4));
}

/**
 * Create the AVD (virtual device definition) if it doesn't exist yet. This writes the
 * same two files avdmanager would, so no Java tooling is needed.
 */
export async function ensureAvd(profile: DeviceProfile, api: number, tag = DEFAULT_TAG): Promise<string> {
  const name = avdName(profile, api);
  const dir = path.join(paths.avd, `${name}.avd`);
  const configPath = path.join(dir, 'config.ini');
  if (fs.existsSync(configPath)) return name;

  await fsp.mkdir(dir, { recursive: true });
  const landscape = profile.width > profile.height;
  const config: Record<string, string | number> = {
    AvdId: name,
    'avd.ini.displayname': `${profile.name} (agent-phone)`,
    'avd.ini.encoding': 'UTF-8',
    'abi.type': host.abi,
    'hw.cpu.arch': host.abi === 'arm64-v8a' ? 'arm64' : 'x86_64',
    'hw.cpu.ncore': 4,
    'hw.ramSize': profile.ramMb,
    'vm.heapSize': 256,
    'disk.dataPartition.size': '6G',
    'hw.lcd.width': profile.width,
    'hw.lcd.height': profile.height,
    'hw.lcd.density': profile.density,
    'hw.initialOrientation': landscape ? 'landscape' : 'portrait',
    'hw.device.name': profile.id,
    'hw.device.manufacturer': 'agent-phone',
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'auto',
    'hw.keyboard': 'yes',
    'hw.mainKeys': 'no',
    'hw.accelerometer': 'yes',
    'hw.gps': 'yes',
    'hw.battery': 'yes',
    'hw.audioInput': 'yes',
    'hw.camera.back': 'emulated',
    'hw.camera.front': 'emulated',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'yes',
    'image.sysdir.1': systemImage(api, tag).relDir + path.sep,
    'tag.id': tag,
    'tag.display': tag === 'google_apis' ? 'Google APIs' : tag,
    'PlayStore.enabled': 'false',
    'fastboot.forceColdBoot': 'no',
    'showDeviceFrame': 'no',
    'skin.dynamic': 'yes',
    'skin.name': `${profile.width}x${profile.height}`,
    'skin.path': '_no_skin',
  };
  await fsp.writeFile(configPath, Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  await fsp.writeFile(
    path.join(paths.avd, `${name}.ini`),
    ['avd.ini.encoding=UTF-8', `path=${dir}`, `path.rel=avd${path.sep}${name}.avd`, `target=android-${api}`].join('\n') + '\n',
  );
  return name;
}
