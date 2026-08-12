import { cloneElement, type ReactElement, type ReactNode, useId } from "react";

import { cn } from "~/lib/cn";

type FieldControlProps = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
};

export type FieldProps = {
  label: ReactNode;
  children: ReactElement<FieldControlProps>;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
};

export function Field({ label, children, description, error, required = false, className }: FieldProps) {
  const generatedId = useId();
  const controlId = children.props.id ?? `field-${generatedId}`;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  const control = cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : children.props["aria-invalid"],
    "aria-required": required ? true : children.props["aria-required"],
  });

  return (
    <div className={cn("pc-field-group", error && "has-error", className)}>
      <label className="label" htmlFor={controlId}>
        <span className="pc-field-label">
          <span>{label}</span>
          {required ? <span className="pc-required">Required</span> : null}
        </span>
      </label>
      {description ? <p className="help pc-field-description" id={descriptionId}>{description}</p> : null}
      {control}
      {/* role="alert" so a validation failure is announced, not just rendered. */}
      {error ? (
        <p className="pc-field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
