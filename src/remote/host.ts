import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Phones } from '../phones.js';
import { exec } from '../util/exec.js';

/**
 * `agent-phone host`: runs on a Mac and serves its iPhone simulators to another computer.
 * The other computer starts it over SSH and talks newline-delimited JSON on stdin/stdout:
 *
 *   → {"id": 1, "method": "start", "params": {...}}
 *   ← {"id": 1, "event": "progress", "message": "..."}      (zero or more)
 *   ← {"id": 1, "result": ...}  or  {"id": 1, "error": "..."}
 *
 * stdout carries only protocol messages; logs go to stderr, which SSH passes back.
 */

/** Phone methods the other side may call. */
const CALLABLE = new Set([
  'observe', 'screenshot', 'tap', 'type', 'scroll', 'swipe', 'key', 'open', 'install',
  'packages', 'appAction', 'logs', 'startTest', 'assert', 'testYaml', 'shell',
]);

interface Request {
  id: number;
  method: string;
  params?: any;
}

export async function runHost(version: string): Promise<void> {
  const phones = new Phones({ local: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-phone-host-'));
  const uploads = new Map<string, string>();
  const send = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  async function handle({ id, method, params = {} }: Request): Promise<unknown> {
    switch (method) {
      case 'hello': {
        const xcode = (await exec('xcodebuild', ['-version']).catch(() => undefined))?.stdout.toString('utf8').split('\n')[0];
        const axe = (await exec('which', ['axe'])).code === 0;
        return { version, platform: process.platform, xcode: xcode || null, axe, node: process.version };
      }
      case 'start': {
        const s = await phones.start({ ...params, platform: 'ios', onProgress: (message) => send({ id, event: 'progress', message }) });
        return { id: s.device.id, description: s.description };
      }
      case 'status':
        return phones.status();
      case 'booted':
        return (await phones.online()).filter((d) => d.platform === 'ios').map((d) => d.id);
      case 'stop':
        return phones.stop(params.id);
      case 'upload': {
        // Chunks of a file from the other computer, base64-encoded, appended in order.
        const file = uploads.get(params.token) ?? path.join(work, `${params.token}-${path.basename(String(params.name))}`);
        uploads.set(params.token, file);
        fs.appendFileSync(file, Buffer.from(String(params.data ?? ''), 'base64'));
        if (params.done) uploads.delete(params.token);
        return file;
      }
      case 'runFlow': {
        const d = await phones.get(params.id);
        const file = path.join(work, path.basename(String(params.name)));
        fs.writeFileSync(file, String(params.yaml));
        return d.runFlow(file, (step) => send({ id, event: 'step', step }));
      }
      case 'call': {
        if (!CALLABLE.has(params.method)) throw new Error(`Unknown phone method "${params.method}".`);
        const d: any = await phones.get(params.id);
        const result = await d[params.method](...(params.args ?? []));
        if (params.method === 'screenshot') return { png: result.png.toString('base64'), width: result.width, height: result.height };
        return result;
      }
      default:
        throw new Error(`Unknown request "${method}".`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    handle(req).then(
      (result) => send({ id: req.id, result: result ?? null }),
      (e: any) => send({ id: req.id, error: e?.message ?? String(e) }),
    );
  });
  await new Promise<void>((resolve) => rl.on('close', resolve));
  fs.rmSync(work, { recursive: true, force: true });
}
