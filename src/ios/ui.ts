import type { UiElement, UiNode, UiSnapshot } from '../phone/ui.js';

/**
 * Parses `axe describe-ui` output (the iOS accessibility tree, in points) into the same
 * snapshot shape the Android parser produces, so selectors, recording and the element
 * list work the same on both platforms.
 */

const ACTIONABLE = new Set([
  'Button', 'Link', 'Cell', 'Switch', 'Toggle', 'TextField', 'SecureTextField', 'SearchField', 'TextView',
  'Slider', 'Stepper', 'SegmentedControl', 'Tab', 'TabBarButton', 'MenuItem', 'CheckBox', 'RadioButton',
  'PopUpButton', 'Picker', 'PickerWheel', 'Key', 'Incrementor', 'DisclosureTriangle',
]);
const EDITABLE = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);
const SCROLLABLE = new Set(['ScrollView', 'ScrollArea', 'Table', 'CollectionView', 'WebView']);
const TOGGLES = new Set(['Switch', 'Toggle', 'CheckBox']);

const MAX_LABEL = 100;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/** Element kind without the "AX" prefix: "Button", "StaticText", ... */
function kindOf(n: any): string {
  return str(n.type) || str(n.role).replace(/^AX/, '') || 'Element';
}

function frameOf(n: any): [number, number, number, number] {
  const f = n.frame;
  if (f && typeof f === 'object') {
    const x = Number(f.x ?? 0);
    const y = Number(f.y ?? 0);
    return [x, y, x + Number(f.width ?? 0), y + Number(f.height ?? 0)];
  }
  // "{{x, y}, {w, h}}"
  const m = /\{\{(-?[\d.]+),\s*(-?[\d.]+)\},\s*\{([\d.]+),\s*([\d.]+)\}\}/.exec(str(n.AXFrame));
  if (!m) return [0, 0, 0, 0];
  const [x, y, w, h] = m.slice(1).map(Number);
  return [x, y, x + w, y + h];
}

export function parseIosUi(json: string): UiSnapshot {
  const data = JSON.parse(json);
  const roots: any[] = Array.isArray(data) ? data : [data];
  const elements: UiElement[] = [];
  const nodes: UiNode[] = [];
  let width = 0;
  let height = 0;
  let appName = '';
  // iOS often reports one thing several times (a container, then the button inside it).
  const byKey = new Map<string, UiElement>();

  /**
   * A tappable row usually contains its own label again, split into texts ("iOS Version",
   * "26.5") plus an icon and a chevron. List the row once and leave those parts out.
   * Scroll-bar indicators are left out too.
   */
  const visit = (n: any, insideLabel?: string) => {
    if (!n || typeof n !== 'object') return;
    const kind = kindOf(n);
    const bounds = frameOf(n);
    const label = str(n.AXLabel ?? n.label);
    const value = str(n.AXValue ?? n.value);
    const placeholder = str(n.AXPlaceholderValue ?? n.placeholder);
    const id = str(n.AXUniqueId ?? n.identifier);

    if (kind === 'Application') {
      appName ||= label;
      width = Math.max(width, bounds[2]);
      height = Math.max(height, bounds[3]);
    } else {
      const visible = bounds[2] > bounds[0] && bounds[3] > bounds[1];
      const toggle = TOGGLES.has(kind);
      const editable = EDITABLE.has(kind);
      const node: UiNode = {
        text: label,
        desc: toggle ? '' : value,
        hint: placeholder,
        resourceId: id,
        checked: toggle ? value === '1' || value.toLowerCase() === 'on' || value.toLowerCase() === 'true' : undefined,
        bounds,
      };
      if (visible) nodes.push(node);
      const actionable = ACTIONABLE.has(kind) || SCROLLABLE.has(kind);
      const shown = label || (editable ? value || placeholder : '') || (toggle ? '' : value);
      const redundant =
        insideLabel !== undefined &&
        !toggle &&
        !editable &&
        (n.enabled === false || (!label && !id) || kind === 'Image' || (label !== '' && insideLabel.includes(label)));
      const noise = kind === 'Slider' && /scroll bar/i.test(label);
      const key = `${label}|${id}|${bounds.map(Math.round).join(',')}`;
      const existing = byKey.get(key);
      if (existing && visible) {
        if (actionable && !existing.actionable) {
          existing.kind = kind;
          existing.actionable = true;
          existing.flags = existing.flags.filter((f) => f !== 'text');
          existing.node = node;
        }
      } else if (visible && !redundant && !noise && (actionable || shown)) {
        const flags: string[] = [];
        if (editable) flags.push(kind === 'SecureTextField' ? 'password-input' : 'input');
        if (editable && placeholder) flags.push(`hint="${truncate(placeholder)}"`);
        if (editable && value && value !== placeholder) flags.push(`value="${truncate(value)}"`);
        if (toggle) flags.push(node.checked ? 'checked' : 'unchecked');
        if (SCROLLABLE.has(kind)) flags.push('scrollable');
        if (n.enabled === false) flags.push('disabled');
        if (!actionable) flags.push('text');
        const element: UiElement = {
          ref: elements.length + 1,
          kind,
          label: truncate(editable ? label || placeholder : shown),
          id: id || undefined,
          bounds,
          flags,
          actionable,
          editable,
          textLength: editable && value !== placeholder ? value.length : 0,
          node,
        };
        elements.push(element);
        byKey.set(key, element);
      }
    }
    const actionableHere = ACTIONABLE.has(kind) && kind !== 'Application';
    const passDown = actionableHere && label ? label : insideLabel;
    for (const child of n.children ?? []) visit(child, passDown);
  };
  roots.forEach((r) => visit(r));
  // The app's own frame is the screen; fall back to everything visible if it's missing.
  if (!width || !height) {
    for (const node of nodes) {
      width = Math.max(width, node.bounds[2]);
      height = Math.max(height, node.bounds[3]);
    }
  }

  return { pkg: appName, width, height, windows: [{ pkg: appName, type: 'TYPE_APPLICATION', elements }], elements, nodes };
}
