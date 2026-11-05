import { invoke } from "@tauri-apps/api/core";

export type Kind = "topic" | "item";
export type Status = "inbox" | "active" | "done" | "dismissed";

export interface QueueEntry {
  id: number;
  kind: Kind;
  title: string;
  priority: number;
  due_day: number;
}

export interface PostponeReport {
  items: number;
  topics: number;
}

export interface QueueResult {
  entries: QueueEntry[];
  auto_postponed: PostponeReport | null;
}

export interface Reference {
  source_id: number;
  title: string;
  url: string | null;
  author: string | null;
  site: string | null;
}

export interface TopicData {
  doc_json: string;
  read_point: number | null;
  afactor: number;
  interval_days: number;
  due_day: number;
  last_day: number | null;
  archived: boolean;
  pdf_asset: string | null;
  pdf_page: number | null;
  text_len: number;
}

export interface ItemData {
  item_type: string;
  /** ProseMirror documents (JSON). */
  question: string;
  answer: string;
  stability: number | null;
  difficulty: number | null;
  interval_days: number;
  due_day: number;
  last_day: number | null;
  reps: number;
  lapses: number;
}

export interface ElementFull {
  id: number;
  kind: Kind;
  parent_id: number | null;
  parent_title: string | null;
  title: string;
  priority: number;
  status: Status;
  children: number;
  topic: TopicData | null;
  item: ItemData | null;
  reference: Reference | null;
  /** Position in the global priority queue (1 = head) and its length. */
  queue_rank: number;
  queue_size: number;
  /** Last scheduling event: create, read, grade, postpone, reschedule. */
  last_event: string | null;
}

export interface TreeNode {
  id: number;
  parent_id: number | null;
  kind: Kind;
  title: string;
  priority: number;
  status: Status;
  due_day: number | null;
  /** Topic without text: a note root/folder, or a finished article. */
  empty: boolean;
  pdf: boolean;
  position: number;
}

export interface InboxEntry {
  id: number;
  title: string;
  priority: number;
  url: string | null;
  site: string | null;
  chars: number;
  created_at: number;
}

export interface Stats {
  today: number;
  due_topics: number;
  due_items: number;
  inbox: number;
  total_topics: number;
  total_items: number;
}

export interface Settings {
  item_budget: number;
  topic_budget: number;
  protect_priority: number;
  retention_top: number;
  retention_bottom: number;
  retention_floor: number;
}

export interface PdfMark {
  id: number;
  child_id: number | null;
  page: number;
  rects: [number, number, number, number][];
  kind: string;
}

export interface FullStats {
  today: number;
  history: { day: number; again: number; pass: number; topics: number }[];
  forecast_items: number[];
  forecast_topics: number[];
  true_retention: number | null;
  mature_reviews: number;
  protection: { label: string; total: number; overdue: number }[];
  sources: { id: number; title: string; extracts: number; items: number }[];
  by_status: [string, number][];
  training_samples: number;
  optimized: boolean;
}

export type BulkAction = "dismiss" | "done" | "restore" | "delete" | "priority" | "read_today";

export interface PostponeSpec {
  root: number | null;
  topics: boolean;
  items: boolean;
  min_priority: number;
  factor: number;
}

export interface ImportInput {
  title: string;
  doc_json: string;
  priority: number;
  url?: string | null;
  author?: string | null;
  site?: string | null;
  inbox?: boolean;
  parent?: number | null;
}

