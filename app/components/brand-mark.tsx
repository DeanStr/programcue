export function BrandMark({ size = "default" }: { size?: "default" | "small" }) {
  return (
    <svg
      aria-hidden="true"
      className={`brand-mark${size === "small" ? " small" : ""}`}
      focusable="false"
      viewBox="0 0 32 32"
    >
      <path className="brand-mark-ink" d="M3 3h10v4H7v6H3V3Z" />
      <path className="brand-mark-accent" d="M19 3h10v10h-4V7h-6V3Z" />
      <path className="brand-mark-ink" d="M25 19h4v10H19v-4h6v-6Z" />
      <path className="brand-mark-ink" d="M3 19h4v6h6v4H3V19Z" />
    </svg>
  );
}
