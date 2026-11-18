/**
 * A small BM25 full-text index over Markdown files, kept in memory by the
 * extension host alongside the query index. Pure TypeScript, no VS Code API.
 */

export interface SearchHit {
  id: string;
  score: number;
}

export interface Snippet {
  text: string;
  /** 0-based line of the best match in the original text. */
  line: number;
}

const K1 = 1.2;
const B = 0.75;
/** Occurrences in the title count this many times more than in the body. */
const TITLE_WEIGHT = 3;
/** Vocabulary terms a trailing prefix may expand to. */
const PREFIX_LIMIT = 40;
/** A word only matched as a prefix of a longer term scores this fraction. */
const PREFIX_WEIGHT = 0.75;
const SNIPPET_RADIUS = 90;

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const STOP = new Set(
  'a an and are as at be but by for from has have if in into is it its no not of on or such that the their then there these they this to was will with you your'.split(
    ' '
  )
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const t = stem(m[0]);
    if (t) out.push(t);
  }
  return out;
}

/** Light English stemming: enough to match plurals and verb forms. */
export function stem(word: string): string {
  let w = word;
  if (w.length < 2 || STOP.has(w)) return '';
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

interface Doc {
  length: number;
  terms: Map<string, number>;
}

export class SearchIndex {
  private readonly docs = new Map<string, Doc>();
  private readonly postings = new Map<string, Map<string, number>>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  set(id: string, title: string, body: string): void {
    this.delete(id);
    const terms = new Map<string, number>();
    let length = 0;
    for (const t of tokenize(title)) {
      terms.set(t, (terms.get(t) ?? 0) + TITLE_WEIGHT);
      length += TITLE_WEIGHT;
    }
    for (const t of tokenize(body)) {
      terms.set(t, (terms.get(t) ?? 0) + 1);
      length += 1;
    }
    this.docs.set(id, { length, terms });
    this.totalLength += length;
    for (const [t, tf] of terms) {
      let list = this.postings.get(t);
      if (!list) this.postings.set(t, (list = new Map()));
      list.set(id, tf);
    }
  }

  delete(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    this.totalLength -= doc.length;
    for (const t of doc.terms.keys()) {
      const list = this.postings.get(t);
      if (!list) continue;
      list.delete(id);
      if (list.size === 0) this.postings.delete(t);
    }
  }

  rename(from: string, to: string): void {
    const doc = this.docs.get(from);
    if (!doc || from === to) return;
    this.delete(from);
    this.docs.set(to, doc);
    this.totalLength += doc.length;
    for (const [t, tf] of doc.terms) {
      let list = this.postings.get(t);
      if (!list) this.postings.set(t, (list = new Map()));
      list.set(to, tf);
    }
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.totalLength = 0;
  }

  /**
   * Ranks documents for `query`. Every term must match (AND), where the last
   * term also matches as a prefix while the user is still typing it.
   */
  search(query: string, limit = 50): SearchHit[] {
    const groups = this.queryTerms(query);
    if (!groups.length || !this.docs.size) return [];
    const n = this.docs.size;
    const avg = this.totalLength / n;
    let scores: Map<string, number> | undefined;
    for (const group of groups) {
      const groupScores = new Map<string, number>();
      group.forEach((term, i) => {
        const list = this.postings.get(term);
        if (!list) return;
        const idf = Math.log(1 + (n - list.size + 0.5) / (list.size + 0.5));
        const weight = i === 0 ? 1 : PREFIX_WEIGHT;
        for (const [id, tf] of list) {
          if (scores && !scores.has(id)) continue;
          const len = this.docs.get(id)!.length;
          const s = weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg)));
          // A prefix group scores by its best expansion, not their sum.
          if (s > (groupScores.get(id) ?? 0)) groupScores.set(id, s);
        }
      });
      if (!scores) {
        scores = groupScores;
      } else {
        for (const id of [...scores.keys()]) {
          const s = groupScores.get(id);
          if (s === undefined) scores.delete(id);
          else scores.set(id, scores.get(id)! + s);
        }
      }
      if (scores.size === 0) return [];
    }
    return [...scores!]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  /** The stems a query matches, one group per typed word; a prefix group lists the exact stem first. */
  queryTerms(query: string): string[][] {
    const words = [...query.toLowerCase().matchAll(TOKEN_RE)].map((m) => m[0]);
    const trailingSpace = /\s$/.test(query);
    const groups: string[][] = [];
    words.forEach((word, i) => {
      const s = stem(word);
      const last = i === words.length - 1 && !trailingSpace;
      if (!last) {
        if (s) groups.push([s]);
        return;
      }
      // Still typing: match whole words starting with what is there so far.
      const prefix = word;
      const set = new Set<string>();
      if (s) set.add(s);
      if (prefix.length >= 2) {
        for (const term of this.postings.keys()) {
          if (term.startsWith(prefix)) {
            set.add(term);
            if (set.size >= PREFIX_LIMIT) break;
          }
        }
      }
      if (set.size) groups.push([...set]);
    });
    return groups;
  }
}

/**
 * Picks the passage of `text` where the most distinct query stems cluster
 * and returns it trimmed to one line, with the line number of its centre.
 */
export function snippet(text: string, groups: string[][], radius = SNIPPET_RADIUS): Snippet {
  const want = new Map<string, number>();
  groups.forEach((g, i) => g.forEach((t) => want.set(t, i)));
  const hits: { at: number; group: number }[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) {
    const g = want.get(stem(m[0]));
    if (g !== undefined) hits.push({ at: m.index!, group: g });
  }
  let best = 0;
  let bestScore = -1;
  for (let i = 0, j = 0; i < hits.length; i++) {
    while (hits[i].at - hits[j].at > radius * 2) j++;
    const seen = new Set<number>();
    for (let k = j; k <= i; k++) seen.add(hits[k].group);
    // Prefer more distinct terms, then earlier passages.
    if (seen.size > bestScore) {
      bestScore = seen.size;
      best = hits[j].at;
    }
  }
  let start = Math.max(0, best - 20);
  let end = Math.min(text.length, start + radius * 2);
  // Cut on word boundaries.
  if (start > 0) start += text.slice(start, best).search(/\s\S/) + 1;
  if (end < text.length) end = start + text.slice(start, end).search(/\s[^\s]*$/);
  if (end <= start) end = Math.min(text.length, start + radius * 2);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s += '…';
  const line = text.slice(0, best).split('\n').length - 1;
  return { text: s, line };
}
