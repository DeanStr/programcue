import { Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";

type PersonMatch = {
  personId: string;
  name: string;
  email: string;
  currentEvent: boolean;
};

export function PersonLookup({
  onSelect,
  label = "Find an existing person",
  suggestedQuery,
}: {
  onSelect(person: PersonMatch): void;
  label?: string;
  suggestedQuery?: string;
}) {
  const generatedId = useId();
  const inputId = `person-lookup-${generatedId}`;
  const resultsId = `${inputId}-results`;
  const errorId = `${inputId}-error`;
  const [query, setQuery] = useState("");
  const fetcher = useFetcher<{
    query: string;
    matches: PersonMatch[];
    error?: string;
  }>();
  const loadPeople = fetcher.load;

  useEffect(() => {
    if (suggestedQuery !== undefined) setQuery(suggestedQuery.trim());
  }, [suggestedQuery]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const timer = window.setTimeout(() => {
      void loadPeople(
        `/admin/people/search?query=${encodeURIComponent(trimmed)}`,
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [loadPeople, query]);

  const trimmedQuery = query.trim();
  const searchError =
    fetcher.data?.query === trimmedQuery ? fetcher.data.error : undefined;
  const matches =
    trimmedQuery.length >= 2 &&
    fetcher.data?.query === trimmedQuery &&
    !searchError
      ? fetcher.data.matches
      : [];
  return (
    <div className="pc-person-lookup">
      <label className="label" htmlFor={inputId}>
        {label} <span className="subtle">Optional</span>
      </label>
      <div className="pc-input-with-icon">
        <Search aria-hidden size={16} />
        <input
          className="field"
          id={inputId}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search name or email before creating a record"
          autoComplete="off"
          maxLength={254}
          aria-controls={resultsId}
          aria-invalid={searchError ? true : undefined}
          aria-describedby={searchError ? errorId : undefined}
        />
      </div>
      <div className="stack-list" id={resultsId} aria-live="polite">
        {fetcher.state !== "idle" && query.trim().length >= 2 ? (
          <span className="help">Searching existing people…</span>
        ) : null}
        {fetcher.state === "idle" && searchError ? (
          <span className="field-error" id={errorId} role="alert">
            {searchError}
          </span>
        ) : null}
        {matches.map((person) => (
          <button
            className="list-row pc-person-lookup-result"
            type="button"
            key={person.personId}
            disabled={person.currentEvent}
            onClick={() => {
              onSelect(person);
              setQuery("");
            }}
          >
            <span>
              <strong>{person.name}</strong>
              <small className="subtle">{person.email}</small>
            </span>
            <span
              className={`status ${person.currentEvent ? "success" : "info"}`}
            >
              {person.currentEvent
                ? "Already in this event"
                : "In this organisation"}
            </span>
          </button>
        ))}
        {fetcher.state === "idle" &&
        trimmedQuery.length >= 2 &&
        fetcher.data?.query === trimmedQuery &&
        fetcher.data &&
        !searchError &&
        !matches.length ? (
          <span className="help">
            No existing person matches. Enter a new record below.
          </span>
        ) : null}
      </div>
    </div>
  );
}
