import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Link, type LinkProps } from "react-router";

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

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    pending?: boolean;
    pendingLabel?: ReactNode;
  };

type ButtonLinkProps = Omit<LinkProps, "className"> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
  };

export type ButtonAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> &
  VariantProps<typeof buttonVariants>;

type ButtonClassNameOptions = VariantProps<typeof buttonVariants> & {
  className?: string;
};

type ButtonSummaryProps = Omit<HTMLAttributes<HTMLElement>, "className"> &
  ButtonClassNameOptions;

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  "aria-label": string;
};

type IconButtonAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  "aria-label": string;
};

function buttonClassName({
  className,
  variant,
  size,
}: ButtonClassNameOptions = {}) {
  return cn(buttonVariants({ variant, size }), className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant,
      size,
      type = "button",
      pending = false,
      pendingLabel,
      disabled,
      "aria-busy": ariaBusy,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName({ className, variant, size })}
        {...props}
        disabled={disabled || pending}
        aria-busy={pending ? true : ariaBusy}
      >
        {pending ? (
          <>
            <LoaderCircle className="pc-spin" aria-hidden size={16} />
            {pendingLabel ?? children}
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);

/**
 * A navigational action with the same closed visual vocabulary as Button.
 * Keeping it a real link preserves open-in-new-tab and browser navigation;
 * a polymorphic button would make that distinction much easier to lose.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink({ className, variant, size, ...props }, ref) {
    return (
      <Link
        ref={ref}
        className={buttonClassName({ className, variant, size })}
        {...props}
      />
    );
  },
);

/** External or document links retain native anchor behaviour and styling. */
export const ButtonAnchor = forwardRef<HTMLAnchorElement, ButtonAnchorProps>(
  function ButtonAnchor({ className, variant, size, ...props }, ref) {
    return (
      <a
        ref={ref}
        className={buttonClassName({ className, variant, size })}
        {...props}
      />
    );
  },
);

/** Disclosure triggers must remain the direct summary child of details. */
export const ButtonSummary = forwardRef<HTMLElement, ButtonSummaryProps>(
  function ButtonSummary({ className, variant, size, ...props }, ref) {
    return (
      <summary
        ref={ref}
        className={buttonClassName({ className, variant, size })}
        {...props}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, type = "button", children, ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn("icon-btn", className)}
        {...props}
      >
        {children}
      </button>
    );
  },
);

export const IconButtonAnchor = forwardRef<
  HTMLAnchorElement,
  IconButtonAnchorProps
>(function IconButtonAnchor({ className, children, ...props }, ref) {
  return (
    <a ref={ref} className={cn("icon-btn", className)} {...props}>
      {children}
    </a>
  );
});
