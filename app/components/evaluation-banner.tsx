import { ChevronDown, ChevronUp } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Form, Link, useLocation } from "react-router";

export const EVALUATION_BANNER_COOKIE = "program_cue_eval_banner";

export function evaluationBannerHiddenFromCookieHeader(
  cookieHeader: string | null | undefined,
) {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(";")
    .some((part) => part.trim() === `${EVALUATION_BANNER_COOKIE}=hidden`);
}

export function evaluationBannerPreferenceCookie(hidden: boolean) {
  return `${EVALUATION_BANNER_COOKIE}=${
    hidden ? "hidden" : "visible"
  }; path=/; max-age=31536000; samesite=lax`;
}

export type EvaluationBannerIdentity = {
  name: string;
  label: string;
  bannerHidden?: boolean;
};

export function evaluationBannerInitiallyHidden(
  evaluation: EvaluationBannerIdentity,
  cookieHeader: string | null | undefined,
) {
  return Boolean(
    evaluation.bannerHidden ||
      evaluationBannerHiddenFromCookieHeader(cookieHeader),
  );
}

function writeEvaluationBannerPreference(hidden: boolean) {
  // A cookie rather than local storage so the next document can render the
  // collapsed restore control immediately and skip a flash of the full bar.
  // biome-ignore lint/suspicious/noDocumentCookie: This non-sensitive preference cookie must work in browsers without the asynchronous Cookie Store API.
  document.cookie = evaluationBannerPreferenceCookie(hidden);
}

export function EvaluationBanner({
  evaluation,
}: {
  evaluation: EvaluationBannerIdentity | null | undefined;
}) {
  const embedded = useLocation().pathname.startsWith("/embed/");
  const [hidden, setHidden] = useState(() =>
    evaluation
      ? evaluationBannerInitiallyHidden(
          evaluation,
          typeof document === "undefined" ? null : document.cookie,
        )
      : false,
  );
  const bannerRef = useRef<HTMLElement>(null);
  const hideButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<"hide" | "restore" | null>(null);
  const sessionActive = Boolean(evaluation && !embedded);
  const expanded = sessionActive && !hidden;

  useLayoutEffect(() => {
    if (!expanded) {
      document.documentElement.style.removeProperty("--eval-banner-offset");
      return;
    }
    const node = bannerRef.current;
    if (!node) {
      document.documentElement.style.removeProperty("--eval-banner-offset");
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty(
        "--eval-banner-offset",
        `${Math.ceil(node.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--eval-banner-offset");
    };
  }, [expanded]);

  useLayoutEffect(() => {
    const target = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (hidden && target === "restore") restoreButtonRef.current?.focus();
    if (!hidden && target === "hide") hideButtonRef.current?.focus();
  }, [hidden]);

  if (!evaluation || !sessionActive) return null;

  function setBannerHidden(nextHidden: boolean) {
    pendingFocusRef.current = nextHidden ? "restore" : "hide";
    setHidden(nextHidden);
    writeEvaluationBannerPreference(nextHidden);
  }

  if (hidden) {
    return (
      <aside className="pc-eval-banner-restore" aria-label="Evaluation session">
        <button
          ref={restoreButtonRef}
          type="button"
          className="pc-eval-banner-restore-btn"
          aria-label={`Show evaluation bar: Evaluation · ${evaluation.name}`}
          onClick={() => setBannerHidden(false)}
        >
          <ChevronDown aria-hidden size={14} strokeWidth={2} />
          <span>Evaluation · {evaluation.name}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      ref={bannerRef}
      className="pc-status-notice is-warning pc-eval-banner"
      aria-label="Evaluation session"
    >
      <span className="pc-eval-banner-identity">
        <strong>Evaluation:</strong> {evaluation.label} · {evaluation.name}
      </span>
      <span className="pc-eval-banner-actions">
        <Link className="btn small" to="/evaluate">
          Evaluation guide
        </Link>
        <Form method="post" action="/sign-out">
          <button className="btn small" type="submit">
            Change persona
          </button>
        </Form>
        <button
          ref={hideButtonRef}
          className="btn small"
          type="button"
          aria-label="Hide evaluation bar"
          onClick={() => setBannerHidden(true)}
        >
          <ChevronUp aria-hidden size={14} strokeWidth={2} />
          Hide
        </button>
      </span>
    </aside>
  );
}
