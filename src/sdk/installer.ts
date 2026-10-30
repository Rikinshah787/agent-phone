import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_TAG, host, paths } from '../config.js';
import { sleep } from '../util/exec.js';
import { formatBytes, log } from '../util/log.js';
import { findPackage, type RemotePackage } from './repository.js';
import { unzip } from './unzip.js';

export interface Component {
  label: string;
  pkgPath: string;
  dest: string;
}

const MARKER = '.agent-phone-installed.json';

export type ProgressFn = (message: string) => void;

export function systemImage(api: number, tag = DEFAULT_TAG, abi = host.abi) {
  return {
    pkgPath: `system-images;android-${api};${tag};${abi}`,
    /** Relative to the SDK root, as written into an AVD's config.ini. */
    relDir: path.join('system-images', `android-${api}`, tag, abi),
  };
}

/** The pieces needed to boot a phone running the given Android API level. */
export function requiredComponents(api: number, tag = DEFAULT_TAG): Component[] {
  const img = systemImage(api, tag);
  return [
    { label: 'Android platform tools (adb)', pkgPath: 'platform-tools', dest: path.join(paths.sdk, 'platform-tools') },
    { label: 'Android Emulator', pkgPath: 'emulator', dest: path.join(paths.sdk, 'emulator') },
    { label: `Android API ${api} system image`, pkgPath: img.pkgPath, dest: path.join(paths.sdk, img.relDir) },
  ];
}

export function isInstalled(c: Component): boolean {
  return fs.existsSync(path.join(c.dest, MARKER));
}

export function missingComponents(api: number, tag = DEFAULT_TAG): Component[] {
  return requiredComponents(api, tag).filter((c) => !isInstalled(c));
}

export async function ensureInstalled(api: number, tag = DEFAULT_TAG, onProgress?: ProgressFn): Promise<void> {
  const report = (m: string) => {
    log(m);
    onProgress?.(m);
  };
  const missing = missingComponents(api, tag);
  if (missing.length > 0) {
    report(
      'Downloading Android SDK components from dl.google.com. ' +
        'By continuing you accept the Android SDK License: https://developer.android.com/studio/terms',
    );
  }
  for (const c of missing) await install(c, report);
  // The emulator only treats a folder as an SDK root if it has a platforms directory.
  await fsp.mkdir(path.join(paths.sdk, 'platforms'), { recursive: true });
}

async function install(c: Component, report: ProgressFn): Promise<void> {
  const pkg = await findPackage(c.pkgPath);
  report(`${c.label} ${pkg.revision}: downloading ${formatBytes(pkg.size)}`);
  const zip = await download(pkg, c.label, report);

  report(`${c.label}: unpacking`);
  const tmp = path.join(paths.sdk, `.tmp-${process.pid}-${Date.now()}`);
  try {
    await unzip(zip, tmp);
    // SDK archives hold a single top-level folder (e.g. "emulator/" or "x86_64/").
    const entries = await fsp.readdir(tmp);
    const inner = entries.length === 1 ? path.join(tmp, entries[0]) : tmp;
    await fsp.rm(c.dest, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(c.dest), { recursive: true });
    await renameWithRetry(inner, c.dest);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  await fsp.writeFile(
    path.join(c.dest, MARKER),
    JSON.stringify({ package: c.pkgPath, revision: pkg.revision, installedAt: new Date().toISOString() }, null, 2),
  );
  await fsp.rm(zip, { force: true });
  report(`${c.label}: installed`);
}

/** Download with resume support, verifying the SHA-1 from Google's index. */
async function download(pkg: RemotePackage, label: string, report: ProgressFn): Promise<string> {
  await fsp.mkdir(paths.downloads, { recursive: true });
  const file = path.join(paths.downloads, path.basename(new URL(pkg.url).pathname));
  const part = `${file}.part`;

  // A finished download from an earlier run whose unpack step failed.
  if (fs.existsSync(file) && fs.statSync(file).size === pkg.size && (await sha1File(file)) === pkg.sha1) return file;

  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have >= pkg.size) {
    await fsp.rm(part, { force: true });
    have = 0;
  }

  const res = await fetch(pkg.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
  if (res.status === 200) have = 0;
  else if (res.status !== 206) throw new Error(`Download failed for ${pkg.url} (HTTP ${res.status}).`);
  if (!res.body) throw new Error(`Empty response for ${pkg.url}.`);
  if (have > 0) report(`${label}: resuming at ${formatBytes(have)}`);

  let done = have;
  let lastReport = Date.now();
  let lastBytes = done;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - lastReport >= 5000) {
        const rate = (done - lastBytes) / ((now - lastReport) / 1000);
        report(`${label}: ${Math.floor((done / pkg.size) * 100)}% of ${formatBytes(pkg.size)} (${formatBytes(rate)}/s)`);
        lastReport = now;
        lastBytes = done;
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as any), meter, fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' }));

  const actual = await sha1File(part);
  if (actual !== pkg.sha1) {
    await fsp.rm(part, { force: true });
    throw new Error(`Checksum mismatch for ${path.basename(file)} (expected ${pkg.sha1}, got ${actual}). Please retry.`);
  }
  await renameWithRetry(part, file);
  return file;
}

async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Antivirus scanners on Windows briefly lock freshly written files, so retry renames. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e: any) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}
