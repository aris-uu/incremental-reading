import { createContext, useContext } from "react";

/**
 * Show a toast. Pass `undo: true` after a destructive action that the backend
 * journaled; the toast then offers Undo for a few seconds.
 */
export type Notify = (message: string, opts?: { undo?: boolean }) => void;

/** Today's learning day number (shared so views can say "3 days overdue"). */
export const TodayContext = createContext<number | null>(null);
export const useToday = () => useContext(TodayContext);
