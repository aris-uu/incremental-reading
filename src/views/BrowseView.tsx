import { useCallback, useEffect, useState } from "react";
import type { Notify } from "../notify";
import { api, type ElementFull } from "../api";
import { TopicView } from "./TopicView";
import { ItemView } from "./ItemView";

interface Props {
  id: number;
  notify: Notify;
  onOpen: (id: number) => void;
  onChanged: () => void;
  onDeleted: () => void;
  onReviewBranch: (id: number) => void;
}

/** Any element opened outside the queue (from the sidebar or a Ctrl+click). */
export function BrowseView({ id, notify, onOpen, onChanged, onDeleted, onReviewBranch }: Props) {
  const [el, setEl] = useState<ElementFull | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.getElement(id).then(setEl).catch(() => setEl(null));
  }, [id, version]);

  const finished = useCallback(() => {
    setVersion((v) => v + 1);
    onChanged();
  }, [onChanged]);

  if (!el || el.id !== id) return <p className="muted pad">Loading…</p>;

  const remove = async () => {
    const extra = el.children ? ` Its ${el.children} children move to the top level.` : "";
    if (!window.confirm(`Delete “${el.title}”?${extra} (You can undo right after.)`)) return;
    await api.deleteElement(el.id);
    notify(`Deleted “${el.title}”`, { undo: true });
    onDeleted();
  };

  const common = { notify, onOpen, onFinish: finished, onChanged, onDelete: remove, onReviewBranch };
  return (
    <div className="browse">
      {el.kind === "topic" ? (
        <TopicView key={`${el.id}-${version}`} element={el} mode="browse" {...common} />
      ) : (
        <ItemView key={`${el.id}-${version}`} element={el} mode="browse" {...common} />
      )}
    </div>
  );
}
