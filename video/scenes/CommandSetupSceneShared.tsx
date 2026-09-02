import type { ReactNode } from "react";

import { AbsoluteFill, Easing, Img, interpolate } from "remotion";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE } from "../constants";

/** Shared visual language for the independently owned command and setup scenes. */
export type ProductSceneProps = {
  duration: number;
};

export const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

export const sans =
  '"Program Cue Inter", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const ease = Easing.bezier(0.22, 1, 0.36, 1);

export const softEase = Easing.bezier(0.33, 1, 0.68, 1);

export function between(
  frame: number,
  start: number,
  end: number,
  from = 0,
  to = 1,
  easing: (value: number) => number = ease,
) {
  return interpolate(frame, [start, end], [from, to], {
    ...clamp,
    easing,
  });
}

export function enter(frame: number, start: number, length = 42) {
  return between(frame, start, start + length, 0, 1, softEase);
}

export function fade(
  frame: number,
  start: number,
  end: number,
  outStart?: number,
  outEnd?: number,
) {
  const inOpacity = enter(frame, start, Math.max(1, end - start));
  if (outStart === undefined || outEnd === undefined) return inOpacity;
  return Math.min(inOpacity, between(frame, outStart, outEnd, 1, 0, softEase));
}

export function rise(frame: number, start: number, distance = 24, length = 48) {
  return between(frame, start, start + length, distance, 0, softEase);
}

