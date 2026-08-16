import { CircleAlert } from "lucide-react";
import { type MouseEvent, useEffect, useId, useRef } from "react";
import { Link } from "react-router";

import { cn } from "~/lib/cn";

export type SummaryError =
  | string
  | {
      message: string;
      href?: string;
    };

function focusHashTarget(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (!href.startsWith("#")) return;

  const target = document.getElementById(href.slice(1));
  if (!target) return;

  event.preventDefault();
  target.focus();
  target.scrollIntoView({ block: "center" });
}

export function ErrorSummary({
  errors,
  title = "There is a problem",
  className,
  focusOnMount = true,
}: {
  errors: readonly SummaryError[];
  title?: string;
  className?: string;
  focusOnMount?: boolean;
}) {
  const titleId = useId();
  const summaryRef = useRef<HTMLElement>(null);
  const errorSignature = errors
    .map((error) => (typeof error === "string" ? error : `${error.href ?? ""}:${error.message}`))
    .join("|");
  useEffect(() => {
    if (focusOnMount && errorSignature) summaryRef.current?.focus();
  }, [errorSignature, focusOnMount]);
  if (!errors.length) return null;

  return (
    <section
      ref={summaryRef}
      className={cn("pc-error-summary", className)}
      role="alert"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <CircleAlert aria-hidden size={20} />
      <div>
        <h2 id={titleId}>{title}</h2>
        <ul>
          {errors.map((error, index) => {
            const item = typeof error === "string" ? { message: error } : error;
            const href = item.href;
            return (
              <li key={`${item.message}-${index}`}>
                {href ? (
                  <Link
                    to={href}
                    onClick={(event) => focusHashTarget(event, href)}
                  >
                    {item.message}
                  </Link>
                ) : (
                  item.message
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
