import { XMLParser } from 'fast-xml-parser';

/** Every visible node on screen, with the raw attributes test selectors match against. */
export interface UiNode {
  text: string;
  desc: string;
  hint: string;
  resourceId: string;
  /** Switch/checkbox state; undefined when the node can't be checked. */
  checked?: boolean;
  bounds: [number, number, number, number];
}

export interface UiElement {
  ref: number;
  kind: string;
  /** What the agent sees: own text, or the texts of a tappable container's children. */
  label: string;
  id?: string;
  bounds: [number, number, number, number];
  flags: string[];
  actionable: boolean;
  editable: boolean;
  /** Length of the current text, used to clear input fields. */
  textLength: number;
  /** The raw node, and for an unlabelled container the child whose text labels it. */
  node: UiNode;
  labelNode?: UiNode;
}

export interface UiWindow {
  pkg: string;
  type: string;
  elements: UiElement[];
}

export interface UiSnapshot {
  /** Package of the app the user is interacting with. */
  pkg: string;
  width: number;
  height: number;
  /** Windows from bottom to top: the app, then any dialog, popup or keyboard over it. */
  windows: UiWindow[];
  elements: UiElement[];
  nodes: UiNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  htmlEntities: true, // decode numeric references such as &#10;
  isArray: (name) => ['node', 'window', 'display'].includes(name),
});

const MAX_LABEL = 100;

function parseBounds(b: string | undefined): [number, number, number, number] {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0];
}

const isTrue = (v: unknown) => v === 'true';
const ownLabel = (n: any) => String(n.text ?? '').trim() || String(n['content-desc'] ?? '').trim();
const isEditable = (n: any) => /EditText|AutoCompleteTextView/.test(n.class ?? '');
const isActionable = (n: any) =>
  isTrue(n.clickable) || isTrue(n['long-clickable']) || isTrue(n.checkable) || isTrue(n.scrollable) || isEditable(n);

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/** Texts of non-actionable descendants, stopping at nested actionable elements (they get their own entries). */
function descendantLabels(node: any, found: any[]): void {
  for (const child of node.node ?? []) {
    if (isActionable(child)) continue;
    if (ownLabel(child)) found.push(child);
    descendantLabels(child, found);
  }
}

interface RawWindow {
  type: string;
  active: boolean;
  layer: number;
  roots: any[];
}

/**
 * Accepts both dump formats: a single <hierarchy> (active window only) and the
 * `--windows` format (<displays><display><window><hierarchy>), which also shows
 * dialogs, popups and the keyboard. Status and navigation bars are left out.
 */
function rawWindows(doc: any): RawWindow[] {
  if (!doc.displays) return [{ type: 'TYPE_APPLICATION', active: true, layer: 0, roots: doc.hierarchy?.node ?? [] }];
  const out: RawWindow[] = [];
  for (const display of doc.displays.display ?? []) {
    for (const w of display.window ?? []) {
      const active = w.active === 'true' || w.focused === 'true';
      if (w.type === 'TYPE_SYSTEM' && !active) continue;
      out.push({ type: w.type, active, layer: Number(w.layer ?? 0), roots: w.hierarchy?.node ?? [] });
    }
  }
  return out.sort((a, b) => a.layer - b.layer);
}

/**
 * Turn a uiautomator XML dump into a flat, numbered list of what an agent can see or act on.
 * A tappable container without its own text is labelled with its children's text, and those
 * children are then left out so each list row is one thing a person would recognise.
 */
