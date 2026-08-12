import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

const SCRIPT_ID = "program-cue-turnstile-script";
const SCRIPT_STATE_ATTRIBUTE = "data-program-cue-turnstile-state";
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
type TurnstileAppearance = "always" | "execute" | "interaction-only";

function boundedErrorName(error: unknown) {
  if (!(error instanceof Error)) return "UnknownError";
  const className = error.constructor?.name ?? "";
  return ERROR_NAME_PATTERN.test(className) ? className : "Error";
}

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: TurnstileAppearance;
      "response-field": boolean;
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise<TurnstileApi>((resolve, reject) => {
    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const scriptState = script?.getAttribute(SCRIPT_STATE_ATTRIBUTE);
    if (
      scriptState === "failed" ||
      scriptState === "loaded" ||
      scriptState === "loaded-without-api"
    ) {
      script?.remove();
      script = null;
    }
    let settled = false;
    let timeoutId: number | null = null;
    const cleanup = () => {
      script?.removeEventListener("load", loaded);
      script?.removeEventListener("error", failed);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
    const loaded = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (window.turnstile) {
        script?.setAttribute(SCRIPT_STATE_ATTRIBUTE, "loaded");
        resolve(window.turnstile);
      } else {
        script?.setAttribute(SCRIPT_STATE_ATTRIBUTE, "loaded-without-api");
        reject(new Error("Turnstile loaded without its browser API."));
      }
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      script?.setAttribute(SCRIPT_STATE_ATTRIBUTE, "failed");
      cleanup();
      reject(new Error("Turnstile could not be loaded."));
    };
    let created = false;
    if (!script) {
      script = document.createElement("script");
      created = true;
      script.id = SCRIPT_ID;
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
    }
    const scriptElement = script;
    scriptElement.addEventListener("load", loaded, { once: true });
    scriptElement.addEventListener("error", failed, { once: true });
    timeoutId = window.setTimeout(failed, 20_000);
    if (created) document.head.appendChild(scriptElement);
  });
}

export function TurnstileWidget({
  siteKey,
  action,
  onTokenChange,
  resetKey = 0,
  appearance = "always",
}: {
  siteKey: string | null;
  action:
    | "social_sign_in"
    | "sign_in"
    | "application_request_code"
    | "application_verify_code"
    | "application_start_anonymous"
    | "application_file_upload"
    | "public_itinerary_create";
  onTokenChange?: (token: string) => void;
  resetKey?: number;
  appearance?: TurnstileAppearance;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const submitted = useRef(false);
  const previousResetKey = useRef(resetKey);
  const onTokenChangeRef = useRef(onTokenChange);
  const [token, setToken] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const navigation = useNavigation();

  useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let active = true;
    setToken("");
    onTokenChangeRef.current?.("");
    setLoadFailed(false);
    void loadTurnstile()
      .then((turnstile) => {
        if (!active || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          appearance,
          "response-field": false,
          callback: (value) => {
            setToken(value);
            onTokenChangeRef.current?.(value);
          },
          "expired-callback": () => {
            setToken("");
            onTokenChangeRef.current?.("");
          },
          "error-callback": () => {
            setToken("");
            onTokenChangeRef.current?.("");
          },
        });
      })
      .catch((error) => {
        if (!active) return;
        setLoadFailed(true);
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "turnstile-widget",
            event: "load-failed",
            errorName: boundedErrorName(error),
            message: "Turnstile could not be loaded in the browser.",
          }),
        );
      });
    return () => {
      active = false;
      if (widgetId.current && window.turnstile) {
        window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      }
    };
  }, [action, appearance, loadAttempt, siteKey]);

  useEffect(() => {
    if (navigation.state === "submitting") {
      submitted.current = true;
      return;
    }
    if (
      navigation.state === "idle" &&
      submitted.current &&
      widgetId.current &&
      window.turnstile
    ) {
      submitted.current = false;
      setToken("");
      onTokenChangeRef.current?.("");
      window.turnstile.reset(widgetId.current);
    }
  }, [navigation.state]);

  useEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    setToken("");
    onTokenChangeRef.current?.("");
    if (widgetId.current && window.turnstile)
      window.turnstile.reset(widgetId.current);
  }, [resetKey]);

  if (!siteKey) return null;
  return (
    <>
      <div ref={container} />
      {loadFailed ? (
        <div className="validation-item error" role="alert">
          <span>
            Security verification could not load. Check your connection, then
            retry before submitting.
          </span>
          <button
            className="btn small"
            type="button"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          >
            Retry security verification
          </button>
        </div>
      ) : null}
      <input type="hidden" name="turnstile-token" value={token} />
    </>
  );
}
