import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { Button } from "~/components/ui/button";
import { canonicalSlugOnBlur, sanitizeSlugInput, slugify } from "~/lib/slug";

export function DerivedSlugField({
  source,
  value,
  onChange,
  name = "slug",
  label = "URL slug",
  maximumLength = 80,
  customMaximumLength = maximumLength,
  initiallyDerived = true,
  resetKey,
  publicPathPrefix,
  disabled = false,
  error,
  id,
  availabilityUrl,
}: {
  source: string;
  value: string;
  onChange(value: string): void;
  name?: string;
  label?: string;
  maximumLength?: number;
  customMaximumLength?: number | null;
  initiallyDerived?: boolean;
  resetKey?: string;
  publicPathPrefix?: string;
  disabled?: boolean;
  error?: string;
  id?: string;
  availabilityUrl?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? `derived-slug-${generatedId}`;
  const helpId = `${inputId}-help`;
  const [derived, setDerived] = useState(initiallyDerived);
  const availability = useFetcher<{
    slug: string;
    available: boolean;
    message: string;
  }>();
  const loadAvailability = availability.load;
  const previousResetKey = useRef(resetKey);
  const suggestion = slugify(source, { maximumLength });
  const resetChanged = previousResetKey.current !== resetKey;
  const derivationError =
    source.trim() && !suggestion && !value
      ? "Enter a URL slug using Latin letters or numbers; this name cannot be converted automatically."
      : undefined;
  const visibleError = error ?? derivationError;
  const errorId = visibleError ? `${inputId}-error` : undefined;

  useEffect(() => {
    if (!resetChanged) return;
    previousResetKey.current = resetKey;
    setDerived(initiallyDerived);
    if (initiallyDerived && value !== suggestion) onChange(suggestion);
  }, [initiallyDerived, onChange, resetChanged, resetKey, suggestion, value]);

  useEffect(() => {
    if (!resetChanged && derived && value !== suggestion) onChange(suggestion);
  }, [derived, onChange, resetChanged, suggestion, value]);

  useEffect(() => {
    if (
      !availabilityUrl ||
      disabled ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    )
      return;
    const timer = window.setTimeout(() => {
      void loadAvailability(
        `${availabilityUrl}?slug=${encodeURIComponent(value)}`,
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [availabilityUrl, disabled, loadAvailability, value]);

  return (
    <div className={`pc-field-group${visibleError ? " has-error" : ""}`}>
      <label className="label" htmlFor={inputId}>
        <span className="pc-field-label">
          <span>{label}</span>
          <span className="pc-required" aria-hidden="true">
            Required
          </span>
        </span>
      </label>
      <input
        className="field"
        id={inputId}
        name={name}
        value={value}
        onChange={(event) => {
          setDerived(false);
          onChange(
            sanitizeSlugInput(event.currentTarget.value, {
              maximumLength: customMaximumLength,
            }),
          );
        }}
        onBlur={() => {
          const canonical = canonicalSlugOnBlur(value, derived, {
            maximumLength,
          });
          if (canonical !== value) onChange(canonical);
        }}
        required
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        maxLength={customMaximumLength ?? undefined}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        aria-invalid={visibleError ? true : undefined}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ")}
      />
      <span className="help" id={helpId}>
        {publicPathPrefix ? (
          <>
            Public path:{" "}
            <code>
              {publicPathPrefix}
              {value || suggestion}
            </code>
            .{" "}
          </>
        ) : null}
        {derived
          ? "Updates from the name until you edit it."
          : "Your custom slug will stay unchanged when the name changes."}
        {!derived && suggestion && suggestion !== value ? (
          <Button
            className="pc-inline-action"
            size="small"
            onClick={() => {
              setDerived(true);
              onChange(suggestion);
            }}
          >
            Use suggested slug
          </Button>
        ) : null}
      </span>
      {visibleError ? (
        <span className="pc-field-error" id={errorId} role="alert">
          {visibleError}
        </span>
      ) : null}
      {!visibleError && availabilityUrl && value ? (
        <span
          className={`help${availability.data?.slug === value && availability.data.available === false ? " field-error" : ""}`}
          role={
            availability.data?.slug === value &&
            availability.data.available === false
              ? "alert"
              : "status"
          }
        >
          {availability.state !== "idle"
            ? "Checking availability…"
            : availability.data?.slug === value
              ? availability.data.message
              : "Availability will be checked."}
        </span>
      ) : null}
    </div>
  );
}
