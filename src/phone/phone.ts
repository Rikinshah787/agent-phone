import type { FlowResult, StepResult } from '../flow/runner.js';
import type { Direction, LogOptions, Platform, Screenshot, Target } from './base.js';

export interface TypeOptions extends Target {
  clear?: boolean;
  submit?: boolean;
}

/**
 * Everything the MCP tools and the CLI do with a phone. A phone on this computer
 * implements it directly (PhoneBase); an iPhone on a Mac across the network implements
 * it by forwarding each call over SSH (RemotePhone).
 */
export interface Phone {
  readonly id: string;
  readonly platform: Platform;
  observe(settleMs?: number): Promise<string>;
  screenshot(): Promise<Screenshot>;
  tap(t: Target, long?: boolean): Promise<string>;
  type(text: string, opts: TypeOptions): Promise<string>;
  scroll(direction: Direction, ref?: number): Promise<string>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<string>;
  key(name: string): Promise<string>;
  open(target: string): Promise<string>;
  /** Install an app from a file on this computer. */
  install(file: string): Promise<string>;
  packages(): Promise<string[]>;
  appAction(action: 'stop' | 'clear' | 'uninstall', target: string): Promise<string>;
  logs(opts: LogOptions): Promise<string>;
  startTest(app?: string, clearState?: boolean): Promise<string>;
  assert(what: { text?: string; id?: string; checked?: boolean }, visible?: boolean): Promise<{ ok: boolean; message: string }>;
  /** The recording so far as Maestro YAML. */
  testYaml(name: string): Promise<{ yaml: string; steps: number }>;
  /** Replay a flow file from this computer. */
  runFlow(file: string, onStep?: (r: StepResult) => void): Promise<FlowResult>;
  shell(command: string): Promise<string>;
}
