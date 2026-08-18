export type RouteErrorRecovery = {
  href: string;
  label: string;
};

export type RouteErrorRecoveryInput = {
  status: number | null;
  pathname: string;
  evaluation: boolean;
  adminContextLoaded?: boolean;
};

function isPublicPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/apply/") ||
    pathname.startsWith("/embed/") ||
    pathname.startsWith("/api/docs")
  );
}

export function routeErrorRecovery({
  status,
  pathname,
  evaluation,
  adminContextLoaded = false,
}: RouteErrorRecoveryInput): RouteErrorRecovery {
  if (status === 401) {
    if (evaluation) {
      return { href: "/evaluate", label: "Choose an evaluation persona" };
    }
    return { href: "/sign-in", label: "Sign in" };
  }

  if (
    evaluation &&
    (status === 403 || status === 404 || status === 400 || status === 428)
  ) {
    return { href: "/evaluate", label: "Choose an evaluation persona" };
  }

  if (status === 403 || status === 400 || status === 428) {
    if (adminContextLoaded) {
      return { href: "/admin/command", label: "Go to Command Centre" };
    }
    return { href: "/events/select", label: "Choose an event" };
  }

  if (status === 404) {
    if (isPublicPath(pathname) || pathname.startsWith("/api/")) {
      return { href: "/", label: "Go to home" };
    }
    if (
      pathname.startsWith("/participant/") ||
      pathname.startsWith("/review/")
    ) {
      return { href: "/events/select", label: "Choose an event" };
    }
    if (adminContextLoaded || pathname.startsWith("/admin/")) {
      return { href: "/admin/command", label: "Go to Command Centre" };
    }
    return { href: "/", label: "Go to home" };
  }

  if (adminContextLoaded || pathname.startsWith("/admin/")) {
    return { href: "/admin/command", label: "Go to Command Centre" };
  }
  return { href: "/", label: "Go to home" };
}

export function shouldOfferErrorRetry(status: number | null) {
  return status === null || status >= 500 || status === 409 || status === 429;
}

export function sanitizeRouteErrorMessage(status: number, message: string) {
  if (status === 404 && /no route matches url/iu.test(message)) {
    return "That page does not exist, or the link has changed.";
  }
  return message;
}
