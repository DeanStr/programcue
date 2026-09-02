import type { CSSProperties, ReactNode } from "react";

import { Easing, interpolate } from "remotion";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE, VIDEO } from "../constants";

export type SceneProps = {
  duration: number;
};

export const clamp = (value: number) => Math.max(0, Math.min(1, value));

export const motion = (
  frame: number,
  input: readonly [number, number],
  output: readonly [number, number],
  easing: (value: number) => number = Easing.inOut(Easing.cubic),
) =>
  interpolate(frame, input, output, {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const fadeIn = (frame: number, start: number, end: number) =>
  motion(frame, [start, end], [0, 1], Easing.out(Easing.quad));

export const fadeOut = (frame: number, start: number, end: number) =>
  motion(frame, [start, end], [1, 0], Easing.in(Easing.quad));

export const mono: CSSProperties = {
  fontFamily:
    '"SFMono-Regular", "Roboto Mono", "Liberation Mono", ui-monospace, monospace',
  letterSpacing: "0.16em",
  textTransform: "uppercase",
};

export const sans: CSSProperties = {
  fontFamily:
    '"Program Cue Inter", Inter, ui-sans-serif, system-ui, sans-serif',
};

export function CornerFrame({
  color = PALETTE.copper,
  opacity = 0.36,
  inset = 68,
}: {
  color?: string;
  opacity?: number;
  inset?: number;
}) {
  const stroke = { stroke: color, strokeWidth: 1, fill: "none" };
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${VIDEO.width} ${VIDEO.height}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity,
      }}
    >
      <path
        d={`M${inset} ${inset + 28}V${inset}h28 M${VIDEO.width - inset - 28} ${inset}h28v28`}
        {...stroke}
      />
      <path
        d={`M${inset} ${VIDEO.height - inset - 28}v28h28 M${VIDEO.width - inset - 28} ${VIDEO.height - inset}h28v-28`}
        {...stroke}
      />
      <path
        d={`M${inset + 9} ${inset + 27}V${VIDEO.height - inset - 27} M${VIDEO.width - inset - 9} ${inset + 27}V${VIDEO.height - inset - 27}`}
        stroke={color}
        strokeWidth={0.5}
        strokeDasharray="1 14"
        opacity={0.45}
      />
    </svg>
  );
}

export function FilmGrain({
  tone = "light",
  opacity = 0.12,
}: {
  tone?: "light" | "dark";
  opacity?: number;
}) {
  const dots = Array.from({ length: 48 }, (_, index) => {
    const x = (index * 47 + 11) % 100;
    const y = (index * 71 + 19) % 100;
    const size = 1 + ((index * 13) % 3);
    return { x, y, size, delay: (index * 7) % 30 };
  });
  const color = tone === "dark" ? PALETTE.inkDeep : PALETTE.paper;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        mixBlendMode: "soft-light",
        pointerEvents: "none",
      }}
    >
      {dots.map((dot) => (
        <span
          key={`${dot.x}-${dot.y}`}
          style={{
            position: "absolute",
            left: `${dot.x}%`,
            top: `${dot.y}%`,
            width: dot.size,
            height: dot.size,
            borderRadius: "50%",
            background: color,
            opacity: 0.22 + (dot.delay % 5) / 20,
          }}
        />
      ))}
    </div>
  );
}

export function GridField({
  frame,
  color = PALETTE.copper,
  opacity = 0.13,
  horizon = 0.66,
}: {
  frame: number;
  color?: string;
  opacity?: number;
  horizon?: number;
}) {
  const drift = (frame * 0.22) % 56;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: `${(1 - horizon) * 100}%`,
        opacity,
        overflow: "hidden",
        maskImage:
          "linear-gradient(to bottom, transparent, black 14%, black 72%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, black 14%, black 72%, transparent)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -56,
          transform: `translateY(${drift}px)`,
          backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
          backgroundSize: "56px 56px",
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(to bottom, rgba(11,20,19,0.96), transparent 24%, transparent 72%, rgba(11,20,19,0.95))",
        }}
      />
    </div>
  );
}

