# agent-phone

Give your AI agent a phone.

`agent-phone` sets up an Android emulator with one command (no Android Studio, no Java) and hands it to your agent over [MCP](https://modelcontextprotocol.io). Your agent can then install the app it just built, look at the screen, tap through it, type, scroll, and read the logs when something crashes.

```
npx agent-phone                                    # downloads what's needed and boots a phone
claude mcp add phone -- npx -y agent-phone mcp     # connects it to Claude Code
```

Then ask your agent something like *"install app-debug.apk on the phone and check that sign-up works"*.

## What the agent gets

| Tool | What it does |
| --- | --- |
| `phone_start` | Boot a phone (choose a device profile or any screen size and Android version). Installs anything missing first. |
| `phone_look` | Screenshot plus a numbered list of everything on screen. |
| `phone_tap` | Tap by element number, by visible text, or by x/y. Long-press too. |
| `phone_type` | Type into a field. Can clear it first and press Enter after. |
| `phone_scroll` / `phone_swipe` | Scroll the screen or a list, or drag between two points. |
| `phone_key` | Back, home, recents, enter, volume and other keys. |
| `phone_open` | Open an app by package name, a URL or deep link, or Settings. |
| `phone_install` | Install an APK from your computer, grant its permissions, and optionally open it. |
| `phone_app` | List installed apps, or stop, clear data for, or uninstall one. |
| `phone_logs` | Read logcat for one app, at a minimum level, or crashes only. |
| `phone_shell` | Run any `adb shell` command. |
| `phone_list` / `phone_stop` | See connected devices and profiles; shut a phone down. |

After every action the agent gets the updated screen back as a list like this, so it rarely needs a screenshot:

```
App: com.android.settings · screen 576x1280
[1] ViewGroup "Search settings" id=search_action_bar @288,93
[6] LinearLayout "Network & internet · Mobile, Wi-Fi, hotspot" @288,438
[7] Switch id=switchWidget unchecked @517,545
```

If the app crashes, the result starts with `CRASH DETECTED` and the stack trace.

## Device profiles

| Profile | Screen | RAM |
| --- | --- | --- |
| `pixel-8` (default) | 1080x2400, 420 dpi | 4 GB |
| `pixel-8-pro` | 1344x2992, 480 dpi | 4 GB |
| `small-phone` | 720x1600, 320 dpi | 2 GB |
| `compact` | 1080x1920, 480 dpi | 3 GB |
| `tablet` | 2560x1600, 320 dpi | 4 GB |

Any other phone: pass `width`, `height` and `density`. Any Android version: pass `android` (API level, default 35 = Android 15). An emulator matches a phone's screen, density, memory and Android version, not its manufacturer skin or hardware.

Physical Android phones work too. Turn on USB debugging, plug the phone in, and it shows up in `phone_list`.

## How it works

- Downloads the emulator, platform tools and a system image straight from Google's SDK repository (`dl.google.com`) into `~/.agent-phone`, checking every file's SHA-1. About 2 GB on first run. Downloading means you accept the [Android SDK License](https://developer.android.com/studio/terms).
- Creates virtual devices itself, so no Java or `sdkmanager` is needed.
- Phones are started detached, so they keep running between agent sessions and restart from a snapshot in seconds.
- To make automation reliable, phones started by agent-phone have animations turned off, the screen kept awake, and the on-screen keyboard hidden (typing goes through the emulator's hardware keyboard).
- Coordinates the agent sees and sends are in screenshot pixels. Screenshots are scaled to at most 1280 px on the long edge.

## Requirements

- Node.js 20.15 or newer
- About 3 GB of disk space
- Hardware virtualization:
  - **Windows**: "Windows Hypervisor Platform" turned on. `agent-phone doctor` tells you if it isn't, and how to fix it.
  - **macOS**: works out of the box (Apple Silicon and Intel).
  - **Linux**: KVM.

## CLI

```
agent-phone setup [--device pixel-8] [--android 35] [--no-start]
agent-phone start [device] [--android N] [--headless] [--wipe]
agent-phone stop [serial]
agent-phone list
agent-phone look [serial] [--out screen.png]
agent-phone doctor
agent-phone mcp
```

Set `AGENT_PHONE_HOME` to keep everything somewhere other than `~/.agent-phone`.

## Current limits

- Android only. iOS needs macOS, so it will come as a backend that drives a Mac (yours or a cloud Mac) over the network.
- Each action takes about 3-4 seconds, mostly Android's `uiautomator dump`. A resident on-device helper will make this much faster.
- Typing supports plain ASCII text only.
- Building apps is up to your agent and your project's toolchain for now.

## Developing

```
npm install
npm run build
node dist/cli.js doctor
```

This repo's `.mcp.json` points Claude Code at the local build, so opening Claude Code in this folder gives it the phone tools.
