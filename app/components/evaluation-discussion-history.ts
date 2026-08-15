import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

type DiscussionPage = {
  target: {
    roundId: string;
    targetType: "submission" | "session";
    targetId: string;
  };
  writable: boolean;
  messages: Array<{
    id: string;
    body: string;
    createdAt: number;
    authorName: string;
    authorPersonId: string;
  }>;
  earlierCursor: string | null;
  postIntentId: string;
};

export function useEvaluationDiscussionHistory(
  discussion: DiscussionPage | null,
) {
  const threadKey = discussion
    ? `${discussion.target.roundId}:${discussion.target.targetType}:${discussion.target.targetId}`
    : "none";
  const initialKey = discussion
    ? `${threadKey}:${discussion.messages.at(0)?.id ?? "empty"}:${discussion.messages.at(-1)?.id ?? "empty"}:${discussion.earlierCursor ?? "complete"}`
    : threadKey;
  const fetcher = useFetcher<DiscussionPage>({
    key: `evaluation-discussion-history:${threadKey}`,
  });
  const [history, setHistory] = useState(() => ({
    messages: discussion?.messages ?? [],
    earlierCursor: discussion?.earlierCursor ?? null,
  }));
  const appliedResponse = useRef<DiscussionPage | null>(null);

  useEffect(() => {
    setHistory({
      messages: discussion?.messages ?? [],
      earlierCursor: discussion?.earlierCursor ?? null,
    });
  }, [discussion, initialKey]);

  useEffect(() => {
    const page = fetcher.data;
    if (!discussion || !page || page === appliedResponse.current) return;
    if (
      page.target.roundId !== discussion.target.roundId ||
      page.target.targetType !== discussion.target.targetType ||
      page.target.targetId !== discussion.target.targetId
    )
      return;
    appliedResponse.current = page;
    setHistory((current) => {
      const known = new Set(current.messages.map((message) => message.id));
      return {
        ...current,
        messages: [
          ...page.messages.filter((message) => !known.has(message.id)),
          ...current.messages,
        ],
        earlierCursor: page.earlierCursor,
      };
    });
  }, [discussion, fetcher.data]);

  const loadEarlier = useCallback(() => {
    if (!discussion || !history.earlierCursor || fetcher.state !== "idle")
      return;
    const query = new URLSearchParams({
      roundId: discussion.target.roundId,
      targetType: discussion.target.targetType,
      targetId: discussion.target.targetId,
      cursor: history.earlierCursor,
    });
    void fetcher.load(`/review/discussion-page?${query}`);
  }, [discussion, fetcher, history.earlierCursor]);

  return {
    messages: history.messages,
    hasEarlier: history.earlierCursor !== null,
    loadingEarlier: fetcher.state !== "idle",
    loadEarlier,
  };
}
