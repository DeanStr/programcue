export function safeReturnTo(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return "/";
  const applicationOrigin = new URL("https://programcue.invalid");
  const target = new URL(value, applicationOrigin);
  if (target.origin !== applicationOrigin.origin) return "/";
  const pathname = target.pathname.replace(/\/$/, "") || "/";
  if (
    pathname === "/sign-in" ||
    pathname === "/sign-out" ||
    pathname.startsWith("/api/auth/")
  )
    return "/";
  return `${target.pathname}${target.search}${target.hash}`;
}
