export interface DeviceProfile {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Screen density in dpi, which decides how big things look (dp = px * 160 / density). */
  density: number;
  ramMb: number;
}

/**
 * Emulators reproduce a phone's screen, density, RAM and Android version.
 * They do not reproduce manufacturer skins or real hardware.
 */
export const PROFILES: DeviceProfile[] = [
  { id: 'pixel-8', name: 'Pixel 8', width: 1080, height: 2400, density: 420, ramMb: 4096 },
  { id: 'pixel-8-pro', name: 'Pixel 8 Pro', width: 1344, height: 2992, density: 480, ramMb: 4096 },
  { id: 'small-phone', name: 'Budget phone (720p, 2 GB RAM)', width: 720, height: 1600, density: 320, ramMb: 2048 },
  { id: 'compact', name: 'Compact phone (360x640 dp)', width: 1080, height: 1920, density: 480, ramMb: 3072 },
  { id: 'tablet', name: 'Pixel Tablet', width: 2560, height: 1600, density: 320, ramMb: 4096 },
];

export interface ProfileSpec {
  device?: string;
  width?: number;
  height?: number;
  density?: number;
}

export function resolveProfile(spec: ProfileSpec): DeviceProfile {
  if (spec.width && spec.height) {
    const density = spec.density ?? 420;
    return {
      id: `custom-${spec.width}x${spec.height}-${density}`,
      name: `Custom ${spec.width}x${spec.height} @ ${density} dpi`,
      width: spec.width,
      height: spec.height,
      density,
      ramMb: 4096,
    };
  }
  const id = (spec.device ?? 'pixel-8').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const found = PROFILES.find((p) => p.id === id);
  if (!found) {
    throw new Error(
      `Unknown device "${spec.device}". Choose one of: ${PROFILES.map((p) => p.id).join(', ')}, ` +
        'or pass width, height and density for any other phone.',
    );
  }
  return found;
}
