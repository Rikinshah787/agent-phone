import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { HOME, PACKAGE_SPEC } from '../config.js';
import type { FlowResult, StepResult } from '../flow/runner.js';
import type { Direction, LogOptions, Screenshot, Target } from '../phone/base.js';
import type { Phone, TypeOptions } from '../phone/phone.js';
import { exec } from '../util/exec.js';
import { log } from '../util/log.js';

/** How to reach the Mac that runs the iPhone simulators. Saved in ~/.agent-phone/config.json. */
export interface MacConfig {
  /** user@host for SSH. */
  ssh?: string;
  port?: number;
  identity?: string;
  /** What to run on the Mac. Default: npx -y <this package> host. */
  hostCommand?: string;
  /** Run this locally instead of SSH (for testing the host on the same machine). */
  command?: string;
}

const CONFIG_FILE = path.join(HOME, 'config.json');

export function loadMacConfig(): MacConfig | undefined {
  if (process.env.AGENT_PHONE_MAC_COMMAND) return { command: process.env.AGENT_PHONE_MAC_COMMAND };
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).mac;
  } catch {
    return undefined;
  }
}

export function saveMacConfig(mac: MacConfig | undefined): void {
  let all: any = {};
  try {
    all = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  if (mac) all.mac = mac;
  else delete all.mac;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(all, null, 2)}\n`);
}

export function describeMac(c: MacConfig): string {
  return c.ssh ?? c.command ?? 'unknown';
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onEvent?: (msg: any) => void;
}

/**
 * One long-lived connection to `agent-phone host` on a Mac, over SSH. Reconnects on the
 * next request if the connection drops.
 */
export class RemoteMac {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];

  constructor(readonly config: MacConfig) {}

  private connect(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const c = this.config;
    let cmd: string;
    let args: string[];
    if (c.command) {
      [cmd, ...args] = c.command.split(' ').filter(Boolean);
    } else {
      if (!c.ssh) throw new Error('No Mac is configured. Run `agent-phone ios connect user@your-mac` first.');
      // Non-interactive SSH sessions on macOS don't load the shell profile, so add Homebrew's paths.
      const remote = `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ${c.hostCommand ?? `npx -y ${PACKAGE_SPEC} host`}`;
      cmd = 'ssh';
      args = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=15'];
      if (c.port) args.push('-p', String(c.port));
      if (c.identity) args.push('-i', c.identity);
      args.push(c.ssh, remote);
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.stderrTail = [];
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      log(`[mac] ${line}`);
      this.stderrTail = [...this.stderrTail.slice(-15), line];
    });
    child.on('error', (e) => this.failAll(`Couldn't start ${cmd}: ${e.message}`));
    child.on('exit', (code) => this.failAll(`The connection to the Mac closed (exit code ${code}).\n${this.stderrTail.join('\n')}`));
    this.child = child;
    return child;
  }

  private failAll(message: string): void {
    this.child = undefined;
    for (const p of this.pending.values()) p.reject(new Error(message));
    this.pending.clear();
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // e.g. npx install chatter
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.event) return p.onEvent?.(msg);
    this.pending.delete(msg.id);
    if (msg.error !== undefined) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  request<T = any>(method: string, params: object = {}, onEvent?: (msg: any) => void): Promise<T> {
    const child = this.connect();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent });
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /** Copy a file (or a folder, as .tar.gz) to the Mac and return its path there. */
  async upload(local: string): Promise<string> {
    let file = path.resolve(local);
    if (!fs.existsSync(file)) throw new Error(`No file at ${file}`);
    let cleanup: string | undefined;
    if (fs.statSync(file).isDirectory()) {
      cleanup = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-phone-upload-'));
      const archive = path.join(cleanup, `${path.basename(file)}.tar.gz`);
      const r = await exec('tar', ['-czf', archive, '-C', path.dirname(file), path.basename(file)]);
      if (r.code !== 0) throw new Error(`Couldn't pack ${file}: ${r.stderr.trim()}`);
      file = archive;
    }
    try {
      const token = crypto.randomUUID();
      const name = path.basename(file);
      const buf = fs.readFileSync(file);
      const chunk = 1024 * 1024;
      let remote = '';
      for (let off = 0; off === 0 || off < buf.length; off += chunk) {
        const done = off + chunk >= buf.length;
        remote = await this.request('upload', { token, name, data: buf.subarray(off, off + chunk).toString('base64'), done });
      }
      return remote;
    } finally {
      if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    }
  }

  close(): void {
    this.child?.stdin?.end();
  }
}

/** An iPhone simulator on a Mac, used from this computer. Every call is forwarded to the Mac. */
export class RemotePhone implements Phone {
  readonly platform = 'ios' as const;

  constructor(
    private readonly mac: RemoteMac,
    readonly id: string,
  ) {}

  private call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    return this.mac.request<T>('call', { id: this.id, method, args });
  }

  observe(settleMs?: number) {
    return this.call<string>('observe', settleMs);
  }
  async screenshot(): Promise<Screenshot> {
    const r = await this.call('screenshot');
    return { png: Buffer.from(r.png, 'base64'), width: r.width, height: r.height };
  }
  tap(t: Target, long?: boolean) {
    return this.call<string>('tap', t, long);
  }
  type(text: string, opts: TypeOptions) {
    return this.call<string>('type', text, opts);
  }
  scroll(direction: Direction, ref?: number) {
    return this.call<string>('scroll', direction, ref);
  }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    return this.call<string>('swipe', x1, y1, x2, y2, durationMs);
  }
  key(name: string) {
    return this.call<string>('key', name);
  }
  open(target: string) {
    return this.call<string>('open', target);
  }
  async install(file: string) {
    return this.call<string>('install', await this.mac.upload(file));
  }
  packages() {
    return this.call<string[]>('packages');
  }
  appAction(action: 'stop' | 'clear' | 'uninstall', target: string) {
    return this.call<string>('appAction', action, target);
  }
  logs(opts: LogOptions) {
    return this.call<string>('logs', opts);
  }
  startTest(app?: string, clearState?: boolean) {
    return this.call<string>('startTest', app, clearState);
  }
  assert(what: { text?: string; id?: string; checked?: boolean }, visible?: boolean) {
    return this.call<{ ok: boolean; message: string }>('assert', what, visible);
  }
  testYaml(name: string) {
    return this.call<{ yaml: string; steps: number }>('testYaml', name);
  }
  async runFlow(file: string, onStep?: (r: StepResult) => void): Promise<FlowResult> {
    const yaml = fs.readFileSync(file, 'utf8');
    const result = await this.mac.request<FlowResult>('runFlow', { id: this.id, name: path.basename(file), yaml }, (msg) => {
      if (msg.event === 'step') onStep?.(msg.step);
    });
    return { ...result, file };
  }
  shell(command: string) {
    return this.call<string>('shell', command);
  }
}
