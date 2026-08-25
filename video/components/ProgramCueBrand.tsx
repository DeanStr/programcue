import type { CSSProperties } from "react";

import { PALETTE } from "../constants";

type ProgramCueMarkProps = {
  accent?: string;
  ink?: string;
  opacity?: number;
  size?: number;
  style?: CSSProperties;
};

/** The four-corner Program Cue mark used consistently across every film chapter. */
export function ProgramCueMark({
  accent = PALETTE.copper,
  ink = PALETTE.paper,
  opacity = 1,
  size = 96,
  style,
}: ProgramCueMarkProps) {
  return (
    <svg
      aria-label="Program Cue mark"
      role="img"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      style={{ display: "block", flex: "0 0 auto", opacity, ...style }}
    >
      <path fill={ink} d="M3 3h10v4H7v6H3V3Z" />
      <path fill={accent} d="M19 3h10v10h-4V7h-6V3Z" />
      <path fill={ink} d="M25 19h4v10H19v-4h6v-6Z" />
      <path fill={ink} d="M3 19h4v6h6v4H3V19Z" />
    </svg>
  );
}
