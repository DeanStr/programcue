import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { useEffect } from "react";

import type { Route } from "./+types/root";
import "./tailwind.css";

export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: "/styles.css" },
  {
    rel: "icon",
    href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%234f46e5'/%3E%3Cpath d='M20 14h18c11 0 18 6 18 16s-7 16-18 16h-8v8H20V14zm10 10v12h8c5 0 8-2 8-6s-3-6-8-6h-8z' fill='white'/%3E%3C/svg%3E",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "Program Cue" },
  {
    name: "description",
    content: "Conference programme operations, submissions, reviews, speaker readiness, communications and scheduling.",
  },
  { name: "theme-color", content: "#0b1428" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main">Skip to main content</a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useEffect(() => {
    document.body.dataset.hydrated = "true";
    return () => { delete document.body.dataset.hydrated; };
  }, []);
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "The request could not be completed.";

  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Page not found" : `${error.status} ${error.statusText}`;
    if (error.status < 500 && typeof error.data === "string") message = error.data;
  } else if (error instanceof Error && import.meta.env.DEV) {
    message = error.message;
  }

  return (
    <main className="design-board" id="main">
      <section className="card pad" style={{ maxWidth: 680, margin: "8vh auto" }}>
        <span className="brand-mark">P</span>
        <h1>{title}</h1>
        <p className="subtle">{message}</p>
        <a className="btn primary" href="/admin/event">Return to Event Setup</a>
      </section>
    </main>
  );
}
