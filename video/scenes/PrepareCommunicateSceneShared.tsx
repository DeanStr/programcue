import type { CSSProperties, ReactNode } from "react";

import { Img, interpolate } from "remotion";

import { ProgramCueMark } from "../components/ProgramCueBrand";

import { PALETTE } from "../constants";

export type SceneProps = {
  duration: number;
};

export const WHITE_92 = "rgba(255, 253, 248, 0.92)";

export const WHITE_72 = "rgba(255, 253, 248, 0.72)";

export const WHITE_56 = "rgba(255, 253, 248, 0.56)";

export const BORDER_GLASS = "rgba(255, 253, 248, 0.16)";

export const PAPER_BORDER = "rgba(24, 37, 34, 0.12)";

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const smooth = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export const at = (frame: number, duration: number) =>
  clamp01(frame / Math.max(duration, 1));

export const between = (
  frame: number,
  duration: number,
  start: number,
  end: number,
) => smooth((at(frame, duration) - start) / Math.max(end - start, 0.001));

// Dense product surfaces need temporal separation. The outgoing state clears
// before the incoming state begins, leaving a short visual breath for the
// continuity pulse below instead of an illegible whole-screen dissolve.
export const cleanShotExit = (
  frame: number,
  duration: number,
  center: number,
) => 1 - between(frame, duration, center - 0.009, center - 0.003);

export const cleanShotEnter = (
  frame: number,
  duration: number,
  center: number,
) => between(frame, duration, center + 0.003, center + 0.009);

export const visible = (opacity: number, y = 0, x = 0): CSSProperties => ({
  opacity,
  transform: `translate3d(${x}px, ${y}px, 0)`,
});

export const mono: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  letterSpacing: "0.12em",
};

export const label: CSSProperties = {
  ...mono,
  color: PALETTE.copperSoft,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.2,
  textTransform: "uppercase",
};

export const sceneBackground: CSSProperties = {
  backgroundColor: PALETTE.inkDeep,
  backgroundImage:
    "radial-gradient(circle at 78% 8%, rgba(190, 98, 66, 0.22), transparent 28%), radial-gradient(circle at 9% 82%, rgba(143, 191, 154, 0.14), transparent 31%), linear-gradient(135deg, #0b1413 0%, #102321 48%, #0b1413 100%)",
  color: PALETTE.paper,
  overflow: "hidden",
};

export const screenShadow =
  "0 32px 70px rgba(3, 10, 9, 0.38), 0 5px 16px rgba(3, 10, 9, 0.28)";

export function Grain() {
  return (
    <div
      aria-hidden
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.88' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.42'/%3E%3C/svg%3E\")",
        inset: 0,
        mixBlendMode: "soft-light",
        opacity: 0.09,
        pointerEvents: "none",
        position: "absolute",
      }}
    />
  );
}

