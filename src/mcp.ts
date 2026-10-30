import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KEY_NAMES } from './phone/base.js';
import fs from 'node:fs';
import type { FlowResult } from './flow/runner.js';
import { PROFILES } from './android/profiles.js';
import { DEFAULT_ANDROID } from './config.js';
import { Phones } from './phones.js';
import { log } from './util/log.js';

const INSTRUCTIONS = `agent-phone gives you an Android phone (a local emulator, or a USB-connected phone) for running and testing apps.

- Start with phone_start. The first run downloads about 2 GB of Android components and can take several minutes.
- Every action returns the screen afterwards as a numbered list: [ref] Class "label" flags @x,y. Act on things by ref, or by their visible text.
- phone_look also returns a screenshot. Use it when the list isn't enough: layout, colours, images, games or custom-drawn UI.
- x/y coordinates are always pixels in the screenshot.
- Typical app test loop: build the APK, phone_install (open: true), interact, then phone_logs if something looks wrong. "CRASH DETECTED" in a result means the app crashed.

Turning what you do into a repeatable test:
1. phone_test_start with the app's package. The app restarts and every following action is recorded with a stable selector (text or id, not pixels).
2. Drive the app as usual. Use phone_assert to check what should be on screen; passing checks become test assertions.
3. phone_test_save writes a Maestro-format YAML flow (default ./.maestro/<name>.yaml).
4. phone_test_run replays it with no AI involved, to prove it passes. Tests run in CI with \`npx agent-phone test\` or with Maestro.`;

type Result = { content: any[]; isError?: boolean };

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'flow';
}

