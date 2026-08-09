import { CircleAlert } from "lucide-react";
import { useId } from "react";

import { cn } from "~/lib/cn";

export type SummaryError = string | {
  message: string;
  href?: string;
};

export function ErrorSummary({
  errors,
  title = "There is a problem",
  className,
}: {
  errors: readonly SummaryError[];
  title?: string;
  className?: string;
}) {
  const titleId = useId();
  if (!errors.length) return null;

  return (
    <section className={cn("pc-error-summary", className)} role="alert" aria-labelledby={titleId} tabIndex={-1}>
      <CircleAlert aria-hidden size={20} />
      <div>
        <h2 id={titleId}>{title}</h2>
        <ul>
          {errors.map((error, index) => {
            const item = typeof error === "string" ? { message: error } : error;
            return <li key={`${item.message}-${index}`}>{item.href ? <a href={item.href}>{item.message}</a> : item.message}</li>;
          })}
        </ul>
      </div>
    </section>
  );
}