export function StateHandoff({
  fromLabel,
  progress,
  toLabel,
  top,
}: {
  fromLabel: string;
  progress: number;
  toLabel: string;
  top: number;
}) {
  const pulse = Math.sin(clamp01(progress) * Math.PI);
  const washPosition = interpolate(clamp01(progress), [0, 1], [-28, 108]);
  const transfer = smooth(clamp01(progress));

  return (
    <div
      aria-hidden
      style={{
        background:
          "linear-gradient(90deg, rgba(244,244,239,0.66), rgba(255,253,248,0.88) 48%, rgba(244,244,239,0.66))",
        bottom: 40,
        left: 30,
        opacity: pulse,
        overflow: "hidden",
        pointerEvents: "none",
        position: "absolute",
        right: 30,
        top,
        zIndex: 2,
      }}
    >
      <div
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(246,197,169,0.16), rgba(143,191,154,0.13), transparent)",
          bottom: 0,
          left: `${washPosition}%`,
          position: "absolute",
          top: 0,
          transform: "skewX(-9deg)",
          width: 330,
        }}
      />
      <div
        style={{
          alignItems: "center",
          display: "flex",
          left: "50%",
          position: "absolute",
          top: "50%",
          transform: "translate3d(-50%, -50%, 0)",
          width: 720,
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: "rgba(255,253,248,0.94)",
            border: "1px solid rgba(58,95,66,0.24)",
            borderRadius: 17,
            boxShadow: "0 16px 38px rgba(19,32,31,0.09)",
            display: "flex",
            gap: 13,
            minHeight: 82,
            opacity: interpolate(transfer, [0, 0.62, 1], [1, 0.96, 0.72]),
            padding: "15px 18px",
            transform: `translate3d(${interpolate(transfer, [0, 1], [0, -8])}px, 0, 0) scale(${interpolate(transfer, [0, 1], [1, 0.975])})`,
            width: 224,
          }}
        >
          <span
            style={{
              alignItems: "center",
              backgroundColor: "rgba(143,191,154,0.2)",
              border: "1px solid rgba(58,95,66,0.22)",
              borderRadius: "50%",
              color: PALETTE.sageDeep,
              display: "flex",
              fontSize: 14,
              fontWeight: 900,
              height: 32,
              justifyContent: "center",
              width: 32,
            }}
          >
            ✓
          </span>
          <div>
            <div style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
              Previous step
            </div>
            <div
              style={{
                color: PALETTE.ink,
                fontSize: 21,
                fontWeight: 820,
                letterSpacing: "-0.035em",
                marginTop: 5,
              }}
            >
              {fromLabel}
            </div>
          </div>
        </div>
        <div
          style={{
            backgroundColor: "rgba(24,37,34,0.14)",
            flex: 1,
            height: 1,
            margin: "0 22px",
            position: "relative",
          }}
        >
          <div
            style={{
              background:
                "linear-gradient(90deg, rgba(143,191,154,0.72), rgba(190,98,66,0.76))",
              height: 2,
              left: 0,
              position: "absolute",
              top: -1,
              width: `${transfer * 100}%`,
            }}
          />
          <div
            style={{
              backgroundColor: PALETTE.copper,
              border: "5px solid rgba(190,98,66,0.14)",
              borderRadius: "50%",
              boxSizing: "content-box",
              height: 9,
              left: `${transfer * 100}%`,
              position: "absolute",
              top: 0,
              transform: "translate3d(-50%, -50%, 0)",
              width: 9,
            }}
          />
        </div>
        <div
          style={{
            alignItems: "center",
            backgroundColor: "rgba(255,248,242,0.96)",
            border: "1px solid rgba(190,98,66,0.25)",
            borderRadius: 17,
            boxShadow: "0 16px 38px rgba(19,32,31,0.09)",
            display: "flex",
            gap: 13,
            minHeight: 82,
            opacity: interpolate(transfer, [0, 0.38, 1], [0.66, 0.94, 1]),
            padding: "15px 18px",
            transform: `translate3d(${interpolate(transfer, [0, 1], [8, 0])}px, 0, 0) scale(${interpolate(transfer, [0, 1], [0.975, 1])})`,
            width: 224,
          }}
        >
          <span
            style={{
              alignItems: "center",
              backgroundColor: "rgba(190,98,66,0.14)",
              border: "1px solid rgba(190,98,66,0.24)",
              borderRadius: "50%",
              color: PALETTE.copperDeep,
              display: "flex",
              fontSize: 15,
              fontWeight: 900,
              height: 32,
              justifyContent: "center",
              width: 32,
            }}
          >
            →
          </span>
          <div>
            <div style={{ ...label, color: PALETTE.copperDeep, fontSize: 9 }}>
              Next state
            </div>
            <div
              style={{
                color: PALETTE.ink,
                fontSize: 21,
                fontWeight: 820,
                letterSpacing: "-0.035em",
                marginTop: 5,
              }}
            >
              {toLabel}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function TopBar({
  chapter,
  chapterNumber,
  roleLabel,
}: {
  chapter: string;
  chapterNumber: string;
  roleLabel: string;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "space-between",
        left: 74,
        position: "absolute",
        right: 74,
        top: 42,
        zIndex: 5,
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
        <ProgramCueMark size={42} />
        <div>
          <div
            style={{
              color: WHITE_92,
              fontSize: 17,
              fontWeight: 750,
              letterSpacing: "-0.02em",
            }}
          >
            Program Cue
          </div>
          <div style={{ color: WHITE_56, fontSize: 11, marginTop: 3 }}>
            programme operations
          </div>
        </div>
      </div>
      <div style={{ alignItems: "center", display: "flex", gap: 30 }}>
        <div style={{ ...label, color: WHITE_56 }}>{roleLabel}</div>
        <div style={{ alignItems: "center", display: "flex", gap: 12 }}>
          <div
            style={{ backgroundColor: BORDER_GLASS, height: 1, width: 112 }}
          />
          <span style={{ ...mono, color: WHITE_72, fontSize: 13 }}>
            {chapterNumber}
          </span>
          <span style={{ color: WHITE_56, fontSize: 13 }}>{chapter}</span>
        </div>
      </div>
    </div>
  );
}

