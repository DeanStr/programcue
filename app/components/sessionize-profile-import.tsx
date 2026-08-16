import { useState } from "react";

type ImportedProfile = {
  name: string;
  biography: string;
  tagline: string;
  sourceUrl: string;
};

function isImportedProfile(value: unknown): value is ImportedProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.name === "string" &&
    profile.name.trim().length > 0 &&
    typeof profile.biography === "string" &&
    profile.biography.trim().length > 0 &&
    typeof profile.tagline === "string" &&
    typeof profile.sourceUrl === "string" &&
    profile.sourceUrl.trim().length > 0
  );
}

export async function readProfileImportResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  }

  if (!result || typeof result !== "object") {
    throw new Error(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  }
  const payload = result as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error
        : "The public profile could not be imported.",
    );
  }
  if (!isImportedProfile(payload.profile)) {
    throw new Error(
      "Program Cue returned an invalid profile-import response. No details were changed.",
    );
  }
  return payload.profile;
}

export function SessionizeProfileImport({
  publicSlug,
  disabled,
  onImport,
}: {
  publicSlug: string;
  disabled: boolean;
  onImport: (profile: ImportedProfile) => void;
}) {
  const [profile, setProfile] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "success"; profile: ImportedProfile }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function importProfile() {
    setState({ kind: "loading" });
    try {
      const response = await fetch(
        `/apply/${encodeURIComponent(publicSlug)}/import/sessionize`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile }),
        },
      );
      const importedProfile = await readProfileImportResponse(response);
      onImport(importedProfile);
      setState({ kind: "success", profile: importedProfile });
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The public profile could not be imported.",
      });
    }
  }

  return (
    <section className="sessionize-import">
      <div>
        <strong>Reuse your public Sessionize profile</strong>
        <p className="help">
          Import your public name and biography, then review them here before
          saving. Program Cue never signs in to Sessionize or imports private
          account data.
        </p>
      </div>
      <label className="label">
        Sessionize public profile
        <span className="form-row">
          <input
            className="field"
            value={profile}
            disabled={disabled || state.kind === "loading"}
            placeholder="https://sessionize.com/your-name/"
            onChange={(event) => {
              setProfile(event.target.value);
              if (state.kind !== "loading") setState({ kind: "idle" });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (profile.trim()) void importProfile();
              }
            }}
          />
          <button
            className="btn"
            type="button"
            disabled={disabled || state.kind === "loading" || !profile.trim()}
            onClick={() => void importProfile()}
          >
            {state.kind === "loading" ? "Importing…" : "Import profile"}
          </button>
        </span>
      </label>
      {state.kind === "success" ? (
        <div className="validation-item ok" role="status">
          <strong>Imported for review</strong>
          <span>
            Name and biography came from{" "}
            <a
              href={state.profile.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              this public profile
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            . Save the draft when you are happy with them.
          </span>
        </div>
      ) : state.kind === "error" ? (
        <div className="validation-item error" role="alert">
          <strong>Import failed</strong>
          <span>{state.message}</span>
        </div>
      ) : null}
    </section>
  );
}