export function parseUi(xml: string): UiSnapshot {
  const raws = rawWindows(parser.parse(xml));
  const windows: UiWindow[] = [];
  const all: UiElement[] = [];
  const nodes: UiNode[] = [];
  const nodeOf = new Map<any, UiNode>();
  const absorbed = new Set<any>();
  let elements: UiElement[] = [];
  let width = 0;
  let height = 0;

  const toNode = (n: any): UiNode => {
    let node = nodeOf.get(n);
    if (!node) {
      node = {
        text: String(n.text ?? ''),
        desc: String(n['content-desc'] ?? ''),
        hint: String(n.hint ?? ''),
        resourceId: String(n['resource-id'] ?? ''),
        checked: isTrue(n.checkable) ? isTrue(n.checked) : undefined,
        bounds: parseBounds(n.bounds),
      };
      nodeOf.set(n, node);
    }
    return node;
  };

  const visit = (n: any) => {
    const node = toNode(n);
    const bounds = node.bounds;
    width = Math.max(width, bounds[2]);
    height = Math.max(height, bounds[3]);
    const visible = bounds[2] > bounds[0] && bounds[3] > bounds[1];
    if (visible) nodes.push(node);
    const actionable = isActionable(n);
    const editable = isEditable(n);
    let label = ownLabel(n);
    let labelNode: UiNode | undefined;
    const hint = node.hint.trim();
    // Older Android versions report a field's hint as its text when the field is empty.
    const textLength = editable && hint && label === hint ? 0 : node.text.length;

    if (visible && actionable && !label && isTrue(n.clickable)) {
      const kids: any[] = [];
      descendantLabels(n, kids);
      if (kids.length > 0 && kids.length <= 4) {
        label = kids.map(ownLabel).join(' · ');
        kids.forEach((k) => absorbed.add(k));
      } else if (kids.length > 4) {
        label = `${kids.slice(0, 2).map(ownLabel).join(' · ')} …`;
      }
      if (kids.length > 0) labelNode = toNode(kids[0]);
    }

    if (visible && (actionable || (label && !absorbed.has(n)))) {
      const flags: string[] = [];
      if (editable) flags.push(isTrue(n.password) ? 'password-input' : 'input');
      if (editable && hint) flags.push(`hint="${truncate(hint)}"`);
      if (isTrue(n.checkable)) flags.push(isTrue(n.checked) ? 'checked' : 'unchecked');
      if (isTrue(n.scrollable)) flags.push('scrollable');
      if (isTrue(n.selected)) flags.push('selected');
      if (isTrue(n.focused)) flags.push('focused');
      if (!isTrue(n.clickable) && isTrue(n['long-clickable'])) flags.push('long-press');
      if (n.enabled === 'false') flags.push('disabled');
      if (!actionable) flags.push('text');
      elements.push({
        ref: all.length + elements.length + 1,
        kind: String(n.class ?? 'View').split('.').pop() ?? 'View',
        label: truncate(label),
        id: node.resourceId ? node.resourceId.split('/').pop() : undefined,
        bounds,
        flags,
        actionable,
        editable,
        textLength,
        node,
        labelNode,
      });
    }
    for (const child of n.node ?? []) visit(child);
  };

  for (const w of raws) {
    elements = [];
    w.roots.forEach(visit);
    windows.push({ pkg: String(w.roots[0]?.package ?? ''), type: w.type, elements });
    all.push(...elements);
  }

  const appWindows = raws.filter((w) => w.type === 'TYPE_APPLICATION');
  const main = raws.find((w) => w.active && w.type === 'TYPE_APPLICATION') ?? appWindows[appWindows.length - 1] ?? raws[0];
  const pkg = String(main?.roots[0]?.package ?? '');
  return { pkg, width, height, windows, elements: all, nodes };
}

/**
 * Best match for a piece of visible text. Exact matches beat prefix matches beat substrings,
 * matching case beats ignoring it, and a field's typed value ranks below other elements,
 * so "Dark theme" finds the switch rather than a search box containing "dark theme".
 */
export function findByText(elements: UiElement[], query: string): UiElement | undefined {
  const q = query.trim();
  const ql = q.toLowerCase();
  const score = (e: UiElement): number => {
    const label = e.label;
    const ll = label.toLowerCase();
    let s: number;
    if (label === q || e.id === q) s = 60;
    else if (ll === ql || e.id?.toLowerCase() === ql) s = 50;
    else if (ll.startsWith(ql)) s = 30;
    else if (ll.includes(ql)) s = 20;
    else return 0;
    if (e.editable) s -= 15;
    if (e.actionable) s += 5;
    return s;
  };
  let best: UiElement | undefined;
  let bestScore = 0;
  for (const e of elements) {
    const s = score(e);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}