export function Kicker({
  children,
  color = PALETTE.copperSoft,
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <div
      style={{
        color,
        fontFamily: sans,
        fontSize: 14,
        fontWeight: 750,
        letterSpacing: "0.18em",
        lineHeight: 1.2,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

export function GridBackdrop({ light = false }: { light?: boolean }) {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: light ? PALETTE.editorial : PALETTE.inkDeep,
        backgroundImage: light
          ? "linear-gradient(rgba(24,37,34,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(24,37,34,.045) 1px, transparent 1px), radial-gradient(circle at 90% 6%, rgba(190,98,66,.10), transparent 32%)"
          : "linear-gradient(rgba(255,253,248,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,253,248,.035) 1px, transparent 1px), radial-gradient(circle at 80% 0%, rgba(190,98,66,.20), transparent 34%), radial-gradient(circle at 10% 94%, rgba(58,95,66,.18), transparent 32%)",
        backgroundSize: "64px 64px, 64px 64px, auto, auto",
        pointerEvents: "none",
      }}
    />
  );
}

export function Hairline({
  color = "rgba(255,253,248,.16)",
  width = 1,
}: {
  color?: string;
  width?: number;
}) {
  return (
    <div style={{ backgroundColor: color, height: width, width: "100%" }} />
  );
}

export function BrowserWindow({
  src,
  alt,
  x,
  y,
  width,
  height,
  imageWidth,
  imageTop = 0,
  imageLeft = 0,
  imageScale = 1,
  radius = 18,
  shadow = true,
  children,
  opacity = 1,
  transform,
}: {
  src: string;
  alt: string;
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageTop?: number;
  imageLeft?: number;
  imageScale?: number;
  radius?: number;
  shadow?: boolean;
  children?: ReactNode;
  opacity?: number;
  transform?: string;
}) {
  return (
    <div
      style={{
        backgroundColor: "#fdfcf8",
        border: "1px solid rgba(255,255,255,.38)",
        borderRadius: radius,
        boxShadow: shadow
          ? "0 34px 70px rgba(0,0,0,.34), 0 3px 12px rgba(0,0,0,.22)"
          : undefined,
        height,
        left: x,
        opacity,
        overflow: "hidden",
        position: "absolute",
        top: y,
        transform,
        transformOrigin: "center center",
        width,
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "linear-gradient(180deg, #fafbf8 0%, #f0f2ee 100%)",
          borderBottom: "1px solid #d9ddd7",
          display: "flex",
          height: 46,
          justifyContent: "space-between",
          padding: "0 18px",
        }}
      >
        <div style={{ display: "flex", gap: 7 }}>
          {(["#e49b85", "#e9c56b", "#8fbf9a"] as const).map((color) => (
            <span
              key={color}
              style={{
                backgroundColor: color,
                borderRadius: "50%",
                height: 9,
                width: 9,
              }}
            />
          ))}
        </div>
        <div
          style={{
            backgroundColor: "#ffffff",
            border: "1px solid #dde2dc",
            borderRadius: 7,
            color: "#71817a",
            fontFamily: sans,
            fontSize: 11,
            letterSpacing: "0.01em",
            overflow: "hidden",
            padding: "7px 52px",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >
          app.programcue.com / Future of Events 2027
        </div>
        <div style={{ color: "#8a9790", fontFamily: sans, fontSize: 14 }}>
          •••
        </div>
      </div>
      <div
        style={{
          bottom: 0,
          left: 0,
          overflow: "hidden",
          position: "absolute",
          right: 0,
          top: 46,
        }}
      >
        <Img
          alt={alt}
          src={src}
          style={{
            display: "block",
            left: imageLeft,
            maxWidth: "none",
            position: "absolute",
            top: imageTop,
            transform: `scale(${imageScale})`,
            transformOrigin: "top left",
            width: imageWidth,
          }}
        />
        {children}
      </div>
    </div>
  );
}

export function FocusRing({
  x,
  y,
  width,
  height,
  opacity = 1,
  scale = 1,
  color = PALETTE.copper,
  radius = 10,
  label,
  labelPosition = "top",
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity?: number;
  scale?: number;
  color?: string;
  radius?: number;
  label?: string;
  labelPosition?: "top" | "bottom";
}) {
  return (
    <div
      style={{
        border: `2px solid ${color}`,
        borderRadius: radius,
        boxShadow: `0 0 0 5px ${color}18, 0 0 30px ${color}38`,
        height,
        left: x,
        opacity,
        position: "absolute",
        top: y,
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width,
      }}
    >
      {label ? (
        <div
          style={{
            backgroundColor: color,
            borderRadius: 5,
            color: PALETTE.paper,
            fontFamily: sans,
            fontSize: 11,
            fontWeight: 760,
            left: 10,
            letterSpacing: "0.12em",
            padding: "6px 9px",
            position: "absolute",
            textTransform: "uppercase",
            top: labelPosition === "top" ? -32 : height + 10,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

export function Callout({
  x,
  y,
  width = 300,
  eyebrow,
  title,
  body,
  color = PALETTE.copper,
  opacity = 1,
  transform,
  dark = true,
}: {
  x: number;
  y: number;
  width?: number;
  eyebrow: string;
  title: string;
  body: string;
  color?: string;
  opacity?: number;
  transform?: string;
  dark?: boolean;
}) {
  const fg = dark ? PALETTE.paper : PALETTE.ink;
  const copy = dark ? "rgba(255,253,248,.70)" : PALETTE.muted;
  const eyebrowColor =
    !dark && color === PALETTE.copper ? PALETTE.copperDeep : color;
  return (
    <div
      style={{
        background: dark
          ? "linear-gradient(145deg, rgba(29,47,43,.96), rgba(16,29,27,.92))"
          : "rgba(255,255,255,.88)",
        border: `1px solid ${dark ? "rgba(255,255,255,.14)" : "rgba(24,37,34,.12)"}`,
        borderRadius: 14,
        boxShadow: dark
          ? "0 18px 38px rgba(0,0,0,.25)"
          : "0 14px 30px rgba(24,37,34,.10)",
        color: fg,
        left: x,
        opacity,
        padding: "17px 19px 18px",
        position: "absolute",
        top: y,
        transform,
        width,
        zIndex: 5,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 8,
          marginBottom: 9,
        }}
      >
        <span
          style={{
            backgroundColor: color,
            borderRadius: "50%",
            boxShadow: `0 0 0 4px ${color}22`,
            height: 7,
            width: 7,
          }}
        />
        <span
          style={{
            color: eyebrowColor,
            fontFamily: sans,
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </span>
      </div>
      <div
        style={{
          fontFamily: sans,
          fontSize: 21,
          fontWeight: 740,
          letterSpacing: "-0.03em",
          lineHeight: 1.12,
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: copy,
          fontFamily: sans,
          fontSize: 14,
          lineHeight: 1.42,
          marginTop: 8,
        }}
      >
        {body}
      </div>
    </div>
  );
}

export function PhaseRail({
  phases,
  active,
  light = false,
  opacity = 1,
}: {
  phases: string[];
  active: number;
  light?: boolean;
  opacity?: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 12,
        opacity,
        position: "absolute",
        right: 74,
        top: 52,
        zIndex: 10,
      }}
    >
      {phases.map((phase, index) => {
        const selected = index === active;
        return (
          <div
            key={phase}
            style={{ alignItems: "center", display: "flex", gap: 7 }}
          >
            <span
              style={{
                backgroundColor: selected
                  ? light
                    ? PALETTE.copper
                    : PALETTE.copperSoft
                  : light
                    ? "#b7c1bb"
                    : "rgba(255,253,248,.28)",
                borderRadius: "50%",
                boxShadow: selected
                  ? `0 0 0 4px ${light ? PALETTE.copper : PALETTE.copperSoft}25`
                  : undefined,
                height: selected ? 8 : 5,
                width: selected ? 8 : 5,
              }}
            />
            <span
              style={{
                color: selected
                  ? light
                    ? PALETTE.ink
                    : PALETTE.paper
                  : light
                    ? PALETTE.muted
                    : "rgba(255,253,248,.45)",
                fontFamily: sans,
                fontSize: 10,
                fontWeight: selected ? 800 : 650,
                letterSpacing: "0.11em",
                textTransform: "uppercase",
              }}
            >
              {phase}
            </span>
            {index < phases.length - 1 ? (
              <span
                style={{
                  backgroundColor: light ? "#d4d9d3" : "rgba(255,253,248,.18)",
                  height: 1,
                  marginLeft: 3,
                  width: 22,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function SegmentLabel({
  number,
  title,
  light = false,
  opacity = 1,
  x = 80,
  y = 54,
}: {
  number: string;
  title: string;
  light?: boolean;
  opacity?: number;
  x?: number;
  y?: number;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        color: light ? PALETTE.muted : "rgba(255,253,248,.58)",
        display: "flex",
        fontFamily: sans,
        fontSize: 12,
        fontWeight: 720,
        gap: 12,
        left: x,
        letterSpacing: "0.12em",
        opacity,
        position: "absolute",
        textTransform: "uppercase",
        top: y,
        zIndex: 10,
      }}
    >
      <ProgramCueMark
        accent={PALETTE.copper}
        ink={light ? PALETTE.ink : PALETTE.paper}
        size={28}
      />
      <span
        style={{
          color: light ? PALETTE.ink : PALETTE.paper,
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}
      >
        Program Cue
      </span>
      <span
        style={{
          backgroundColor: light ? "#cbd2cb" : "rgba(255,253,248,.2)",
          height: 18,
          width: 1,
        }}
      />
      <span
        style={{
          color: light ? PALETTE.copperDeep : PALETTE.copperSoft,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {number}
      </span>
      <span
        style={{
          backgroundColor: light ? "#cbd2cb" : "rgba(255,253,248,.2)",
          height: 1,
          width: 38,
        }}
      />
      <span>{title}</span>
    </div>
  );
}
