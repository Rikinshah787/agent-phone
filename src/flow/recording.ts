import YAML from 'yaml';
import { asObject, type Selector } from './selectors.js';

/** One Maestro command: a bare name ("back") or { name: argument }. */
export type Command = string | Record<string, unknown>;

const SCROLL_TO_DIRECTION: Record<string, string> = { down: 'DOWN', up: 'UP', left: 'LEFT', right: 'RIGHT' };

/** The steps an agent took since phone_test_start, kept as Maestro commands. */
export class Recording {
  private steps: Command[] = [];
  /** Scrolls are held back until we know what the agent scrolled to. */
  private pendingScrolls: { direction: string; command: Command }[] = [];

  constructor(
    readonly appId: string,
    readonly startedAt = new Date(),
  ) {}

  get length(): number {
    return this.steps.length + this.pendingScrolls.length;
  }

  add(command: Command): void {
    this.flushScrolls();
    this.steps.push(command);
  }

  scroll(direction: string, command: Command): void {
    this.pendingScrolls.push({ direction, command });
  }

  /**
   * Record acting on an element. If the agent scrolled to find it, the scrolls become a
   * scrollUntilVisible, so the test still works when the list is longer or shorter.
   */
  act(command: string, selector: Selector): void {
    const p = this.pendingScrolls;
    if (p.length > 0 && p.every((s) => s.direction === p[0].direction) && !asObject(selector).point) {
      this.pendingScrolls = [];
      this.steps.push({ scrollUntilVisible: { element: selector, direction: SCROLL_TO_DIRECTION[p[0].direction] } });
    }
    this.add({ [command]: selector });
  }

  private flushScrolls(): void {
    for (const s of this.pendingScrolls) this.steps.push(s.command);
    this.pendingScrolls = [];
  }

  toYaml(name: string): string {
    this.flushScrolls();
    const header = [
      `# ${name}`,
      `# Recorded by agent-phone on ${this.startedAt.toISOString().slice(0, 10)}.`,
      '# Replay: npx agent-phone test <this file>    (format: Maestro flow, https://maestro.dev)',
    ].join('\n');
    return `${header}\n${YAML.stringify({ appId: this.appId })}---\n${YAML.stringify(this.steps)}`;
  }
}
