import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { androidEnv, tools } from '../config.js';
import { exec, type ExecResult } from '../util/exec.js';

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export interface ShellResult {
  out: string;
  err: string;
  code: number | null;
}

export class Adb {
  private serverStarted = false;

  available(): boolean {
    return fs.existsSync(tools.adb);
  }

  /**
   * Start the adb server with no pipes attached. Otherwise the long-lived server can
   * inherit our stdout pipe and keep the first adb call from ever finishing.
   */
  private async ensureServer(): Promise<void> {
    if (this.serverStarted) return;
    if (!this.available()) throw new Error('adb is not installed yet. Run `agent-phone setup` or call phone_start.');
    await new Promise<void>((resolve, reject) => {
      const p = spawn(tools.adb, ['start-server'], { env: androidEnv(), stdio: 'ignore', windowsHide: true });
      p.on('error', reject);
      p.on('exit', () => resolve());
    });
    this.serverStarted = true;
  }

  async run(args: string[], timeoutMs = 30_000): Promise<ExecResult> {
    await this.ensureServer();
    return exec(tools.adb, args, { env: androidEnv(), timeoutMs });
  }

  async devices(): Promise<AdbDevice[]> {
    const r = await this.run(['devices', '-l'], 15_000);
    return r.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state, ...rest] = l.split(/\s+/);
        const model = rest.find((r) => r.startsWith('model:'))?.slice(6);
        return { serial, state, model };
      });
  }

  /** The AVD name of a running emulator, read through its console. */
  async avdName(serial: string): Promise<string | undefined> {
    const r = await this.run(['-s', serial, 'emu', 'avd', 'name'], 5_000);
    const first = r.stdout.toString('utf8').split(/\r?\n/)[0]?.trim();
    return first && first !== 'KO' ? first : undefined;
  }

  async shell(serial: string, command: string, timeoutMs = 30_000): Promise<ShellResult> {
    const r = await this.run(['-s', serial, 'shell', command], timeoutMs);
    return { out: r.stdout.toString('utf8').replace(/\r\n/g, '\n'), err: r.stderr.trim(), code: r.code };
  }

  /** Raw binary output (no line-ending translation), e.g. for screencap. */
  async execOut(serial: string, command: string, timeoutMs = 30_000): Promise<Buffer> {
    const r = await this.run(['-s', serial, 'exec-out', command], timeoutMs);
    if (r.code !== 0 && r.stdout.length === 0) throw new Error(r.stderr.trim() || `adb exec-out failed: ${command}`);
    return r.stdout;
  }
}
