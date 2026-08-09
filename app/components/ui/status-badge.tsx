import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "~/lib/cn";

const statusBadgeVariants = cva("status", {
  variants: {
    tone: {
      neutral: "neutral",
      success: "success",
      warning: "warning",
      danger: "danger",
      info: "info",
      ai: "ai",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type StatusBadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof statusBadgeVariants>;

export function StatusBadge({ tone, className, ...props }: StatusBadgeProps) {
  return <span className={cn(statusBadgeVariants({ tone }), className)} {...props} />;
}
