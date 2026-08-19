import { useId } from "react";

function timezoneNames() {
  const supportedValuesOf = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "timeZone") => string[];
    }
  ).supportedValuesOf;
  return [
    "UTC",
    ...(supportedValuesOf ? supportedValuesOf("timeZone") : []).filter(
      (timezone) =>
        timezone.includes("/") && !/^Etc\/GMT[+-]\d+$/iu.test(timezone),
    ),
  ];
}

export function timezoneLabel(timezone: string) {
  if (timezone === "UTC") return "Coordinated Universal Time";
  const locality = timezone.split("/").at(-1)?.replaceAll("_", " ") ?? timezone;
  return `${locality} · ${timezone}`;
}

const TIMEZONE_OPTIONS = timezoneNames().map((timezone) => ({
  value: timezone,
  label: timezoneLabel(timezone),
}));

export function TimezoneField({
  value,
  onChange,
  error,
  name = "timezone",
  id,
}: {
  value: string;
  onChange(value: string): void;
  error?: string;
  name?: string;
  id?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? `timezone-${generatedId}`;
  const listId = `${inputId}-options`;
  const helpId = `${inputId}-help`;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={`pc-field-group${error ? " has-error" : ""}`}>
      <label className="label" htmlFor={inputId}>
        <span className="pc-field-label">
          <span>Timezone</span>
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
        onChange={(event) => onChange(event.currentTarget.value)}
        list={listId}
        required
        autoComplete="off"
        placeholder="Search by city, for example Toronto"
        aria-invalid={error ? true : undefined}
        aria-describedby={[helpId, errorId].filter(Boolean).join(" ")}
      />
      <datalist id={listId}>
        {TIMEZONE_OPTIONS.map((timezone) => (
          <option
            key={timezone.value}
            value={timezone.value}
            label={timezone.label}
          />
        ))}
      </datalist>
      <span className="help" id={helpId}>
        Search by city or enter a canonical timezone such as America/Toronto.
      </span>
      {error ? (
        <span className="pc-field-error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
