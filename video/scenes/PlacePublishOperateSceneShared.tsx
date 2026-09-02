import type { CSSProperties, ReactNode } from "react";

import { Easing, Img, interpolate } from "remotion";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE } from "../constants";

export type SceneProps = {
  duration: number;
};

export type RevealProps = {
  amount: number;
  children: ReactNode;
  x?: number;
  y?: number;
  scale?: number;
  style?: CSSProperties;
};

export const ink = PALETTE.ink;

export const deep = PALETTE.inkDeep;

export const paper = PALETTE.paper;

export const copper = PALETTE.copper;

export const copperText = PALETTE.copperDeep;

export const sage = PALETTE.sage;

export const line = PALETTE.line;

export const muted = PALETTE.muted;

export const clamp = (value: number) => Math.min(1, Math.max(0, value));

export const local = (value: number, start: number, end: number) =>
  clamp((value - start) / Math.max(0.0001, end - start));

export const cut = (value: number, start: number, end: number) =>
  value >= start && value < end ? 1 : 0;

export const ease = (value: number) =>
  Easing.bezier(0.22, 1, 0.36, 1)(clamp(value));

export const after = (value: number, start: number) => (value >= start ? 1 : 0);

export const frameProgress = (frame: number, duration: number) =>
  duration <= 1 ? 1 : clamp(frame / (duration - 1));

