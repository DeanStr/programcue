import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import type { PublicProgrammeLoaderData } from "./public-programme-model-helpers";

type PublicProgrammeActionData = {
  ok?: boolean;
  error?: string;
  shareUrl?: string;
};

type PublicProgrammeAction = () => Promise<PublicProgrammeActionData>;

export function usePublicProgrammeItineraryModel(
  loaderData: PublicProgrammeLoaderData,
) {
  const fetcher = useFetcher<PublicProgrammeAction>();
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [itineraryVerificationPrompted, setItineraryVerificationPrompted] =
    useState(false);
  const itineraryVerificationRef = useRef<HTMLFieldSetElement | null>(null);
  const previousFetcherState = useRef(fetcher.state);
  const saved = loaderData.itinerary;
  const shareUrl =
    fetcher.data &&
    "shareUrl" in fetcher.data &&
    typeof fetcher.data.shareUrl === "string"
      ? fetcher.data.shareUrl
      : null;

  useEffect(() => {
    if (previousFetcherState.current !== "idle" && fetcher.state === "idle") {
      setTurnstileResetKey((value) => value + 1);
    }
    previousFetcherState.current = fetcher.state;
  }, [fetcher.state]);

  function requiresItineraryVerification(sessionId: string) {
    return (
      !saved.includes(sessionId) &&
      loaderData.itineraryVerificationRequired &&
      loaderData.turnstileSiteKey !== null &&
      !turnstileToken
    );
  }

  function updateTurnstileToken(token: string) {
    setTurnstileToken(token);
    if (token) setItineraryVerificationPrompted(false);
  }

  function toggle(sessionId: string) {
    if (loaderData.shared) return;
    if (requiresItineraryVerification(sessionId)) {
      setItineraryVerificationPrompted(true);
      window.requestAnimationFrame(() => {
        const verification = itineraryVerificationRef.current;
        verification?.focus({ preventScroll: true });
        verification?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
          block: "center",
        });
      });
      return;
    }
    void fetcher.submit(
      {
        intent: saved.includes(sessionId) ? "remove" : "add",
        sessionId,
        "turnstile-token": turnstileToken,
      },
      { method: "post" },
    );
  }

  return {
    fetcher,
    saved,
    shareUrl,
    turnstileToken,
    updateTurnstileToken,
    turnstileResetKey,
    itineraryVerificationPrompted,
    itineraryVerificationRef,
    requiresItineraryVerification,
    toggle,
  };
}
