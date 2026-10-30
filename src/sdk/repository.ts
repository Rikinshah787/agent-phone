import { XMLParser } from 'fast-xml-parser';
import { host } from '../config.js';

const REPO = 'https://dl.google.com/android/repository/';

export interface RemotePackage {
  path: string;
  revision: string;
  url: string;
  size: number;
  sha1: string;
}

// parseTagValue is off so checksums made only of digits stay strings.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['remotePackage', 'archive', 'channel'].includes(name),
});

const indexCache = new Map<string, any>();

async function loadIndex(url: string): Promise<any> {
  const cached = indexCache.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch the Android SDK index from ${url} (HTTP ${res.status}).`);
  const doc = parser.parse(await res.text());
  const rootKey = Object.keys(doc).find((k) => !k.startsWith('?'));
  if (!rootKey) throw new Error(`Unexpected SDK index format at ${url}.`);
  indexCache.set(url, doc[rootKey]);
  return doc[rootKey];
}

function revision(p: any): number[] {
  const r = p.revision ?? {};
  return [Number(r.major ?? 0), Number(r.minor ?? 0), Number(r.micro ?? 0)];
}

function compareDesc(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

const text = (v: any): string => (typeof v === 'object' && v !== null ? String(v['#text'] ?? '') : String(v ?? ''));

function pickArchive(archives: any[]): any | undefined {
  return archives.find(
    (a) => (!a['host-os'] || text(a['host-os']) === host.os) && (!a['host-arch'] || text(a['host-arch']) === host.arch),
  );
}

/** Find the newest stable build of an SDK package (e.g. "emulator") for this host. */
export async function findPackage(pkgPath: string): Promise<RemotePackage> {
  let base = REPO;
  let indexUrl = `${REPO}repository2-3.xml`;
  if (pkgPath.startsWith('system-images;')) {
    const tag = pkgPath.split(';')[2];
    base = `${REPO}sys-img/${tag}/`;
    indexUrl = `${base}sys-img2-3.xml`;
  }
  const root = await loadIndex(indexUrl);
  const stable = (root.channel ?? []).find((c: any) => text(c) === 'stable')?.['@_id'] ?? 'channel-0';
  const candidates = (root.remotePackage ?? [])
    .filter((p: any) => p['@_path'] === pkgPath && (p.channelRef?.['@_ref'] ?? stable) === stable)
    .sort((a: any, b: any) => compareDesc(revision(a), revision(b)));

  for (const p of candidates) {
    const archive = pickArchive(p.archives?.archive ?? []);
    if (!archive) continue;
    const file = text(archive.complete.url);
    return {
      path: pkgPath,
      revision: revision(p).join('.'),
      url: /^https?:/.test(file) ? file : base + file,
      size: Number(text(archive.complete.size)),
      sha1: text(archive.complete.checksum).toLowerCase(),
    };
  }
  throw new Error(`No stable "${pkgPath}" package is published for ${host.os}/${host.arch}.`);
}
