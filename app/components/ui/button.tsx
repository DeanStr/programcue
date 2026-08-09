import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/cn";

const buttonVariants = cva("btn", {
  variants: {
    variant: {
      default: "",
      primary: "primary",
      danger: "danger",
      ghost: "ghost",
    },
    size: {
      default: "",
      small: "small",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & {
  pending?: boolean;
  pendingLabel?: ReactNode;
};

export function Button({ className, variant, size, type = "button", pending = false, pendingLabel, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? <><LoaderCircle className="pc-spin" aria-hidden size={15} />{pendingLabel ?? children}</> : children}
    </button>
  );
}
