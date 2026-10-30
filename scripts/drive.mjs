#!/usr/bin/env node
// Drive agent-phone through its MCP server, the same way an agent does.
//
//   node scripts/drive.mjs <out-dir> '[["phone_start", {}], ["phone_tap", {"text": "General"}]]'
//
// Prints each tool result with its timing, saves screenshots into <out-dir>, and exits 1
// if any tool reports an error. Used by CI and handy when developing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [outDir, stepsJson] = process.argv.slice(2);
if (!outDir || !stepsJson) {
  console.error('Usage: node scripts/drive.mjs <out-dir> \'[["tool", {args}], ...]\'');
  process.exit(2);
}
const steps = JSON.parse(stepsJson);
fs.mkdirSync(outDir, { recursive: true });

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js').replace(/\\/g, '/');
const client = new Client({ name: 'drive', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp'], stderr: 'inherit' }));

let failures = 0;
for (const [i, [name, args = {}]] of steps.entries()) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n=== ${i + 1}. ${name} ${JSON.stringify(args)} (${secs}s${result.isError ? ', ERROR' : ''})`);
  for (const c of result.content) {
    if (c.type === 'text') console.log(c.text);
    if (c.type === 'image') {
      const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${name}.png`);
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`[screenshot: ${file}]`);
    }
  }
  if (result.isError) failures++;
}
await client.close();
console.log(`\n${steps.length - failures}/${steps.length} steps succeeded`);
process.exit(failures ? 1 : 0);
