import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KEY_NAMES } from './android/device.js';
import { PROFILES } from './android/profiles.js';
import { DEFAULT_ANDROID } from './config.js';
import { Phones } from './phones.js';

const INSTRUCTIONS = `agent-phone gives you an Android phone (a local emulator, or a USB-connected phone) for running and testing apps.

- Start with phone_start. The first run downloads about 2 GB of Android components and can take several minutes.
- Every action returns the screen afterwards as a numbered list: [ref] Class "label" flags @x,y. Act on things by ref, or by their visible text.
- phone_look also returns a screenshot. Use it when the list isn't enough: layout, colours, images, games or custom-drawn UI.
- x/y coordinates are always pixels in the screenshot.
- Typical app test loop: build the APK, phone_install (open: true), interact, then phone_logs if something looks wrong. "CRASH DETECTED" in a result means the app crashed.`;

type Result = { content: any[]; isError?: boolean };

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
        `Boot an Android phone, installing anything missing first. Choose a device profile (${PROFILES.map((p) => p.id).join(', ')}), ` +
        `or pass width/height/density to match any phone. Reuses the phone if it's already running.`,
      inputSchema: {
        device: z.string().optional().describe(`Device profile. Default ${PROFILES[0].id}.`),
        width: z.number().int().optional().describe('Custom screen width in pixels.'),
        height: z.number().int().optional().describe('Custom screen height in pixels.'),
        density: z.number().int().optional().describe('Custom screen density in dpi (e.g. 420).'),
        android: z.number().int().optional().describe(`Android API level. Default ${DEFAULT_ANDROID} (Android 15).`),
        headless: z.boolean().optional().describe('Run without a window. Default false, so the user can watch.'),
        wipe: z.boolean().optional().describe('Factory-reset the phone before booting.'),
      },
    },
    (args, extra) =>
      run(async () => {
        const token = extra._meta?.progressToken;
        let step = 0;
        const onProgress = (message: string) => {
          if (token === undefined) return;
          extra
            .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } } as any)
            .catch(() => {});
        };
        const s = await phones.start({ ...args, onProgress });
        return `${s.profile.name} (Android API ${s.api}) is running as ${s.device.serial}.\n\n${await s.device.observe(0)}`;
      }),
  );

  server.registerTool(
    'phone_stop',
    { title: 'Shut down a phone', description: 'Shut down a running emulator.', inputSchema: { serial } },
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
    'phone_shell',
    {
      title: 'Run a shell command',
      description: 'Run a command in the device shell (adb shell). For anything the other tools do not cover.',
      inputSchema: { command: z.string(), serial },
    },
    (args) =>
      run(async () => {
        const d = await phones.get(args.serial);
        const r = await phones.adb.shell(d.serial, args.command, 120_000);
        const parts = [r.out.trim(), r.err && `stderr: ${r.err}`, r.code !== 0 && `exit code ${r.code}`].filter(Boolean);
        return parts.join('\n') || '(no output)';
      }),
  );

  await server.connect(new StdioServerTransport());
}