export const api = {
  importTopic: (input: ImportInput) => invoke<number>("import_topic", { input }),
  fetchPage: (url: string) => invoke<{ html: string; final_url: string }>("fetch_page", { url }),
  createExtract: (parentId: number, title: string, docJson: string) =>
    invoke<number>("create_extract", { parentId, title, docJson }),
  createItem: (parentId: number | null, itemType: "cloze" | "qa", question: string, answer: string) =>
    invoke<number>("create_item", { parentId, itemType, question, answer }),
  saveTopic: (id: number, docJson: string, readPoint: number | null) =>
    invoke<void>("save_topic", { id, docJson, readPoint }),
  saveItem: (id: number, question: string, answer: string) => invoke<void>("save_item", { id, question, answer }),
  topicRead: (id: number) => invoke<number>("topic_read", { id }),
  reschedule: (id: number, days: number) => invoke<void>("reschedule", { id, days }),
  setPriority: (id: number, priority: number) => invoke<void>("set_priority", { id, priority }),
  setTitle: (id: number, title: string) => invoke<void>("set_title", { id, title }),
  dismiss: (id: number) => invoke<void>("dismiss", { id }),
  done: (id: number) => invoke<void>("done", { id }),
  restore: (id: number) => invoke<void>("restore", { id }),
  accept: (id: number, priority: number) => invoke<void>("accept", { id, priority }),
  getInbox: () => invoke<InboxEntry[]>("get_inbox"),
  deleteElement: (id: number) => invoke<void>("delete_element", { id }),
  previewItem: (id: number) => invoke<[number, number, number, number]>("preview_item", { id }),
  gradeItem: (id: number, grade: 1 | 2 | 3 | 4) => invoke<number>("grade_item", { id, grade }),
  getQueue: () => invoke<QueueResult>("get_queue"),
  branchesQueue: (roots: number[], dueOnly: boolean) => invoke<QueueEntry[]>("branches_queue", { roots, dueOnly }),
  idsQueue: (ids: number[]) => invoke<QueueEntry[]>("ids_queue", { ids }),
  postpone: (spec: PostponeSpec, simulate: boolean) => invoke<PostponeReport>("postpone", { spec, simulate }),
  mercy: (root: number | null, days: number, simulate: boolean) => invoke<number[]>("mercy", { root, days, simulate }),
  getElement: (id: number) => invoke<ElementFull>("get_element", { id }),
  getTree: () => invoke<TreeNode[]>("get_tree"),
  search: (query: string) => invoke<number[]>("search", { query }),
  getStats: () => invoke<Stats>("get_stats"),
  /** Undo the most recent destructive action; returns its label, or null. */
  undo: () => invoke<string | null>("undo"),
  priorityAnchors: () => invoke<{ id: number; title: string; priority: number }[]>("priority_anchors"),
  fullStats: () => invoke<FullStats>("full_stats"),
  optimize: () => invoke<{ samples: number; parameters: number[] }>("optimize"),
  resetParameters: () => invoke<void>("reset_parameters"),
  createTopic: (parentId: number | null, title: string, docJson: string) =>
    invoke<number>("create_topic", { parentId, title, docJson }),
  moveElements: (ids: number[], parentId: number | null) => invoke<number>("move_elements", { ids, parentId }),
  /** Reparent and place before sibling `before` (null = at the end). */
  placeElements: (ids: number[], parentId: number | null, before: number | null) =>
    invoke<void>("place_elements", { ids, parentId, before }),
  shiftElement: (id: number, delta: number) => invoke<void>("shift_element", { id, delta }),
  sortChildren: (parentId: number | null) => invoke<void>("sort_children", { parentId }),
  bulk: (ids: number[], action: BulkAction, priority?: number) => invoke<number>("bulk", { ids, action, priority }),
  /** Upload bytes into the collection's assets; returns `ir-asset:<file>`. */
  saveAsset: (bytes: Uint8Array | ArrayBuffer, ext: string) =>
    invoke<string>("save_asset", bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { headers: { "x-ext": ext } }),
  importPdf: (input: { title: string; asset: string; priority: number; url?: string | null; author?: string | null; parent?: number | null; inbox?: boolean }) =>
    invoke<number>("import_pdf", { input }),
  setPdfPage: (id: number, page: number) => invoke<void>("set_pdf_page", { id, page }),
  addPdfMark: (id: number, childId: number | null, page: number, rects: [number, number, number, number][], kind: string) =>
    invoke<number>("add_pdf_mark", { id, childId, page, rects, kind }),
  pdfMarks: (id: number) => invoke<PdfMark[]>("pdf_marks", { id }),
  deletePdfMark: (markId: number) => invoke<void>("delete_pdf_mark", { markId }),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  extensionInfo: () => invoke<{ port: number; token: string }>("extension_info"),
  backup: () => invoke<string>("backup"),
  dataDir: () => invoke<string>("data_dir"),
};

export function fmtDays(d: number): string {
  if (d <= 0) return "today";
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
