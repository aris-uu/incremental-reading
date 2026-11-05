import { LEECH_LAPSES, type BrowseRow } from "./api";

/**
 * Browser search language (Anki-like). Terms are ANDed; `-` negates a term;
 * `or` between terms ORs them.
 *
 *   is:topic is:item is:cloze is:qa is:occlusion is:text is:pdf is:video is:note
 *   is:active is:inbox is:done is:dismissed is:due is:overdue is:new is:leech
 *   is:needs-work is:pinned is:parent is:root
 *   under:12        element 12 and all its descendants (under:12,40 for several)
 *   child:12        direct children of 12
 *   id:3,4,5        these elements
 *   prio<20  due<=0  ivl>30  lapses>=4  reps=0  stab>10  af>2  r<0.8  rank<=100
 *   tag:name  is:tagged  is:duplicate
 *   added<7  edited<7  (days ago)   chars>5000
 *   words           full text (title and body)
 *   title:word      title only
 */
export interface Query {
  /** Bare words for the full-text index (null if none). */
  text: string | null;
  test: (r: BrowseRow, ctx: Ctx) => boolean;
  errors: string[];
}

export interface Ctx {
  today: number;
  /** Unix seconds now. */
  now: number;
  /** Rows by id and children by parent (for under:/child:). */
  children: Map<number | null, number[]>;
  /** Full-text hits, when the query had words. */
  textHits: Set<number> | null;
  /** Items whose question looks like another item's (for is:duplicate). */
  duplicates?: Set<number>;
}

type Pred = (r: BrowseRow, c: Ctx) => boolean;

const IS: Record<string, Pred> = {
  topic: (r) => r.kind === "topic",
  item: (r) => r.kind === "item",
  cloze: (r) => r.subtype === "cloze",
  qa: (r) => r.subtype === "qa",
  occlusion: (r) => r.subtype === "occlusion",
  sentence: (r) => r.subtype === "sentence",
  text: (r) => r.subtype === "text",
  pdf: (r) => r.subtype === "pdf",
  video: (r) => r.subtype === "video",
  note: (r) => r.subtype === "note",
  active: (r) => r.status === "active",
  inbox: (r) => r.status === "inbox",
  done: (r) => r.status === "done",
  dismissed: (r) => r.status === "dismissed",
  due: (r, c) => r.status === "active" && r.subtype !== "note" && r.due_day != null && r.due_day <= c.today,
  overdue: (r, c) => r.status === "active" && r.subtype !== "note" && r.due_day != null && r.due_day < c.today,
  new: (r) => r.reps === 0,
  leech: (r) => r.kind === "item" && r.lapses >= LEECH_LAPSES,
  "needs-work": (r) => r.needs_work,
  pinned: (r) => r.pinned,
  parent: (r) => r.children > 0,
  root: (r) => r.parent_id == null,
  duplicate: (r, c) => !!c.duplicates?.has(r.id),
  tagged: (r) => r.tags.length > 0,
};

const FIELDS: Record<string, (r: BrowseRow, c: Ctx) => number | null> = {
  prio: (r) => r.priority,
  due: (r, c) => (r.due_day == null ? null : r.due_day - c.today),
  ivl: (r) => r.interval_days,
  lapses: (r) => r.lapses,
  reps: (r) => r.reps,
  stab: (r) => r.stability,
  af: (r) => r.afactor,
  r: (r) => r.retrievability,
  rank: (r) => r.prank,
  added: (r, c) => (c.now - r.created_at) / 86400,
  edited: (r, c) => (c.now - r.updated_at) / 86400,
  chars: (r) => r.text_len,
  children: (r) => r.children,
};

const CMP: Record<string, (a: number, b: number) => boolean> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "=": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/** Split on spaces, keeping "quoted phrases" together. */
function tokens(q: string): string[] {
  return [...q.matchAll(/-?"[^"]*"|\S+/g)].map((m) => m[0]);
}

const ids = (s: string) => s.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);

