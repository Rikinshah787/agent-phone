import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { androidEnv, host, paths, tools } from '../config.js';
import { exec, sleep } from '../util/exec.js';
import type { Adb } from './adb.js';

export interface BootOptions {
  headless?: boolean;
  wipe?: boolean;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

let accelOk = false;

/** Throws with platform-specific instructions when the emulator can't use hardware acceleration. */
export async function checkAcceleration(): Promise<void> {
  if (accelOk) return;
  const r = await exec(tools.emulator, ['-accel-check'], { env: androidEnv(), timeoutMs: 30_000 });
  if (r.code === 0) {
    accelOk = true;
    return;
  }
  const detail = (r.stdout.toString('utf8') + r.stderr).trim();
  const help =
    host.os === 'windows'
      ? 'Turn on "Windows Hypervisor Platform": open PowerShell as Administrator, run\n' +
        '  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All\n' +
        'then restart Windows. Virtualization must also be enabled in your BIOS/UEFI.'
      : host.os === 'linux'
        ? 'Install KVM (e.g. `sudo apt install qemu-kvm`) and add yourself to the kvm group (`sudo adduser $USER kvm`), then log in again.'
        : 'Hardware acceleration should work out of the box on macOS; check that no other hypervisor is blocking it.';
  throw new Error(`The Android Emulator can't use hardware acceleration on this machine.\n${help}\n\nEmulator said:\n${detail}`);
}

export async function findRunningEmulator(adb: Adb, avd: string): Promise<string | undefined> {
  for (const d of await adb.devices()) {
    if (d.serial.startsWith('emulator-') && (await adb.avdName(d.serial)) === avd) return d.serial;
  }
  return undefined;
}

function logTail(file: string, lines = 25): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no emulator log)';
  }
}

/** Boot the AVD (or reuse it if it's already running) and wait until Android has finished starting. */
export async function bootEmulator(adb: Adb, avd: string, opts: BootOptions = {}): Promise<string> {
  const report = opts.onProgress ?? (() => {});
  let serial = await findRunningEmulator(adb, avd);
  let exitCode: number | undefined;
  const logFile = path.join(paths.logs, `${avd}.log`);

  if (!serial) {
    fs.mkdirSync(paths.logs, { recursive: true });
    const fd = fs.openSync(logFile, 'w');
    const args = ['-avd', avd, '-no-boot-anim', '-no-audio', '-netdelay', 'none', '-netspeed', 'full'];
    if (opts.headless) args.push('-no-window');
    if (opts.wipe) args.push('-wipe-data');
    // Detached so the phone keeps running after the agent session ends.
    const child = spawn(tools.emulator, args, { env: androidEnv(), detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.on('exit', (code) => (exitCode = code ?? -1));
    child.unref();
    report(`Starting emulator (log: ${logFile})`);
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  let lastNote = Date.now();
  while (Date.now() < deadline) {
    if (exitCode !== undefined && exitCode !== 0) {
      throw new Error(`The emulator stopped during startup (exit code ${exitCode}). Last log lines:\n${logTail(logFile)}`);
    }
    if (!serial) {
      serial = await findRunningEmulator(adb, avd);
    } else {
      const r = await adb.shell(serial, 'getprop sys.boot_completed', 10_000).catch(() => undefined);
      if (r?.out.trim() === '1') return serial;
    }
    if (Date.now() - lastNote > 15_000) {
      report(serial ? 'Android is still booting...' : 'Waiting for the emulator to come up...');
      lastNote = Date.now();
    }
    await sleep(1500);
  }
  throw new Error(`The phone did not finish booting in time. Last log lines:\n${logTail(logFile)}`);
}

export async function stopEmulator(adb: Adb, serial: string): Promise<void> {
  await adb.run(['-s', serial, 'emu', 'kill'], 15_000);
}