export function Eyebrow({
  children,
  light = false,
}: {
  children: ReactNode;
  light?: boolean;
}) {
  return (
    <div
      style={{ ...label, color: light ? PALETTE.muted : PALETTE.copperSoft }}
    >
      {children}
    </div>
  );
}

export function BrowserFrame({
  src,
  width,
  height,
  label: frameLabel,
  objectPosition = "center",
  imageScale = 1,
  imageOrigin = "center center",
  style,
}: {
  src: string;
  width: number;
  height: number;
  label?: string;
  objectPosition?: string;
  imageScale?: number;
  imageOrigin?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        backgroundColor: PALETTE.paper,
        border: "1px solid rgba(255, 253, 248, 0.24)",
        borderRadius: 18,
        boxShadow: screenShadow,
        height,
        overflow: "hidden",
        width,
        ...style,
      }}
    >
      <div
        style={{
          alignItems: "center",
          backgroundColor: "#f0eee8",
          borderBottom: "1px solid rgba(24, 37, 34, 0.10)",
          display: "flex",
          height: 35,
          justifyContent: "space-between",
          padding: "0 14px",
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          {[PALETTE.copper, "#d4a72c", PALETTE.sage].map((color) => (
            <span
              key={color}
              style={{
                backgroundColor: color,
                borderRadius: "50%",
                height: 6,
                width: 6,
              }}
            />
          ))}
        </div>
        <div
          style={{
            color: "#61716c",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {frameLabel ?? "app.programcue.com"}
        </div>
        <div style={{ width: 27 }} />
      </div>
      <Img
        src={src}
        style={{
          display: "block",
          height: height - 35,
          objectFit: "cover",
          objectPosition,
          transform: `scale(${imageScale})`,
          transformOrigin: imageOrigin,
          width: "100%",
        }}
      />
    </div>
  );
}

export function StageHeader({
  eyebrow,
  title,
  detail,
  status,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  status: string;
}) {
  return (
    <div
      style={{
        alignItems: "flex-start",
        display: "flex",
        justifyContent: "space-between",
        left: 30,
        position: "absolute",
        right: 30,
        top: 25,
        zIndex: 2,
      }}
    >
      <div>
        <div style={{ ...label, color: PALETTE.muted }}>{eyebrow}</div>
        <div
          style={{
            color: PALETTE.ink,
            fontSize: 22,
            fontWeight: 780,
            letterSpacing: "-0.035em",
            marginTop: 8,
          }}
        >
          {title}
        </div>
        <div style={{ color: PALETTE.muted, fontSize: 12, marginTop: 5 }}>
          {detail}
        </div>
      </div>
      <div
        style={{
          alignItems: "center",
          backgroundColor: "#eef5ee",
          border: "1px solid rgba(58, 95, 66, 0.18)",
          borderRadius: 999,
          color: PALETTE.sageDeep,
          display: "flex",
          fontSize: 11,
          fontWeight: 750,
          gap: 8,
          padding: "9px 13px",
        }}
      >
        <span
          style={{
            backgroundColor: PALETTE.sageDeep,
            borderRadius: "50%",
            height: 7,
            width: 7,
          }}
        />
        {status}
      </div>
    </div>
  );
}

export function MiniPill({
  children,
  tone = "light",
  active = false,
}: {
  children: ReactNode;
  tone?: "light" | "sage" | "copper" | "dark";
  active?: boolean;
}) {
  const styles: Record<"light" | "sage" | "copper" | "dark", CSSProperties> = {
    light: {
      backgroundColor: "#f5f3ed",
      border: PAPER_BORDER,
      color: PALETTE.ink,
    },
    sage: {
      backgroundColor: "#edf5ee",
      border: "rgba(58, 95, 66, 0.18)",
      color: PALETTE.sageDeep,
    },
    copper: {
      backgroundColor: "#fff1e9",
      border: "rgba(190, 98, 66, 0.22)",
      color: PALETTE.copperDeep,
    },
    dark: {
      backgroundColor: "rgba(19, 32, 31, 0.86)",
      border: BORDER_GLASS,
      color: WHITE_92,
    },
  };
  const toneStyle = styles[tone];
  return (
    <div
      style={{
        alignItems: "center",
        borderRadius: 999,
        borderStyle: "solid",
        borderWidth: 1,
        display: "flex",
        fontSize: 11,
        fontWeight: 700,
        gap: 7,
        opacity: active ? 1 : 0.78,
        padding: "8px 11px",
        ...toneStyle,
      }}
    >
      {active ? (
        <span
          style={{
            backgroundColor: "currentColor",
            borderRadius: "50%",
            height: 6,
            width: 6,
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