/** All descendants of `roots` (and the roots), from the parent → children map. */
export function subtree(roots: number[], children: Map<number | null, number[]>): Set<number> {
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

export function parseQuery(q: string): Query {
  const words: string[] = [];
  const errors: string[] = [];
  // Groups of OR-ed predicates, ANDed together.
  const groups: Pred[][] = [];
  let orNext = false;
  const subtreeCache = new Map<string, Set<number>>();

  for (const raw of tokens(q)) {
    if (raw.toLowerCase() === "or") {
      orNext = groups.length > 0;
      continue;
    }
    const neg = raw.startsWith("-") && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    let p: Pred | null = null;
    const lower = t.toLowerCase();
    let m: RegExpMatchArray | null;
    if (lower.startsWith("is:")) {
      p = IS[lower.slice(3)] ?? null;
      if (!p) errors.push(`unknown ${t}`);
    } else if ((m = lower.match(/^under:([\d,]+)$/))) {
      const key = m[1];
      const roots = ids(key);
      p = (r, c) => {
        if (!subtreeCache.has(key)) subtreeCache.set(key, subtree(roots, c.children));
        return subtreeCache.get(key)!.has(r.id);
      };
    } else if ((m = lower.match(/^child:(\d+)$/))) {
      const parent = Number(m[1]);
      p = (r) => r.parent_id === parent;
    } else if ((m = lower.match(/^id:([\d,]+)$/))) {
      const set = new Set(ids(m[1]));
      p = (r) => set.has(r.id);
    } else if ((m = lower.match(/^tag:(.+)$/))) {
      const name = m[1].replace(/^#/, "");
      p = (r) => r.tags.some((t) => t.toLowerCase() === name || t.toLowerCase().startsWith(`${name}::`));
    } else if ((m = lower.match(/^title:(.+)$/))) {
      const needle = m[1].replace(/^"|"$/g, "");
      p = (r) => r.title.toLowerCase().includes(needle);
    } else if ((m = lower.match(/^([a-z]+)(<=|>=|!=|<|>|=)(-?\d+(?:\.\d+)?)$/))) {
      const field = FIELDS[m[1]];
      const cmp = CMP[m[2]];
      const v = Number(m[3]);
      if (!field) errors.push(`unknown field ${m[1]}`);
      else
        p = (r, c) => {
          const x = field(r, c);
          return x != null && cmp(x, v);
        };
    } else if (/^[a-z]+:/.test(lower) && !lower.startsWith("http")) {
      errors.push(`unknown ${t}`);
    } else {
      const w = t.replace(/^"|"$/g, "");
      if (neg) {
        const needle = w.toLowerCase();
        p = (r) => r.title.toLowerCase().includes(needle);
      } else if (w) words.push(w);
      if (!neg) {
        orNext = false;
        continue;
      }
    }
    if (!p) continue;
    const pred: Pred = neg ? ((inner) => (r, c) => !inner(r, c))(p) : p;
    if (orNext && groups.length) groups[groups.length - 1].push(pred);
    else groups.push([pred]);
    orNext = false;
  }

  return {
    text: words.length ? words.join(" ") : null,
    errors,
    test: (r, c) => (!c.textHits || c.textHits.has(r.id)) && groups.every((g) => g.some((p) => p(r, c))),
  };
}

export type SortKey =
  | "rank" | "title" | "kind" | "priority" | "due" | "interval" | "reps" | "lapses" | "created" | "updated" | "chars" | "afactor"
  | "stability" | "retrievability" | "tags";

export const SORTS: Record<SortKey, (r: BrowseRow) => number | string> = {
  rank: (r) => r.prank,
  title: (r) => r.title.toLowerCase(),
  kind: (r) => r.subtype,
  priority: (r) => r.priority,
  due: (r) => r.due_day ?? Number.MAX_SAFE_INTEGER,
  interval: (r) => r.interval_days ?? -1,
  reps: (r) => r.reps,
  lapses: (r) => r.lapses,
  created: (r) => r.created_at,
  updated: (r) => r.updated_at,
  chars: (r) => r.text_len,
  afactor: (r) => r.afactor ?? -1,
  stability: (r) => r.stability ?? -1,
  retrievability: (r) => r.retrievability ?? 2,
  tags: (r) => r.tags.join(" ").toLowerCase(),
};

/** Normalised text for duplicate detection. */
const norm = (s: string) => s.toLowerCase().replace(/\[\.\.\.\]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Items with the same normalised question (title) as another item. */
export function findDuplicates(rows: BrowseRow[]): Set<number> {
  const seen = new Map<string, number[]>();
  for (const r of rows) {
    if (r.kind !== "item" || r.status === "dismissed") continue;
    const k = norm(r.title);
    if (k.length < 8) continue;
    seen.set(k, [...(seen.get(k) ?? []), r.id]);
  }
  return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
}

/** Saved searches shown as one-click chips. */
export const PRESETS: { label: string; query: string; sort?: SortKey; desc?: boolean }[] = [
  { label: "Priority queue", query: "is:active", sort: "rank" },
  { label: "Due today", query: "is:due", sort: "rank" },
  { label: "Overdue", query: "is:overdue", sort: "due" },
  { label: "Leeches", query: "is:leech", sort: "lapses", desc: true },
  { label: "Needs work", query: "is:needs-work" },
  { label: "New items", query: "is:item is:new is:active", sort: "rank" },
  { label: "Unread topics", query: "is:topic is:new is:active -is:note", sort: "rank" },
  { label: "Videos & PDFs", query: "is:video or is:pdf" },
  { label: "About to be forgotten", query: "is:item is:active r<0.85", sort: "retrievability" },
  { label: "Made today", query: "added<1", sort: "created", desc: true },
  { label: "Added this week", query: "added<7", sort: "created", desc: true },
  { label: "Duplicates", query: "is:duplicate", sort: "title" },
  { label: "Sentence cards", query: "is:sentence", sort: "created", desc: true },
  { label: "Inbox", query: "is:inbox", sort: "created", desc: true },
  { label: "Done & dismissed", query: "is:done or is:dismissed", sort: "updated", desc: true },
];
