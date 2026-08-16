export function CharacterCount({
  value,
  maximum,
  id,
  threshold = 0.8,
}: {
  value: string;
  maximum: number;
  id?: string;
  threshold?: number;
}) {
  const remaining = maximum - value.length;
  if (value.length < maximum * threshold)
    return id ? (
      <small className="sr-only" id={id}>
        Maximum {maximum.toLocaleString()} characters.
      </small>
    ) : null;
  return (
    <small
      className="subtle pc-character-count pc-num"
      id={id}
      aria-live="polite"
    >
      {remaining.toLocaleString()}{" "}
      {remaining === 1 ? "character" : "characters"} remaining
    </small>
  );
}
