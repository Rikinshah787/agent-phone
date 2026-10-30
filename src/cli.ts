#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkAcceleration } from './android/emulator.js';
import { DEFAULT_ANDROID, DEFAULT_TAG, PACKAGE_SPEC, paths } from './config.js';
import { FlowRunner } from './flow/runner.js';
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
                         Boot an Android phone (device profile, default pixel-8)
  agent-phone start --platform ios ["iPhone 17 Pro"] [--ios 26.5] [--headless]
                         Boot an iPhone simulator (macOS only)
  agent-phone stop [serial]
  agent-phone list       Connected devices and device profiles
  agent-phone look [--out screen.png]
                         Print what's on screen, optionally save a screenshot
  agent-phone test <flow.yaml | folder>... [--serial S]
                         Replay recorded tests (Maestro format); exits 1 on failure
  agent-phone doctor     Check the installation
  agent-phone mcp        Run the MCP server (this is what your agent connects to)

With no command, agent-phone runs setup in a terminal and the MCP server otherwise.
Files live in ${paths.home} (override with AGENT_PHONE_HOME).
`;

/** Expand folders to the flow files inside them (Maestro's config.yaml is not a flow). */
function flowFiles(targets: string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    if (!fs.existsSync(abs)) throw new Error(`No such file or folder: ${t}`);
    if (fs.statSync(abs).isDirectory()) {
      out.push(
        ...fs
          .readdirSync(abs)
          .filter((f) => /\.ya?ml$/i.test(f) && !/^config\.ya?ml$/i.test(f))
          .sort()
          .map((f) => path.join(abs, f)),
      );
    } else {
      out.push(abs);
    }
  }
  return out;
}

function connectHint(): string {
  const script = process.argv[1] ?? '';
  const cmd = script.includes('_npx') ? `npx -y ${PACKAGE_SPEC} mcp` : `node "${path.resolve(script)}" mcp`;
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
      serial: { type: 'string' },
      platform: { type: 'string' },
      ios: { type: 'string' },
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
        platform: values.platform === 'ios' || values.ios ? 'ios' : undefined,
        ios: values.ios,
        device: values.device ?? positionals[1],
        android,
        headless: values.headless,
        wipe: values.wipe,
        onProgress: () => {}, // installer and emulator already log to stderr
      });
      log(`\n${s.description} is running as ${s.device.id}.`);
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

    case 'test': {
      const files = flowFiles(positionals.slice(1));
      if (files.length === 0) throw new Error('Pass one or more flow files or folders, e.g. `agent-phone test .maestro`.');
      const device = await phones.get(values.serial);
      let failed = 0;
      for (const file of files) {
        console.log(`\n${path.relative(process.cwd(), file) || file}`);
        const runner = new FlowRunner(device, (s) =>
          console.log(`  ${s.ok ? '✓' : '✗'} ${s.step}. ${s.command}: ${s.detail} (${(s.ms / 1000).toFixed(1)}s)`),
        );
        const result = await runner.run(file);
        if (result.passed) {
          console.log(`  PASSED in ${(result.ms / 1000).toFixed(1)}s`);
        } else {
          failed++;
          const shot = file.replace(/\.ya?ml$/i, '') + '.failure.png';
          fs.writeFileSync(shot, (await device.screenshot()).png);
          console.log(`  FAILED (screenshot: ${shot})`);
        }
      }
      console.log(`\n${files.length - failed} passed, ${failed} failed`);
      process.exitCode = failed > 0 ? 1 : 0;
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
