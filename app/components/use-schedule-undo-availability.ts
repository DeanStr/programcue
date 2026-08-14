import { useEffect, useState } from "react";

export function useScheduleUndoAvailability<
  T extends { expiresAt: number; token: string },
>(undo: T | null): T | null {
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    if (!undo) return;
    const delay = Math.max(0, undo.expiresAt * 1_000 - Date.now());
    const timeout = window.setTimeout(
      () => setClock(Math.floor(Date.now() / 1_000)),
      delay + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [undo?.expiresAt, undo?.token]);

  return undo && undo.expiresAt > clock ? undo : null;
}