function formatFlow(r: FlowResult): string {
  const total = r.steps.length;
  const passed = r.steps.filter((s) => s.ok).length;
  const head = r.passed
    ? `PASSED ${path.basename(r.file)}: ${passed}/${total} steps in ${(r.ms / 1000).toFixed(1)}s`
    : `FAILED ${path.basename(r.file)} at step ${r.steps.find((s) => !s.ok)?.step ?? '?'}`;
  const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}. ${s.command}: ${s.detail} (${(s.ms / 1000).toFixed(1)}s)`);
  return [head, ...lines].join('\n');
}

async function run(fn: () => Promise<string | Result>): Promise<Result> {
  try {
    const r = await fn();
    return typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r;
  } catch (e: any) {
    return { content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true };
  }
}

const serial = z.string().optional().describe('Which device to use. Only needed when several are connected.');
const ref = z.number().int().optional().describe('Element number from the latest screen list.');

export async function runMcpServer(version: string): Promise<void> {
  const phones = new Phones();
  const server = new McpServer({ name: 'agent-phone', version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'phone_start',
    {
      title: 'Start a phone',
      description:
        'Boot a phone, installing anything missing first. Reuses it if it is already running. ' +
        `Android (default): choose a profile (${PROFILES.map((p) => p.id).join(', ')}) or pass width/height/density to match any phone. ` +
        'iPhone: set platform to "ios" and device to a model such as "iPhone 17 Pro" (iPhone simulators need macOS).',
      inputSchema: {
        platform: z.enum(['android', 'ios']).optional().describe('Default android.'),
        device: z.string().optional().describe(`Android profile (default ${PROFILES[0].id}) or iPhone model name.`),
        width: z.number().int().optional().describe('Custom screen width in pixels.'),
        height: z.number().int().optional().describe('Custom screen height in pixels.'),
        density: z.number().int().optional().describe('Custom screen density in dpi (e.g. 420).'),
        android: z.number().int().optional().describe(`Android API level. Default ${DEFAULT_ANDROID} (Android 15).`),
        ios: z.string().optional().describe('iOS version, e.g. "26.5". Default: the newest installed.'),
        headless: z.boolean().optional().describe('Run without a window. Default false, so the user can watch.'),
        wipe: z.boolean().optional().describe('Factory-reset the phone before booting.'),
      },
    },
    (args, extra) =>
      run(async () => {
        const token = extra._meta?.progressToken;
        let step = 0;
        const onProgress = (message: string) => {
          log(message);
          if (token === undefined) return;
          extra
            .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } } as any)
            .catch(() => {});
        };
        const s = await phones.start({ ...args, onProgress });
        return `${s.description} is running as ${s.device.id}.\n\n${await s.device.observe(0)}`;
      }),
  );

  server.registerTool(
    'phone_stop',
    { title: 'Shut down a phone', description: 'Shut down a running emulator or simulator.', inputSchema: { serial } },
    (args) => run(() => phones.stop(args.serial)),
  );

  server.registerTool(
    'phone_list',
    {
      title: 'List phones',
      description: 'Show connected devices and the available device profiles.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => phones.status()),
  );

  server.registerTool(
    'phone_look',
    {
      title: 'Look at the screen',
      description: 'Read the current screen: the numbered element list, plus a screenshot unless screenshot is false.',
      inputSchema: { screenshot: z.boolean().optional().describe('Include a screenshot. Default true.'), serial },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const text = await d.observe(0);
        if (args.screenshot === false) return text;
        const shot = await d.screenshot();
        return {
          content: [
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text },
          ],
        };
      }),
  );

  server.registerTool(
    'phone_tap',
    {
      title: 'Tap',
      description: 'Tap an element by ref or visible text, or a point by x/y (screenshot pixels). Set long for a long-press.',
      inputSchema: {
        ref,
        text: z.string().optional().describe('Visible text (or resource id) of the element to tap.'),
        x: z.number().optional(),
        y: z.number().optional(),
        long: z.boolean().optional().describe('Long-press instead of tap.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.tap(args, args.long)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_type',
    {
      title: 'Type text',
      description:
        'Type text into the focused field, or first tap a field given by ref or field (its visible text or hint). ' +
        'Newlines press Enter. ASCII only for now.',
      inputSchema: {
        text: z.string().describe('Text to type.'),
        ref,
        field: z.string().optional().describe('Visible text, hint or id of the field to type into.'),
        clear: z.boolean().optional().describe('Delete the existing text first.'),
        submit: z.boolean().optional().describe('Press Enter afterwards.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const msg = await d.type(args.text, { ref: args.ref, text: args.field, clear: args.clear, submit: args.submit });
        return `${msg}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_scroll',
    {
      title: 'Scroll',
      description: 'Scroll to reveal more content in a direction ("down" shows what is below). Optionally inside a scrollable element.',
      inputSchema: {
        direction: z.enum(['up', 'down', 'left', 'right']),
        ref: ref.describe('A scrollable element to scroll inside. Default: the whole screen.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.scroll(args.direction, args.ref)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_swipe',
    {
      title: 'Swipe',
      description: 'Drag a finger from one point to another (screenshot pixels). For gestures that scrolling does not cover.',
      inputSchema: {
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        duration_ms: z.number().optional().describe('Default 300.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.swipe(args.x1, args.y1, args.x2, args.y2, args.duration_ms)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_key',
    {
      title: 'Press a key',
      description: `Press a hardware or navigation key: ${KEY_NAMES.join(', ')}, or any Android KEYCODE_* name.`,
      inputSchema: { key: z.string(), serial },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.key(args.key)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_open',
    {
      title: 'Open an app or link',
      description: 'Open an installed app by package name (e.g. com.android.chrome), a URL or deep link (myapp://route), or "settings".',
      inputSchema: { target: z.string(), serial },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.open(args.target)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_install',
    {
      title: 'Install an APK',
      description: "Install (or update) an APK file from this computer, granting its permissions. Pass open with the app's package name to launch it afterwards.",
      inputSchema: {
        apk: z.string().describe('Path to the .apk file.'),
        open: z.string().optional().describe('Package name to open after installing.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const msg = await d.install(args.apk);
        if (!args.open) return msg;
        return `${msg}\n${await d.open(args.open)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_app',
    {
      title: 'Manage apps',
      description: 'List installed apps (action "list"), or force-stop, clear the data of, or uninstall an app by package name.',
      inputSchema: {
        action: z.enum(['list', 'stop', 'clear', 'uninstall']),
        package: z.string().optional(),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        if (args.action === 'list') {
          const pkgs = await d.packages();
          return pkgs.length ? `Installed apps (not counting system apps):\n${pkgs.join('\n')}` : 'No apps installed besides the system ones.';
        }
        if (!args.package) throw new Error(`Pass package to ${args.action} an app.`);
        return d.appAction(args.action, args.package);
      }),
  );

  server.registerTool(
    'phone_logs',
    {
      title: 'Read device logs',
      description: 'Read logcat. Filter to one app by package, by minimum level, or to crashes only. clear empties the log first.',
      inputSchema: {
        package: z.string().optional(),
        level: z.enum(['verbose', 'debug', 'info', 'warn', 'error']).optional().describe('Minimum level.'),
        lines: z.number().int().optional().describe('How many recent lines. Default 150.'),
        crashes: z.boolean().optional().describe('Only the crash buffer (uncaught exceptions, native crashes).'),
        clear: z.boolean().optional(),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return d.logs({ pkg: args.package, level: args.level, lines: args.lines, crashes: args.crashes, clear: args.clear });
      }),
  );

  server.registerTool(
    'phone_test_start',
    {
      title: 'Start recording a test',
      description:
        'Restart an app and record everything you do from here as a repeatable test. ' +
        'Defaults to the app currently on screen.',
      inputSchema: {
        app: z.string().optional().describe('Package name of the app under test, e.g. com.example.app.'),
        clear_state: z.boolean().optional().describe('Wipe the app data first so the test starts like a fresh install.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return `${await d.startTest(args.app, args.clear_state)}\n\n${await d.observe()}`;
      }),
  );

  server.registerTool(
    'phone_assert',
    {
      title: 'Check the screen',
      description:
        'Check that text (or an element id) is on screen, or with visible false that it is not. ' +
        'Waits up to 5 seconds. While recording, passing checks become assertions in the test.',
      inputSchema: {
        text: z.string().optional().describe('Text that should (or should not) be visible.'),
        id: z.string().optional().describe('Resource id of the element.'),
        checked: z.boolean().optional().describe('For switches and checkboxes: require this on/off state.'),
        visible: z.boolean().optional().describe('Default true.'),
        serial,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const r = await d.assert({ text: args.text, id: args.id, checked: args.checked }, args.visible ?? true);
        return r.ok ? r.message : { content: [{ type: 'text', text: `${r.message}\n\n${await d.observe(0)}` }], isError: true };
      }),
  );

  server.registerTool(
    'phone_test_save',
    {
      title: 'Save the recorded test',
      description: 'Write the recording as a Maestro-format YAML flow. Recording continues, so you can save again later.',
      inputSchema: {
        name: z.string().describe('Short test name, e.g. "sign up with email".'),
        path: z.string().optional().describe('File to write. Default ./.maestro/<name>.yaml in the current project.'),
        serial,
      },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const file = path.resolve(args.path ?? path.join('.maestro', `${slug(args.name)}.yaml`));
        const { yaml, steps } = await d.testYaml(args.name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, yaml);
        return `Saved ${steps} steps to ${file}\n\n${yaml}`;
      }),
  );

  server.registerTool(
    'phone_test_run',
    {
      title: 'Run a test',
      description: 'Replay a Maestro-format YAML flow on the phone, step by step, and report pass or fail. No AI is involved in the replay.',
      inputSchema: { path: z.string().describe('The .yaml flow file.'), serial },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const result = await d.runFlow(path.resolve(args.path));
        const report = formatFlow(result);
        if (result.passed) return report;
        const shot = await d.screenshot();
        return {
          content: [
            { type: 'text', text: `${report}\n\nScreen at the failure:\n${await d.observe(0)}` },
            { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
          ],
          isError: true,
        };
      }),
  );

  server.registerTool(
    'phone_shell',
    {
      title: 'Run a shell command',
      description: 'Run a command in the device shell (adb shell). For anything the other tools do not cover.',
      inputSchema: { command: z.string(), serial },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        return d.shell(args.command);
      }),
  );

  await server.connect(new StdioServerTransport());
}
