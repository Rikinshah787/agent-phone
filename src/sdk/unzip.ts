import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';

/**
 * Extract a zip into destDir. Rejects entries that would land outside destDir and
 * skips symlinks that point outside it. Unix file modes are preserved so the
 * emulator binaries stay executable on macOS and Linux.
 */
export function unzip(zipPath: string, destDir: string): Promise<void> {
  const root = path.resolve(destDir);
  const inside = (p: string) => p === root || p.startsWith(root + path.sep);

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr ?? new Error(`Could not open ${zipPath}`));
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        const target = path.resolve(root, entry.fileName);
        if (!inside(target)) return reject(new Error(`Unsafe path in archive: ${entry.fileName}`));

        if (entry.fileName.endsWith('/')) {
          fs.mkdir(target, { recursive: true }, (e) => (e ? reject(e) : zip.readEntry()));
          return;
        }

        const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
        const isLink = (mode & 0o170000) === 0o120000;

        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr);
          fs.mkdirSync(path.dirname(target), { recursive: true });

          if (isLink) {
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('error', reject);
            stream.on('end', () => {
              const linkTarget = Buffer.concat(chunks).toString('utf8');
              if (!inside(path.resolve(path.dirname(target), linkTarget))) return zip.readEntry();
              fs.symlink(linkTarget, target, () => zip.readEntry());
            });
            return;
          }

          const out = fs.createWriteStream(target, { mode: mode & 0o777 || 0o644 });
          stream.on('error', reject);
          out.on('error', reject);
          out.on('finish', () => zip.readEntry());
          stream.pipe(out);
        });
      });
      zip.readEntry();
    });
  });
}
