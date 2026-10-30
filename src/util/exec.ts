import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

const debug = !!process.env.AGENT_PHONE_DEBUG;

/** Run a program without a shell and collect its output. Never throws on non-zero exit. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (debug) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        process.stderr.write(`[exec] ${cmd} ${args.join(' ').slice(0, 160)} -> ${code} in ${secs}s\n`);
      }
      resolve({ code, stdout: Buffer.concat(out), stderr });
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        err.push(Buffer.from(`\n(timed out after ${opts.timeoutMs! / 1000}s)`));
        // Helpers the program started can keep its output open, so don't wait for 'close'.
        setTimeout(() => finish(null), 2000);
      }, opts.timeoutMs);
    }
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(e);
      settled = true;
    });
    child.on('close', (code) => finish(code));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Quote a string for the Android device's /system/bin/sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
