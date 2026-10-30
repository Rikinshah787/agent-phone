import { exec, sleep } from '../util/exec.js';

/** iPhone and iPad simulators, managed with Apple's `xcrun simctl`. macOS with Xcode only. */

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  deviceType: string;
}

export interface SimRuntime {
  identifier: string;
  version: string;
  name: string;
}

export async function simctl(args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await exec('xcrun', ['simctl', ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(`simctl ${args[0]} failed: ${r.stderr.trim() || r.stdout.toString('utf8').trim()}`);
  return r.stdout.toString('utf8');
}

async function json(args: string[]): Promise<any> {
  return JSON.parse(await simctl([...args, '-j']));
}

export async function runtimes(): Promise<SimRuntime[]> {
  const r = await json(['list', 'runtimes', 'available']);
  return (r.runtimes as any[])
    .filter((x) => x.platform === 'iOS' || /iOS/.test(x.name))
    .map((x) => ({ identifier: x.identifier, version: x.version, name: x.name }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

export async function devices(): Promise<SimDevice[]> {
  const r = await json(['list', 'devices', 'available']);
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries<any[]>(r.devices)) {
    for (const d of list) {
      if (d.isAvailable === false) continue;
      out.push({ udid: d.udid, name: d.name, state: d.state, runtime, deviceType: d.deviceTypeIdentifier ?? '' });
    }
  }
  return out;
}

export async function deviceTypes(): Promise<{ identifier: string; name: string }[]> {
  const r = await json(['list', 'devicetypes']);
  return (r.devicetypes as any[]).map((t) => ({ identifier: t.identifier, name: t.name }));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Find a simulator for this model and iOS version, creating one if needed. With no model,
 * picks the first iPhone that the newest runtime offers.
 */
export async function findOrCreate(model?: string, iosVersion?: string): Promise<SimDevice> {
  const all = await runtimes();
  if (all.length === 0) throw new Error('No iOS simulator runtimes are installed. Install one with: xcodebuild -downloadPlatform iOS');
  const runtime = iosVersion ? all.find((r) => r.version === iosVersion || r.version.startsWith(`${iosVersion}.`)) : all[0];
  if (!runtime) throw new Error(`iOS ${iosVersion} isn't installed. Installed: ${all.map((r) => r.version).join(', ')}.`);

  const existing = (await devices()).filter((d) => d.runtime === runtime.identifier);
  const wanted = model?.trim().toLowerCase();
  const match = wanted
    ? existing.find((d) => d.name.toLowerCase() === wanted) ?? existing.find((d) => d.name.toLowerCase() === `agent-phone ${wanted}`)
    : existing.find((d) => /^iPhone/.test(d.name));
  if (match) return match;

  const types = await deviceTypes();
  const type = wanted ? types.find((t) => t.name.toLowerCase() === wanted) : types.filter((t) => /^iPhone/.test(t.name)).pop();
  if (!type) {
    const names = types.filter((t) => /^(iPhone|iPad)/.test(t.name)).map((t) => t.name);
    throw new Error(`Unknown device "${model}". Available: ${names.join(', ')}.`);
  }
  const udid = (await simctl(['create', `agent-phone ${type.name}`, type.identifier, runtime.identifier])).trim();
  return { udid, name: `agent-phone ${type.name}`, state: 'Shutdown', runtime: runtime.identifier, deviceType: type.identifier };
}

export async function boot(udid: string, opts: { headless?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const r = await exec('xcrun', ['simctl', 'boot', udid], { timeoutMs: 120_000 });
  const err = r.stderr.trim();
  if (r.code !== 0 && !/current state: Booted/i.test(err)) throw new Error(`Couldn't boot the simulator: ${err}`);
  await simctl(['bootstatus', udid, '-b'], opts.timeoutMs ?? 600_000);
  // Show the window when someone is at this Mac to watch.
  if (!opts.headless) await exec('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]).catch(() => undefined);
  await sleep(1000);
}

export async function shutdown(udid: string): Promise<void> {
  await simctl(['shutdown', udid]);
}

export async function booted(): Promise<SimDevice[]> {
  return (await devices()).filter((d) => d.state === 'Booted');
}
