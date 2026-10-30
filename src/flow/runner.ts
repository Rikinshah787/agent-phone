import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { PhoneBase } from '../phone/base.js';
import type { UiNode } from '../phone/ui.js';
import { sleep } from '../util/exec.js';
import { asObject, describeSelector, matchSelector, type Selector } from './selectors.js';

export interface StepResult {
  step: number;
  command: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface FlowResult {
  file: string;
  passed: boolean;
  steps: StepResult[];
  ms: number;
}

const LOOKUP_TIMEOUT_MS = 10_000;

/** Maestro key names, as written in flows, mapped to agent-phone's key names. */
const KEYS: Record<string, string> = {
  enter: 'enter',
  backspace: 'backspace',
  home: 'home',
  back: 'back',
  tab: 'tab',
  lock: 'power',
  power: 'power',
  'volume up': 'volume_up',
  'volume down': 'volume_down',
  escape: 'escape',
};

class StepFailure extends Error {}

function center(n: UiNode): [number, number] {
  const [x1, y1, x2, y2] = n.bounds;
  return [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
}

/** "50%, 40%" or "540, 960" to device pixels. */
function parsePoint(spec: string, width: number, height: number): [number, number] {
  const parts = spec.split(',').map((p) => p.trim());
  if (parts.length !== 2) throw new StepFailure(`Bad point "${spec}". Use "x%, y%" or "x, y".`);
  const val = (p: string, size: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * size : parseFloat(p));
  return [Math.round(val(parts[0], width)), Math.round(val(parts[1], height))];
}

/**
 * Runs Maestro-format flows on a device without Maestro or Java. Supports the commands
 * agent-phone records plus the common hand-written ones; anything else fails with a
 * clear message so the flow can be run with Maestro instead.
 */
export class FlowRunner {
  constructor(
    private readonly device: PhoneBase,
    private readonly onStep?: (r: StepResult) => void,
  ) {}

  private appId = '';
  private flowDir = '.';

  async run(file: string): Promise<FlowResult> {
    const started = Date.now();
    const docs = YAML.parseAllDocuments(fs.readFileSync(file, 'utf8'));
    const bad = docs.find((d) => d.errors.length > 0);
    if (bad) throw new Error(`${file} is not valid YAML: ${bad.errors[0].message}`);
    const values = docs.map((d) => d.toJS());
    const commands = values.length >= 2 ? values[1] : values[0];
    const config = values.length >= 2 ? (values[0] ?? {}) : {};
    if (!Array.isArray(commands)) throw new Error(`${file} has no list of commands. A flow is "appId: ..." then "---" then a list.`);

    this.appId = String(config.appId ?? '');
    this.flowDir = path.dirname(path.resolve(file));
    const steps: StepResult[] = [];

    // Replays must not end up in a recording the agent might be making at the same time.
    const recording = this.device.recording;
    this.device.recording = undefined;
    try {
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        const [name, value] = typeof cmd === 'string' ? [cmd, undefined] : Object.entries(cmd ?? {})[0] ?? ['(empty)', undefined];
        const t = Date.now();
        let result: StepResult;
        try {
          const detail = await this.exec(name, value);
          result = { step: i + 1, command: name, ok: true, detail, ms: Date.now() - t };
        } catch (e: any) {
          result = { step: i + 1, command: name, ok: false, detail: e?.message ?? String(e), ms: Date.now() - t };
        }
        steps.push(result);
        this.onStep?.(result);
        if (!result.ok) break;
      }
    } finally {
      this.device.recording = recording;
    }
    return { file, passed: steps.length === commands.length && steps.every((s) => s.ok), steps, ms: Date.now() - started };
  }

  private async find(sel: Selector, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<UiNode | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snap = await this.device.ui();
      const hit = matchSelector(sel, snap.nodes)[0];
      if (hit) return hit;
      if (Date.now() >= deadline) return undefined;
      await sleep(500);
    }
  }

  /** Device-pixel point for a selector, waiting for the element to appear. */
  private async locate(sel: Selector): Promise<[number, number] | undefined> {
    const s = asObject(sel);
    if (s.point) {
      const snap = await this.device.ui();
      return parsePoint(s.point, snap.width, snap.height);
    }
    const node = await this.find(sel);
    if (node) return center(node);
    if (s.optional) return undefined;
    throw new StepFailure(`Could not find ${describeSelector(sel)} within ${LOOKUP_TIMEOUT_MS / 1000}s.`);
  }

  private appIdFrom(value: unknown): string {
    const id = typeof value === 'string' ? value : (value as any)?.appId ?? this.appId;
    if (!id) throw new StepFailure('No appId: set it at the top of the flow or on this command.');
    return String(id);
  }

