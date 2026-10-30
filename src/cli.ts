#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkAcceleration } from './android/emulator.js';
import { DEFAULT_ANDROID, DEFAULT_TAG, paths } from './config.js';
import { runMcpServer } from './mcp.js';
import { Phones } from './phones.js';
import { ensureInstalled, requiredComponents } from './sdk/installer.js';
import { log } from './util/log.js';

const VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `agent-phone ${VERSION}: give your AI agent a phone

Usage
  agent-phone setup [--device pixel-8] [--android ${DEFAULT_ANDROID}] [--no-start]
                         Download what's needed and boot a phone
  agent-phone start [device] [--android N] [--headless] [--wipe]
                         Boot a phone (device profile, default pixel-8)
  agent-phone stop [serial]
  agent-phone list       Connected devices and device profiles
  agent-phone look [--out screen.png]
                         Print what's on screen, optionally save a screenshot
  agent-phone doctor     Check the installation
  agent-phone mcp        Run the MCP server (this is what your agent connects to)

With no command, agent-phone runs setup in a terminal and the MCP server otherwise.
Files live in ${paths.home} (override with AGENT_PHONE_HOME).
`;

function connectHint(): string {
  const script = process.argv[1] ?? '';
  const cmd = script.includes('_npx') ? 'npx -y agent-phone mcp' : `node "${path.resolve(script)}" mcp`;
  return `Connect it to Claude Code:\n  claude mcp add phone -- ${cmd}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      device: { type: 'string' },
      android: { type: 'string' },
      headless: { type: 'boolean' },
      wipe: { type: 'boolean' },
      'no-start': { type: 'boolean' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.version) return void console.log(VERSION);
  if (values.help) return void console.log(HELP);

  const command = positionals[0] ?? (process.stdin.isTTY ? 'setup' : 'mcp');
  const android = values.android ? Number(values.android) : undefined;
  const phones = new Phones();

  switch (command) {
    case 'mcp':
      return runMcpServer(VERSION);

    case 'setup':
    case 'start': {
      if (command === 'setup' && values['no-start']) {
        await ensureInstalled(android ?? DEFAULT_ANDROID);
        await checkAcceleration();
        log(`\nEverything is installed.\n${connectHint()}`);
        return;
      }
      const s = await phones.start({
        device: values.device ?? positionals[1],
        android,
        headless: values.headless,
        wipe: values.wipe,
        onProgress: () => {}, // installer and emulator already log to stderr
      });
      log(`\n${s.profile.name} (Android API ${s.api}) is running as ${s.device.serial}.`);
      if (command === 'setup') log(`\n${connectHint()}`);
      return;
    }

    case 'stop':
      return log(await phones.stop(positionals[1]));

    case 'list':
      return console.log(await phones.status());

    case 'look': {
      const d = await phones.get(positionals[1]);
      console.log(d.describe(await d.ui()));
      if (values.out) {
        const shot = await d.screenshot();
        fs.writeFileSync(values.out, shot.png);
        log(`Saved ${shot.width}x${shot.height} screenshot to ${path.resolve(values.out)}`);
      }
      return;
    }

    case 'doctor': {
      console.log(`agent-phone ${VERSION}\nSDK: ${paths.sdk}`);
      for (const c of requiredComponents(android ?? DEFAULT_ANDROID, DEFAULT_TAG)) {
        const marker = path.join(c.dest, '.agent-phone-installed.json');
        const rev = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')).revision : undefined;
        console.log(`  ${c.label}: ${rev ? `installed (${rev})` : 'missing'}`);
      }
      try {
        await checkAcceleration();
        console.log('Hardware acceleration: OK');
      } catch (e: any) {
        console.log(`Hardware acceleration: PROBLEM\n${e.message}`);
      }
      console.log(`\n${await phones.status().catch((e) => e.message)}`);
      return;
    }

    case 'help':
      return void console.log(HELP);

    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  log(`\nError: ${e?.message ?? e}`);
  process.exit(1);
});
