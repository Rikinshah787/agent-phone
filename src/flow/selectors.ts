import type { UiElement, UiNode, UiSnapshot } from '../phone/ui.js';

/** A Maestro selector: a text regex, or an object combining id, text, index or point. */
export type Selector = string | SelectorObject;

export interface SelectorObject {
  id?: string;
  text?: string;
  index?: number;
  point?: string;
  checked?: boolean;
  optional?: boolean;
}

/**
 * Literal text as a Maestro text pattern. Patterns are regexes, so special characters are
 * escaped; single spaces stay as they are for readability, and line breaks or repeated
 * whitespace become \s+.
 */
export function textPattern(literal: string): string {
  return literal
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s{2,}|[^\S ]/g, '\\s+');
}

function regex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, 'is');
  } catch {
    return undefined;
  }
}

const matchesAny = (values: string[], pattern: string) => {
  const re = regex(pattern);
  return values.some((v) => v !== '' && (v === pattern || (re?.test(v) ?? false)));
};

export function asObject(sel: Selector): SelectorObject {
  return typeof sel === 'string' ? { text: sel } : sel;
}

/**
 * Nodes matching a selector the way Maestro matches them: full-match, case-insensitive
 * regexes; text matches text, hint or content description; id matches the full or short
 * resource id; index picks among matches in screen order.
 */
export function matchSelector(sel: Selector, nodes: UiNode[]): UiNode[] {
  const s = asObject(sel);
  let hits = nodes.filter(
    (n) =>
      (s.text === undefined || matchesAny([n.text, n.hint, n.desc], s.text)) &&
      (s.id === undefined || (n.resourceId !== '' && matchesAny([n.resourceId, n.resourceId.split('/').pop()!], s.id))) &&
      (s.checked === undefined || n.checked === s.checked),
  );
  if (s.index !== undefined) hits = hits[s.index] ? [hits[s.index]] : [];
  return hits;
}

export function describeSelector(sel: Selector): string {
  const s = asObject(sel);
  const parts: string[] = [];
  if (s.text !== undefined) parts.push(`"${s.text}"`);
  if (s.id !== undefined) parts.push(`id=${s.id}`);
  if (s.checked !== undefined) parts.push(s.checked ? 'checked' : 'unchecked');
  if (s.index !== undefined) parts.push(`#${s.index}`);
  if (s.point !== undefined) parts.push(`point (${s.point})`);
  return parts.join(' ') || '(empty selector)';
}

export function percentPoint(x: number, y: number, width: number, height: number): string {
  return `${Math.round((x / width) * 100)}%, ${Math.round((y / height) * 100)}%`;
}

/**
 * The most readable selector that still picks out exactly this element on the current
 * screen: visible text first, then resource id, then both, then an index, then a point.
 */
export function selectorFor(el: UiElement, snap: UiSnapshot): Selector {
  const isOurs = (n: UiNode) => n === el.node || n === el.labelNode;
  const unique = (s: Selector) => {
    const m = matchSelector(s, snap.nodes);
    return m.length === 1 && isOurs(m[0]);
  };

  const id = el.node.resourceId ? el.node.resourceId.split('/').pop() : undefined;
  // A field's text is whatever was typed into it, so identify fields by their hint instead.
  const own = el.editable ? el.node.hint : el.node.text.trim() || el.node.desc.trim();
  const fromChild = el.labelNode ? el.labelNode.text.trim() || el.labelNode.desc.trim() : '';
  const literal = own.trim() || fromChild;
  const text = literal ? textPattern(literal) : undefined;

  const candidates: Selector[] = [];
  if (el.editable && id) candidates.push({ id });
  if (text) candidates.push(text);
  if (id && !el.editable) candidates.push({ id });
  if (id && text) candidates.push({ id, text });
  for (const c of candidates) if (unique(c)) return c;

  for (const base of [text && { text }, id && { id }].filter(Boolean) as SelectorObject[]) {
    const index = matchSelector(base, snap.nodes).findIndex(isOurs);
    if (index >= 0) return { ...base, index };
  }
  const [x1, y1, x2, y2] = el.bounds;
  return { point: percentPoint((x1 + x2) / 2, (y1 + y2) / 2, snap.width, snap.height) };
}
