import type { DuplicatePersonMatch } from "~/modules/people/person-duplicate-service.server";

export function PersonDuplicateWarning({
  id,
  matches,
  truncated,
}: {
  id: string;
  matches: ReadonlyArray<DuplicatePersonMatch>;
  truncated: boolean;
}) {
  return (
    <section className="validation-item warn" aria-labelledby={`${id}-heading`}>
      <div>
        <h3 id={`${id}-heading`}>
          Likely existing {matches.length === 1 ? "person" : "people"}
        </h3>
        <p>
          Exact-email matches reuse the existing identity. A same-name match
          with another email may create a duplicate, so verify the address
          before continuing.
        </p>
        <ul>
          {matches.map((match) => (
            <li key={match.personId}>
              <strong>{match.name}</strong> · {match.email} —{" "}
              {match.reasons.includes("same_email")
                ? "same email"
                : "same name"}
              {match.currentEvent
                ? " · current event"
                : match.scopes.length
                  ? ` · ${match.scopes.join(", ")}`
                  : " · organisation identity"}
            </li>
          ))}
        </ul>
        {truncated ? (
          <p>
            More matches exist. Search the Speakers directory before continuing.
          </p>
        ) : null}
      </div>
      <label className="speaker-confirm">
        <input
          type="checkbox"
          name="confirmDuplicatePeople"
          value="yes"
          required
        />{" "}
        I reviewed these identities and confirm the entered names and email
        addresses.
      </label>
    </section>
  );
}