export function Reveal({
  amount,
  children,
  x = 0,
  y = 18,
  scale = 0.985,
  style,
}: RevealProps) {
  const eased = ease(amount);
  return (
    <div
      style={{
        opacity: eased,
        transform: `translate3d(${interpolate(eased, [0, 1], [x, 0])}px, ${interpolate(eased, [0, 1], [y, 0])}px, 0) scale(${interpolate(eased, [0, 1], [scale, 1])})`,
        transformOrigin: "center center",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function BrandMark({ dark = false }: { dark?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <ProgramCueMark
        accent={copper}
        ink={dark ? paper : ink}
        size={34}
        style={{
          filter: dark
            ? "drop-shadow(0 8px 12px rgba(190,98,66,.22))"
            : "drop-shadow(0 8px 12px rgba(24,37,34,.15))",
        }}
      />
      <div
        style={{
          color: dark ? paper : ink,
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: "0.02em",
        }}
      >
        PROGRAM CUE
      </div>
    </div>
  );
}

export function DotGrid({
  opacity = 0.32,
  dark = true,
}: {
  opacity?: number;
  dark?: boolean;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        backgroundImage: `radial-gradient(${dark ? "rgba(255,253,248,.28)" : "rgba(24,37,34,.16)"} 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
        maskImage:
          "linear-gradient(90deg, transparent 0%, black 14%, black 86%, transparent 100%)",
        pointerEvents: "none",
      }}
    />
  );
}

export function SceneHeader({
  chapter,
  index,
  progress,
  dark = true,
}: {
  chapter: string;
  index: string;
  progress: number;
  dark?: boolean;
}) {
  const textColor = dark ? paper : ink;
  const mutedColor = dark ? "rgba(255,253,248,.55)" : muted;
  return (
    <div
      style={{
        position: "absolute",
        top: 52,
        left: 76,
        right: 76,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        zIndex: 40,
      }}
    >
      <BrandMark dark={dark} />
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.18em",
            color: mutedColor,
          }}
        >
          {chapter}
        </div>
        <div
          style={{
            width: 1,
            height: 18,
            background: dark ? "rgba(255,255,255,.17)" : line,
          }}
        />
        <div
          style={{
            fontSize: 12,
            fontWeight: 800,
            color: textColor,
            letterSpacing: "0.12em",
          }}
        >
          {index}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 55,
          height: 1,
          background: dark ? "rgba(255,255,255,.13)" : line,
          transformOrigin: "left center",
          transform: `scaleX(${interpolate(progress, [0, 1], [0.06, 1])})`,
        }}
      />
    </div>
  );
}

export function FooterRail({
  activationPoints,
  progress,
  items,
  dark = true,
}: {
  activationPoints?: number[];
  progress: number;
  items: string[];
  dark?: boolean;
}) {
  const railColor = dark ? "rgba(255,253,248,.42)" : muted;
  return (
    <div
      style={{
        position: "absolute",
        left: 76,
        right: 76,
        bottom: 38,
        zIndex: 30,
        display: "flex",
        alignItems: "center",
        gap: 18,
        color: railColor,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.13em",
      }}
    >
      <div
        style={{
          height: 2,
          width: 182,
          borderRadius: 99,
          background: dark ? "rgba(255,255,255,.16)" : "rgba(24,37,34,.14)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: "100%",
            background: copper,
            transformOrigin: "left center",
          }}
        />
      </div>
      {items.map((item, index) => {
        const active = activationPoints
          ? progress >= (activationPoints[index] ?? 1)
          : progress >= index / Math.max(1, items.length - 1) - 0.08;
        return (
          <div
            key={item}
            style={{
              color: active ? (dark ? paper : ink) : railColor,
            }}
          >
            {String(index + 1).padStart(2, "0")} {item}
          </div>
        );
      })}
      <div style={{ marginLeft: "auto", opacity: 0.72 }}>
        PROGRAM CUE / LAUNCH FILM
      </div>
    </div>
  );
}

export function Eyebrow({
  children,
  tone = "copper",
  dark = false,
}: {
  children: ReactNode;
  tone?: "copper" | "sage" | "light";
  dark?: boolean;
}) {
  const color = tone === "sage" ? sage : tone === "light" ? paper : copper;
  const textColor = tone === "copper" && !dark ? copperText : color;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        color: textColor,
        fontSize: 11,
        fontWeight: 850,
        letterSpacing: "0.17em",
        textTransform: "uppercase",
        textShadow:
          dark && tone === "light" ? "0 1px 14px rgba(0,0,0,.24)" : undefined,
      }}
    >
      <span
        style={{ width: 20, height: 2, borderRadius: 99, background: color }}
      />
      {children}
    </div>
  );
}

export function Chip({
  children,
  tone = "neutral",
  dark = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "copper";
  dark?: boolean;
}) {
  const tones: Record<string, { bg: string; color: string; border: string }> = {
    neutral: {
      bg: dark ? "rgba(255,255,255,.08)" : "rgba(24,37,34,.06)",
      color: dark ? "rgba(255,253,248,.75)" : muted,
      border: dark ? "rgba(255,255,255,.13)" : "rgba(24,37,34,.13)",
    },
    good: {
      bg: "rgba(143,191,154,.14)",
      color: dark ? "#b8e7bf" : PALETTE.sageDeep,
      border: "rgba(143,191,154,.36)",
    },
    warn: {
      bg: "rgba(212,167,44,.15)",
      color: dark ? "#f7d56b" : "#806315",
      border: "rgba(212,167,44,.34)",
    },
    bad: {
      bg: "rgba(220,38,38,.13)",
      color: dark ? "#ffb0a8" : "#a52b27",
      border: "rgba(220,38,38,.32)",
    },
    copper: {
      bg: "rgba(190,98,66,.14)",
      color: dark ? "#ffc5aa" : copperText,
      border: "rgba(190,98,66,.34)",
    },
  };
  const palette = tones[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 25,
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.color,
        fontSize: 10,
        lineHeight: 1,
        fontWeight: 800,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Check({ color = sage }: { color?: string }) {
  return (
    <span
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        display: "inline-grid",
        placeItems: "center",
        background: `${color}20`,
        color,
        fontSize: 13,
        fontWeight: 900,
      }}
    >
      ✓
    </span>
  );
}

export function AssetWindow({
  src,
  label,
  caption,
  width = 620,
  height = 430,
  objectPosition = "top center",
  dark = false,
  radius = 22,
}: {
  src: string;
  label: string;
  caption?: string;
  width?: number;
  height?: number;
  objectPosition?: string;
  dark?: boolean;
  radius?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        overflow: "hidden",
        background: dark ? "#1a2523" : "#f6f7f2",
        border: `1px solid ${dark ? "rgba(255,255,255,.16)" : "rgba(24,37,34,.14)"}`,
        boxShadow: dark
          ? "0 26px 80px rgba(0,0,0,.3), 0 2px 0 rgba(255,255,255,.06) inset"
          : "0 26px 80px rgba(24,37,34,.15), 0 2px 0 rgba(255,255,255,.9) inset",
        position: "relative",
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 2,
          top: 0,
          left: 0,
          right: 0,
          height: 42,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 16px",
          color: dark ? "rgba(255,253,248,.76)" : muted,
          background: dark ? "rgba(11,20,19,.9)" : "rgba(255,255,255,.9)",
          borderBottom: `1px solid ${dark ? "rgba(255,255,255,.12)" : "rgba(24,37,34,.1)"}`,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.11em",
          textTransform: "uppercase",
          backdropFilter: "blur(12px)",
        }}
      >
        <span style={{ display: "flex", gap: 5 }}>
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#ff766a",
            }}
          />
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: PALETTE.gold,
            }}
          />
          <i
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: sage,
            }}
          />
        </span>
        {label}
        {caption ? (
          <span
            style={{
              marginLeft: "auto",
              color: dark ? "rgba(255,253,248,.45)" : muted,
              fontWeight: 700,
            }}
          >
            {caption}
          </span>
        ) : null}
      </div>
      <Img
        src={src}
        style={{
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: "cover",
          objectPosition,
          paddingTop: 42,
          background: dark ? "#1a2523" : "#f6f7f2",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(120deg, rgba(255,255,255,.08), transparent 26%, transparent 70%, rgba(11,20,19,.12))",
        }}
      />
    </div>
  );
}

export function MiniAvatar({
  initials,
  color = copper,
}: {
  initials: string;
  color?: string;
}) {
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 30,
        height: 30,
        borderRadius: "50%",
        color: paper,
        background: color,
        border: "2px solid rgba(255,255,255,.72)",
        fontSize: 10,
        fontWeight: 900,
      }}
    >
      {initials}
    </span>
  );
}

export function Arrow({
  color = copper,
  long = false,
}: {
  color?: string;
  long?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        width: long ? 118 : 72,
        gap: 0,
      }}
    >
      <div style={{ height: 1, flex: 1, background: color }} />
      <div
        style={{
          width: 8,
          height: 8,
          borderTop: `1.5px solid ${color}`,
          borderRight: `1.5px solid ${color}`,
          transform: "rotate(45deg)",
        }}
      />
    </div>
  );
}

export function Metric({
  value,
  label,
  tone = "ink",
  dark = false,
}: {
  value: string;
  label: string;
  tone?: "ink" | "copper" | "sage";
  dark?: boolean;
}) {
  const toneColor =
    tone === "copper" ? copper : tone === "sage" ? sage : dark ? paper : ink;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          color: toneColor,
          fontSize: 24,
          fontWeight: 850,
          letterSpacing: "-0.05em",
        }}
      >
        {value}
      </div>
      <div
        style={{
          color: dark ? "rgba(255,253,248,.52)" : muted,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}
