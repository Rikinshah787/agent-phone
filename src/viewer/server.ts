import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Phone } from '../phone/phone.js';
import { exec } from '../util/exec.js';
import { PAGE } from './page.js';

/**
 * A live view of the phone in the browser, for phones that have no window on this
 * computer (an iPhone on a Mac across the network, or a headless emulator). Shows the
 * screen, what the agent is doing, and lets you tap, scroll and type yourself.
 *
 * Listens on 127.0.0.1 only, behind a random token. Actions also need a custom header,
 * so a web page can't send them cross-site without a CORS preflight, which this server
 * never approves.
 */

const activity: { at: number; text: string }[] = [];

/** Something the agent (or the person at the viewer) did, for the viewer's activity feed. */
export function recordActivity(text: string): void {
  activity.push({ at: Date.now(), text });
  if (activity.length > 300) activity.shift();
}

let running: Promise<string> | undefined;

export function startViewer(getPhone: () => Promise<Phone>, title: () => string): Promise<string> {
  running ??= listen(getPhone, title);
  return running;
}

async function listen(getPhone: () => Promise<Phone>, title: () => string): Promise<string> {
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, tok, route = ''] = url.pathname.split('/');
    if (tok !== token) return void res.writeHead(404).end();
    try {
      if (req.method === 'GET' && route === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return void res.end(PAGE);
      }
      if (req.method === 'GET' && route === 'frame') {
        const shot = await (await getPhone()).screenshot();
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        return void res.end(shot.png);
      }
      if (req.method === 'GET' && route === 'activity') {
        const since = Number(url.searchParams.get('since') ?? 0);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return void res.end(JSON.stringify({ title: title(), items: activity.filter((a) => a.at > since) }));
      }
      if (req.method === 'POST' && route === 'act' && req.headers['x-agent-phone'] === '1') {
        const body = JSON.parse(await readBody(req));
        const phone = await getPhone();
        let done: string;
        if (body.kind === 'tap') done = await phone.tap({ x: Number(body.x), y: Number(body.y) }, !!body.long);
        else if (body.kind === 'key') done = await phone.key(String(body.key));
        else if (body.kind === 'type') done = await phone.type(String(body.text), {});
        else if (body.kind === 'scroll') done = await phone.scroll(body.direction === 'up' ? 'up' : 'down');
        else throw new Error(`Unknown action ${body.kind}`);
        recordActivity(`You: ${done}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ ok: true, done }));
      }
      res.writeHead(404).end();
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(e?.message ?? String(e));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/${token}/`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) reject(new Error('Request too large'));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function openInBrowser(url: string): Promise<void> {
  if (process.platform === 'win32') await exec('cmd', ['/c', 'start', '', url]);
  else if (process.platform === 'darwin') await exec('open', [url]);
  else await exec('xdg-open', [url]);
}