export function Kicker({
  children,
  color = PALETTE.copper,
  opacity = 1,
}: {
  children: ReactNode;
  color?: string;
  opacity?: number;
}) {
  return (
    <div
      style={{
        ...mono,
        fontSize: 17,
        lineHeight: 1.4,
        color,
        opacity,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

export function Wordmark({
  frame,
  dark = false,
  size = 34,
  delay = 0,
}: {
  frame: number;
  dark?: boolean;
  size?: number;
  delay?: number;
}) {
  const opacity = fadeIn(frame, delay, delay + 36);
  const translate = motion(
    frame,
    [delay, delay + 40],
    [10, 0],
    Easing.out(Easing.cubic),
  );
  const color = dark ? PALETTE.ink : PALETTE.paper;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        color,
        opacity,
        transform: `translateX(${translate}px)`,
      }}
    >
      <ProgramCueMark size={size} accent={PALETTE.copper} ink={color} />
      <span
        style={{
          ...sans,
          fontSize: size * 0.56,
          letterSpacing: "-0.055em",
          fontWeight: 750,
          whiteSpace: "nowrap",
        }}
      >
        Program Cue
      </span>
    </div>
  );
}

export function OrbitalMark({
  frame,
  size,
  dark = false,
  delay = 0,
  opacity = 1,
}: {
  frame: number;
  size: number;
  dark?: boolean;
  delay?: number;
  opacity?: number;
}) {
  const markOpacity = fadeIn(frame, delay, delay + 44) * opacity;
  const turn = motion(
    frame,
    [delay, delay + 300],
    [-7, 10],
    Easing.inOut(Easing.cubic),
  );
  const scale = motion(
    frame,
    [delay, delay + 70],
    [0.86, 1],
    Easing.out(Easing.back(1.1)),
  );
  const line = dark ? PALETTE.ink : PALETTE.paper;
  const glow = dark ? "rgba(190,98,66,0.08)" : "rgba(246,197,169,0.12)";
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: size,
        height: size,
        opacity: markOpacity,
        transform: `scale(${scale}) rotate(${turn}deg)`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: -size * 0.38,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${glow}, transparent 66%)`,
        }}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        width={size}
        height={size}
        style={{ position: "absolute", inset: 0 }}
      >
        <circle
          cx="50"
          cy="50"
          r="46"
          fill="none"
          stroke={line}
          strokeOpacity={0.22}
          strokeWidth="0.7"
          strokeDasharray="1 5"
        />
        <circle
          cx="50"
          cy="50"
          r="37"
          fill="none"
          stroke={PALETTE.copper}
          strokeOpacity={0.35}
          strokeWidth="0.65"
          strokeDasharray="22 19"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: size * 0.2,
          display: "grid",
          placeItems: "center",
        }}
      >
        <ProgramCueMark size={size * 0.62} accent={PALETTE.copper} ink={line} />
      </div>
    </div>
  );
}

export function TraceField({
  frame,
  dark = true,
  opacity = 1,
}: {
  frame: number;
  dark?: boolean;
  opacity?: number;
}) {
  const line = dark ? PALETTE.paper : PALETTE.ink;
  const draw = motion(frame, [0, 120], [1, 0.1], Easing.out(Easing.cubic));
  const drift = frame * 0.08;
  const traces = [
    {
      d: "M80 228H320L398 306H724",
      width: 1.5,
      dash: "220 760",
      offset: -frame * 5.4,
    },
    {
      d: "M1420 208H1690L1796 314V544",
      width: 1,
      dash: "320 700",
      offset: frame * 4.2,
    },
    {
      d: "M180 844H484L576 752H940",
      width: 1,
      dash: "440 940",
      offset: -frame * 3.6,
    },
    {
      d: "M1110 846H1394L1536 704H1842",
      width: 1.25,
      dash: "380 900",
      offset: frame * 3.1,
    },
    {
      d: "M960 76V198L1040 278V430",
      width: 0.8,
      dash: "220 700",
      offset: frame * 2.5,
    },
  ];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: opacity * draw,
        transform: `translateX(${drift}px)`,
      }}
    >
      {traces.map((trace, index) => (
        <g key={trace.d}>
          <path
            d={trace.d}
            fill="none"
            stroke={line}
            strokeOpacity={0.12}
            strokeWidth={trace.width * 3}
          />
          <path
            d={trace.d}
            fill="none"
            stroke={index % 3 === 0 ? PALETTE.copper : line}
            strokeOpacity={index % 2 === 0 ? 0.5 : 0.28}
            strokeWidth={trace.width}
            strokeDasharray={trace.dash}
            strokeDashoffset={trace.offset}
          />
          <circle
            cx={[398, 1796, 576, 1536, 1040][index]}
            cy={[306, 314, 752, 704, 278][index]}
            r={index % 2 ? 3 : 4}
            fill={index % 3 === 0 ? PALETTE.copper : line}
            fillOpacity={0.7}
          />
        </g>
      ))}
    </svg>
  );
}

export function Scanline({
  frame,
  color = PALETTE.copper,
  start = 0,
  opacity = 0.65,
}: {
  frame: number;
  color?: string;
  start?: number;
  opacity?: number;
}) {
  const x = motion(
    frame,
    [start, start + 100],
    [-10, 110],
    Easing.inOut(Easing.cubic),
  );
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: `${x}%`,
        width: 1,
        opacity,
        background: `linear-gradient(to bottom, transparent, ${color}, transparent)`,
        boxShadow: `0 0 24px ${color}`,
      }}
    />
  );
}
