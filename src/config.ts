import os from 'node:os';
import path from 'node:path';

/** Everything agent-phone owns lives here, isolated from any Android Studio install. */
export const HOME = process.env.AGENT_PHONE_HOME ?? path.join(os.homedir(), '.agent-phone');

export const paths = {
  home: HOME,
  sdk: process.env.AGENT_PHONE_SDK ?? path.join(HOME, 'sdk'),
  avd: path.join(HOME, 'avd'),
  downloads: path.join(HOME, 'downloads'),
  logs: path.join(HOME, 'logs'),
};

const isWin = process.platform === 'win32';

export const host = {
  /** Host OS name as used by Google's SDK repository XML. */
  os: isWin ? 'windows' : process.platform === 'darwin' ? 'macosx' : 'linux',
  arch: process.arch === 'arm64' ? 'aarch64' : 'x64',
  /** System-image ABI that runs natively (hardware accelerated) on this host. */
  abi: process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64',
  exe: isWin ? '.exe' : '',
};

export const tools = {
  adb: path.join(paths.sdk, 'platform-tools', `adb${host.exe}`),
  emulator: path.join(paths.sdk, 'emulator', `emulator${host.exe}`),
};

/** What `npx` installs this from. Becomes 'agent-phone' once the package is on npm. */
export const PACKAGE_SPEC = 'github:Rikinshah787/agent-phone';

export const DEFAULT_ANDROID = 35;
export const DEFAULT_TAG = 'google_apis';
export const DEFAULT_DEVICE = 'pixel-8';

/** Screenshots are scaled so the long edge is at most this many pixels. */
export const SCREENSHOT_MAX_EDGE = 1280;

/** Environment for emulator/adb child processes so they use our SDK and AVD folders. */
export function androidEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: paths.sdk,
    ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_AVD_HOME: paths.avd,
  };
}
