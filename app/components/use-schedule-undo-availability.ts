import { useEffect, useState } from "react";

export function useScheduleUndoAvailability<
  T extends { expiresAt: number; token: string },
>(undo: T | null): T | null {
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1_000));
  const expiresAt = undo?.expiresAt ?? null;

  useEffect(() => {
    if (expiresAt === null) return;
    const delay = Math.max(0, expiresAt * 1_000 - Date.now());
    const timeout = window.setTimeout(
      () => setClock(Math.floor(Date.now() / 1_000)),
      delay + 50,
    );
    return () => window.clearTimeout(timeout);
  }, [expiresAt]);

  return undo && undo.expiresAt > clock ? undo : null;
}
