/** Platform-neutral description of what is on a phone screen. Units are the platform's UI units: pixels on Android, points on iOS. */

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
