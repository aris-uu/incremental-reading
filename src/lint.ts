/** Plain text of a ProseMirror JSON document (math as $…$). */
export function docText(json: string): string {
  const walk = (n: any): string =>
    n.type === "text"
      ? n.text ?? ""
      : n.type === "mathInline" || n.type === "mathBlock"
        ? `$${n.attrs?.latex ?? ""}$`
        : (n.content ?? []).map(walk).join(n.type === "doc" ? "\n" : "");
  try {
    return walk(JSON.parse(json)).trim();
  } catch {
    return "";
  }
}

const hasList = (json: string) => /"type":"(bulletList|orderedList)"/.test(json);
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/**
 * Gentle hints from the minimum-information principle. They never block;
 * they just point at items that tend to be hard to remember.
 */
export function lintItem(questionJson: string, answerJson: string): string[] {
  if (questionJson.includes('"type":"occlusion"')) return [];
  const q = docText(questionJson);
  const a = docText(answerJson);
  const out: string[] = [];
  if (!q) out.push("No question yet.");
  if (!a) out.push("No answer yet.");
  const gaps = (q.match(/\[\.\.\.\]/g) ?? []).length;
  if (gaps > 1) out.push(`${gaps} gaps in one item: make one cloze per item.`);
  if (words(q) > 30) out.push(`Long question (${words(q)} words): shorten it or split it into several items.`);
  if (words(a) > 6) out.push(`Long answer (${words(a)} words): aim for one short fact.`);
  if (hasList(answerJson)) out.push("A list in the answer is hard to recall: turn each entry into its own item.");
  if (a && q && a.length > 3 && q.toLowerCase().includes(a.toLowerCase())) out.push("The answer appears in the question.");
  if (/^(it|this|they|these|that|he|she)\b/i.test(q.replace(/^\[\.\.\.\]\s*/, "")))
    out.push("Starts with a pronoun: say what it refers to, so the item stands on its own.");
  return out;
}
