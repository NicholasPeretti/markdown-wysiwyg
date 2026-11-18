/**
 * Webview-side cache of relation options, fetched from the host per relation
 * spec (`relationOptions` → `relationOptionsResult`) and invalidated when the
 * host reports `relationsChanged`.
 */
import { relationKey, type Relation } from '../query/relations';
import type { PickerOption } from './relation_picker';

type Post = (message: unknown) => void;

let post: Post | undefined;
const cache = new Map<string, PickerOption[]>();
const pending = new Map<string, ((options: PickerOption[]) => void)[]>();
const listeners = new Set<() => void>();
let seq = 0;

export function installRelationOptions(p: Post): void {
  post = p;
}

/** Cached options for `rel`, or undefined (a fetch is started). */
export function peekOptions(rel: Relation): PickerOption[] | undefined {
  const key = relationKey(rel);
  const hit = cache.get(key);
  if (!hit) void fetchOptions(rel);
  return hit;
}

export function fetchOptions(rel: Relation): Promise<PickerOption[]> {
  const key = relationKey(rel);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const waiters = pending.get(key);
    if (waiters) {
      waiters.push(resolve);
      return;
    }
    pending.set(key, [resolve]);
    post?.({ type: 'relationOptions', id: `ro${++seq}`, key, relation: rel });
  });
}

/** Subscribe to cache invalidations (options changed on disk). */
export function onRelationOptionsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Returns true when the message was consumed. */
export function handleRelationMessage(message: { type?: string; [k: string]: unknown }): boolean {
  switch (message.type) {
    case 'relationOptionsResult': {
      const key = String(message.key);
      const options = message.options as PickerOption[];
      cache.set(key, options);
      for (const resolve of pending.get(key) ?? []) resolve(options);
      pending.delete(key);
      for (const fn of listeners) fn();
      return true;
    }
    case 'relationsChanged':
      cache.clear();
      for (const fn of listeners) fn();
      return true;
  }
  return false;
}
