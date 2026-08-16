import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Disclosure marker for a collapsible record panel. The native marker is hidden
 * in CSS so the arrow can carry the open/closed rotation; <details> still owns
 * the actual behaviour, so this is decorative.
 */
export function RecordChevron() {
  return (
    <ChevronRight
      aria-hidden
      className="event-record-chevron"
      size={16}
      strokeWidth={2.5}
    />
  );
}

/**
 * One labelled cell of a record row.
 *
 * The caption is a real <label>, so the control keeps its accessible name at
 * every viewport width. Above 700px the stylesheet hides the caption visually
 * because the list's header row already names the column; below that the header
 * row is gone and the caption becomes the visible label again. Repeated rows
 * can supply a record-specific accessible caption without lengthening the
 * visible mobile label.
 */
export function RecordField({
  caption,
  accessibleCaption,
  children,
}: {
  caption: string;
  accessibleCaption?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: The caller supplies the wrapped form control through children.
    <label className="label event-record-field">
      <span
        className="event-record-caption"
        aria-hidden={accessibleCaption ? true : undefined}
      >
        {caption}
      </span>
      {accessibleCaption ? (
        <span className="sr-only">{accessibleCaption}</span>
      ) : null}
      {children}
    </label>
  );
}

/**
 * Column captions for a record list. Hidden from assistive technology because
 * every control below it is already labelled by its own RecordField.
 */
export function RecordHead({
  columns,
  captions,
}: {
  columns: string;
  captions: readonly string[];
}) {
  return (
    <div className={`event-record-head ${columns}`} aria-hidden="true">
      {captions.map((caption, column) => (
        // Trailing action columns have no caption, so several are the empty
        // string and the caption cannot be the key.
        // biome-ignore lint/suspicious/noArrayIndexKey: These stateless captions have fixed positional identity, including duplicate empty action captions.
        <span key={column}>{caption}</span>
      ))}
    </div>
  );
}