  private async exec(name: string, value: any): Promise<string> {
    const d = this.device;
    switch (name) {
      case 'launchApp': {
        const appId = this.appIdFrom(value);
        const restart = value?.stopApp !== false;
        if (restart) await d.appAction('stop', appId);
        if (value?.clearState) await d.appAction('clear', appId);
        await d.open(appId, restart);
        return `Launched ${appId}`;
      }
      case 'stopApp':
        return d.appAction('stop', this.appIdFrom(value));
      case 'clearState':
        return d.appAction('clear', this.appIdFrom(value));
      case 'openLink':
        return d.open(String(typeof value === 'object' ? value.link : value));

      case 'tapOn':
      case 'longPressOn':
      case 'doubleTapOn': {
        const p = await this.locate(value);
        if (!p) return `Skipped optional ${describeSelector(value)}`;
        await d.tapDevicePoint(p[0], p[1], name === 'longPressOn');
        if (name === 'doubleTapOn') await d.tapDevicePoint(p[0], p[1]);
        return `${name} ${describeSelector(value)}`;
      }

      case 'inputText':
        await d.inputText(String(value));
        return `Typed ${JSON.stringify(String(value))}`;
      case 'eraseText':
        await d.erase(Number(value ?? 50));
        return `Erased ${Number(value ?? 50)} characters`;
      case 'pressKey': {
        const key = KEYS[String(value).toLowerCase()];
        if (!key) throw new StepFailure(`pressKey "${value}" is not supported by agent-phone yet.`);
        await d.pressKey(key);
        return `Pressed ${value}`;
      }
      case 'back':
        await d.pressKey('back');
        return 'Pressed back';
      case 'hideKeyboard':
        return 'Keyboard is already hidden on agent-phone devices';

      case 'scroll':
        await d.scrollDevice('down');
        return 'Scrolled down';
      case 'swipe': {
        const snap = await d.ui();
        const duration = Number(value?.duration ?? 400);
        if (value?.start && value?.end) {
          const [x1, y1] = parsePoint(value.start, snap.width, snap.height);
          const [x2, y2] = parsePoint(value.end, snap.width, snap.height);
          await d.swipeDevice(x1, y1, x2, y2, duration);
          return `Swiped ${value.start} to ${value.end}`;
        }
        const finger = String(value?.direction ?? '').toUpperCase();
        const scrollDir = ({ UP: 'down', DOWN: 'up', LEFT: 'right', RIGHT: 'left' } as const)[finger as 'UP'];
        if (!scrollDir) throw new StepFailure('swipe needs direction (UP, DOWN, LEFT, RIGHT) or start and end.');
        let box: [number, number, number, number] | undefined;
        if (value.from) {
          const node = await this.find(value.from);
          if (!node) throw new StepFailure(`Could not find ${describeSelector(value.from)} to swipe on.`);
          box = node.bounds;
        }
        await d.scrollDevice(scrollDir, box);
        return `Swiped ${finger}`;
      }
      case 'scrollUntilVisible': {
        const target: Selector = value?.element ?? value;
        const dir = String(value?.direction ?? 'DOWN').toLowerCase() as 'down';
        const timeout = Number(value?.timeout ?? 20_000);
        const deadline = Date.now() + timeout;
        for (;;) {
          if (await this.find(target, 0)) return `Found ${describeSelector(target)}`;
          if (Date.now() >= deadline) throw new StepFailure(`Scrolled for ${timeout / 1000}s without finding ${describeSelector(target)}.`);
          await d.scrollDevice(dir);
          await sleep(300);
        }
      }

      case 'assertVisible':
        if (!(await d.check(value, true, LOOKUP_TIMEOUT_MS))) throw new StepFailure(`Expected ${describeSelector(value)} to be visible.`);
        return `Visible: ${describeSelector(value)}`;
      case 'assertNotVisible':
        if (!(await d.check(value, false, LOOKUP_TIMEOUT_MS))) throw new StepFailure(`Expected ${describeSelector(value)} to be gone.`);
        return `Not visible: ${describeSelector(value)}`;
      case 'extendedWaitUntil': {
        const timeout = Number(value?.timeout ?? LOOKUP_TIMEOUT_MS);
        if (value?.visible && !(await d.check(value.visible, true, timeout))) throw new StepFailure(`${describeSelector(value.visible)} never appeared.`);
        if (value?.notVisible && !(await d.check(value.notVisible, false, timeout))) throw new StepFailure(`${describeSelector(value.notVisible)} never went away.`);
        return 'Wait condition met';
      }
      case 'waitForAnimationToEnd':
        await sleep(1000);
        return 'Waited for animations';

      case 'takeScreenshot': {
        const name = typeof value === 'object' ? value.path : value;
        const file = path.resolve(this.flowDir, `${String(name ?? 'screenshot')}.png`);
        fs.writeFileSync(file, (await d.screenshot()).png);
        return `Saved ${file}`;
      }
      case 'runFlow': {
        const file = path.resolve(this.flowDir, String(typeof value === 'object' ? value.file : value));
        const nested = await new FlowRunner(d, this.onStep).run(file);
        if (!nested.passed) throw new StepFailure(`Sub-flow ${file} failed.`);
        return `Ran ${file}`;
      }
      default:
        throw new StepFailure(`"${name}" isn't supported by agent-phone's runner yet. This flow can still run with Maestro.`);
    }
  }
}
