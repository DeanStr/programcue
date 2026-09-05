import {
  ArrowRight,
  BadgeCheck,
  Check,
  Circle,
  Globe2,
  LockKeyhole,
  type LucideIcon,
  Menu,
  MoreHorizontal,
  MousePointer2,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import React, { type CSSProperties, type ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { PALETTE, VIDEO } from "../constants";

/** A coordinate in the 1920 × 1080 film coordinate space. */
export interface Point {
  x: number;
  y: number;
}

type Tone = "light" | "dark" | "copper" | "sage" | "gold" | "muted";

const CLAMP = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const ENTER_EASE = Easing.bezier(0.22, 0.61, 0.36, 1);
const OUT_EASE = Easing.bezier(0.16, 1, 0.3, 1);
const PROGRAM_CUE_SANS =
  '"Program Cue Inter", Inter, ui-sans-serif, system-ui, sans-serif';

const toneMap: Record<
  Tone,
  { foreground: string; background: string; line: string }
> = {
  light: {
    foreground: PALETTE.paper,
    background: "rgba(255, 253, 248, 0.1)",
    line: "rgba(255, 253, 248, 0.25)",
  },
  dark: {
    foreground: PALETTE.ink,
    background: "rgba(24, 37, 34, 0.08)",
    line: "rgba(24, 37, 34, 0.17)",
  },
  copper: {
    foreground: PALETTE.copper,
    background: "rgba(190, 98, 66, 0.12)",
    line: "rgba(190, 98, 66, 0.28)",
  },
  sage: {
    foreground: PALETTE.sage,
    background: "rgba(143, 191, 154, 0.13)",
    line: "rgba(143, 191, 154, 0.3)",
  },
  gold: {
    foreground: PALETTE.gold,
    background: "rgba(212, 167, 44, 0.13)",
    line: "rgba(212, 167, 44, 0.3)",
  },
  muted: {
    foreground: PALETTE.muted,
    background: "rgba(97, 113, 108, 0.1)",
    line: "rgba(97, 113, 108, 0.22)",
  },
};

function fadeIn(frame: number, delay = 0, duration = 24) {
  return interpolate(frame, [delay, delay + Math.max(1, duration)], [0, 1], {
    easing: ENTER_EASE,
    ...CLAMP,
  });
}

function springIn(frame: number, fps: number, delay = 0, mass = 0.72) {
  return spring({
    frame: Math.max(0, frame - delay),
    fps,
    config: { damping: 200, stiffness: 120, mass },
  });
}

function slideFor(progress: number, distance = 24) {
  return (1 - progress) * distance;
}

function resolveTone(tone: Tone, darkSurface = false) {
  if (tone === "light" && darkSurface) {
    return toneMap.light;
  }
  return toneMap[tone];
}

function CornerMark({ color = PALETTE.copper }: { color?: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 7,
        height: 7,
        borderRadius: 2,
        background: color,
        boxShadow: `0 0 0 3px ${color}22`,
        flex: "0 0 auto",
      }}
    />
  );
}

export interface SubtleGridProps {
  /** Opacity of the grid overlay, intentionally low for legibility. */
  opacity?: number;
  size?: number;
  color?: string;
  style?: CSSProperties;
}

/** A restrained grid used as a spatial cue on the dark film background. */
export function SubtleGrid({
  opacity = 0.28,
  size = 120,
  color = PALETTE.paper,
  style,
}: SubtleGridProps) {
  return (
    <AbsoluteFill
      style={{
        zIndex: 1,
        opacity,
        pointerEvents: "none",
        backgroundImage: `linear-gradient(${color} 1px, transparent 1px), linear-gradient(90deg, ${color} 1px, transparent 1px)`,
        backgroundSize: `${size}px ${size}px`,
        maskImage:
          "radial-gradient(ellipse at 50% 44%, black 0%, rgba(0,0,0,.75) 48%, transparent 84%)",
        WebkitMaskImage:
          "radial-gradient(ellipse at 50% 44%, black 0%, rgba(0,0,0,.75) 48%, transparent 84%)",
        ...style,
      }}
    />
  );
}

export const Grid = SubtleGrid;

export interface SubtleGrainProps {
  opacity?: number;
  /** SVG turbulence seed. Keeping it explicit makes renders reproducible. */
  seed?: number;
  id?: string;
  style?: CSSProperties;
}

/** A deterministic film grain layer; no per-render random values are used. */
export function SubtleGrain({
  opacity = 0.065,
  seed = 17,
  id = "program-cue-film-grain",
  style,
}: SubtleGrainProps) {
  return (
    <AbsoluteFill
      style={{
        zIndex: 20,
        opacity,
        mixBlendMode: "soft-light",
        pointerEvents: "none",
        ...style,
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        style={{ display: "block" }}
      >
        <filter id={id} x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.82"
            numOctaves="2"
            seed={seed}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect
          width="100%"
          height="100%"
          filter={`url(#${id})`}
          opacity="0.78"
        />
      </svg>
    </AbsoluteFill>
  );
}

export const Grain = SubtleGrain;

export interface BrowserFrameProps {
  src?: string;
  image?: string;
  screenshot?: string;
  children?: ReactNode;
  title?: string;
  url?: string;
  width?: number | string;
  height?: number | string;
  radius?: number;
  delay?: number;
  motion?: "reveal" | "static";
  fit?: "cover" | "contain";
  darkChrome?: boolean;
  style?: CSSProperties;
  contentStyle?: CSSProperties;
}

/** Premium browser/product frame for app screenshots and live scene content. */
export function BrowserFrame({
  src,
  image,
  screenshot,
  children,
  title = "Program Cue",
  url = "app.programcue.com",
  width = 1320,
  height = 760,
  radius = 24,
  delay = 0,
  motion = "reveal",
  fit = "cover",
  darkChrome = true,
  style,
  contentStyle,
}: BrowserFrameProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = motion === "static" ? 1 : springIn(frame, fps, delay, 0.82);
  const imageSrc = src ?? screenshot ?? image;
  const chromeBackground = darkChrome ? PALETTE.nav : PALETTE.paper;
  const chromeText = darkChrome ? "rgba(255,253,248,.64)" : PALETTE.muted;
  const chromeLine = darkChrome ? "rgba(255,253,248,.11)" : PALETTE.line;

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        boxSizing: "border-box",
        overflow: "hidden",
        borderRadius: radius,
        background: PALETTE.paper,
        border: `1px solid ${darkChrome ? "rgba(255,253,248,.16)" : PALETTE.line}`,
        boxShadow:
          "0 42px 100px rgba(0,0,0,.34), 0 9px 28px rgba(0,0,0,.17), inset 0 1px 0 rgba(255,255,255,.18)",
        opacity: entrance,
        transform: `translate3d(0, ${slideFor(entrance, 28)}px, 0) scale(${0.985 + entrance * 0.015})`,
        transformOrigin: "50% 70%",
        ...style,
      }}
    >
      <div
        style={{
          position: "relative",
          zIndex: 2,
          height: 58,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 18px",
          background: chromeBackground,
          borderBottom: `1px solid ${chromeLine}`,
          color: chromeText,
          fontFamily: PROGRAM_CUE_SANS,
          fontSize: 13,
          letterSpacing: "-0.01em",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flex: "0 0 auto",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#f27a60",
            }}
          />
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#f3c761",
            }}
          />
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "#77ba85",
            }}
          />
        </div>
        <div
          style={{
            minWidth: 0,
            height: 34,
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 14px",
            borderRadius: 9,
            background: darkChrome ? "rgba(255,253,248,.075)" : PALETTE.canvas,
            color: chromeText,
          }}
        >
          <LockKeyhole size={13} strokeWidth={2.1} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {url}
          </span>
          <Globe2
            size={13}
            strokeWidth={1.8}
            style={{ marginLeft: "auto", opacity: 0.48 }}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flex: "0 0 auto",
            opacity: 0.72,
          }}
        >
          <MoreHorizontal size={17} strokeWidth={1.8} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: 58,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: "hidden",
          background: PALETTE.canvas,
          ...contentStyle,
        }}
      >
        {imageSrc ? (
          <Img
            src={imageSrc}
            alt=""
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: fit,
              objectPosition: "center top",
            }}
          />
        ) : (
          children
        )}
      </div>
      <div
        style={{
          position: "absolute",
          zIndex: 3,
          left: 0,
          right: 0,
          top: 0,
          height: 1,
          background:
            "linear-gradient(90deg, transparent, rgba(255,255,255,.46), transparent)",
          opacity: entrance * 0.65,
          transform: `translateX(${(1 - entrance) * -100}%)`,
        }}
      />
      {!imageSrc && !children ? (
        <div
          style={{
            position: "absolute",
            inset: "58px 0 0",
            display: "grid",
            placeItems: "center",
            color: PALETTE.muted,
            fontFamily: PROGRAM_CUE_SANS,
            fontSize: 16,
          }}
        >
          {title}
        </div>
      ) : null}
    </div>
  );
}

export const ProductFrame = BrowserFrame;
export const BrowserWindow = BrowserFrame;
export const BrowserProductFrame = BrowserFrame;

export interface PhoneFrameProps {
  src?: string;
  image?: string;
  screenshot?: string;
  children?: ReactNode;
  width?: number;
  height?: number;
  radius?: number;
  delay?: number;
  motion?: "reveal" | "static";
  fit?: "cover" | "contain";
  style?: CSSProperties;
  contentStyle?: CSSProperties;
}

/** A device frame with restrained hardware details for participant-facing flows. */
export function PhoneFrame({
  src,
  image,
  screenshot,
  children,
  width = 328,
  height = 664,
  radius = 44,
  delay = 0,
  motion = "reveal",
  fit = "cover",
  style,
  contentStyle,
}: PhoneFrameProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = motion === "static" ? 1 : springIn(frame, fps, delay, 0.7);
  const imageSrc = src ?? screenshot ?? image;

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        padding: 8,
        boxSizing: "border-box",
        borderRadius: radius,
        background: "linear-gradient(145deg, #334541, #08100f 56%, #1d2b29)",
        border: "1px solid rgba(255,253,248,.23)",
        boxShadow:
          "0 46px 90px rgba(0,0,0,.38), 0 10px 28px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.18)",
        opacity: entrance,
        transform: `translate3d(0, ${slideFor(entrance, 34)}px, 0) rotate(${(1 - entrance) * 1.5}deg)`,
        transformOrigin: "50% 85%",
        ...style,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
          borderRadius: Math.max(12, radius - 8),
          background: PALETTE.paper,
          ...contentStyle,
        }}
      >
        <div
          style={{
            position: "absolute",
            zIndex: 3,
            top: 11,
            left: "50%",
            width: 92,
            height: 23,
            transform: "translateX(-50%)",
            borderRadius: 99,
            background: "#07100f",
            boxShadow: "inset 0 1px 1px rgba(255,255,255,.12)",
          }}
        >
          <span
            style={{
              position: "absolute",
              right: 17,
              top: 8,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "#2b4a43",
            }}
          />
        </div>
        {imageSrc ? (
          <Img
            src={imageSrc}
            alt=""
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: fit,
              objectPosition: "center top",
            }}
          />
        ) : (
          children
        )}
        <div
          style={{
            position: "absolute",
            zIndex: 4,
            bottom: 9,
            left: "50%",
            width: 105,
            height: 4,
            transform: "translateX(-50%)",
            borderRadius: 4,
            background: "rgba(11,20,19,.58)",
          }}
        />
      </div>
    </div>
  );
}

export const DeviceFrame = PhoneFrame;

export interface ScreenshotPan {
  from?: Point;
  to?: Point;
  fromScale?: number;
  toScale?: number;
}

export interface AnimatedScreenshotProps {
  src?: string;
  children?: ReactNode;
  width?: number | string;
  height?: number | string;
  pan?: ScreenshotPan;
  fit?: "cover" | "contain";
  delay?: number;
  duration?: number;
  motion?: "reveal" | "static";
  radius?: number;
  style?: CSSProperties;
  viewportStyle?: CSSProperties;
}

/** Cropped screenshot viewport with a slow, editorial pan and soft reveal. */
export function AnimatedScreenshot({
  src,
  children,
  width = "100%",
  height = "100%",
  pan = {},
  fit = "cover",
  delay = 0,
  duration = 90,
  motion = "reveal",
  radius = 0,
  style,
  viewportStyle,
}: AnimatedScreenshotProps) {
  const frame = useCurrentFrame();
  const progress = motion === "static" ? 1 : fadeIn(frame, delay, duration);
  const from = pan.from ?? { x: 0, y: 0 };
  const to = pan.to ?? { x: 0, y: 0 };
  const x = interpolate(progress, [0, 1], [from.x, to.x], CLAMP);
  const y = interpolate(progress, [0, 1], [from.y, to.y], CLAMP);
  const fromScale = pan.fromScale ?? 1.04;
  const toScale = pan.toScale ?? fromScale;
  const scale = interpolate(progress, [0, 1], [fromScale, toScale], CLAMP);

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        overflow: "hidden",
        borderRadius: radius,
        opacity: progress,
        background: PALETTE.canvas,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          ...viewportStyle,
        }}
      >
        {src ? (
          <Img
            src={src}
            alt=""
            style={{
              display: "block",
              position: "absolute",
              inset: "-4%",
              width: "108%",
              height: "108%",
              objectFit: fit,
              objectPosition: "center center",
              transform: `translate3d(${x}%, ${y}%, 0) scale(${scale})`,
              transformOrigin: "center center",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `translate3d(${x}%, ${y}%, 0) scale(${scale})`,
            }}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export const Screenshot = AnimatedScreenshot;

export interface ChapterLabelProps {
  label: string;
  index?: string | number;
  tone?: Tone;
  accent?: string;
  delay?: number;
  lineWidth?: number;
  style?: CSSProperties;
}

/** Small editorial chapter marker used to establish place before a flow. */
export function ChapterLabel({
  label,
  index,
  tone = "light",
  accent = PALETTE.copper,
  delay = 0,
  lineWidth = 34,
  style,
}: ChapterLabelProps) {
  const frame = useCurrentFrame();
  const progress = fadeIn(frame, delay, 18);
  const colors = resolveTone(tone);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        color: colors.foreground,
        opacity: progress,
        transform: `translate3d(0, ${slideFor(progress, 10)}px, 0)`,
        fontFamily: PROGRAM_CUE_SANS,
        fontSize: 13,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        ...style,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: lineWidth,
          height: 1,
          background: accent,
          opacity: 0.9,
        }}
      />
      {index !== undefined ? (
        <span style={{ color: accent, fontVariantNumeric: "tabular-nums" }}>
          {String(index).padStart(2, "0")}
        </span>
      ) : null}
      <span style={{ opacity: 0.78 }}>{label}</span>
    </div>
  );
}

export const SectionLabel = ChapterLabel;

export interface KineticTitleProps {
  text?: string;
  children?: ReactNode;
  eyebrow?: string;
  subline?: ReactNode;
  tone?: Tone;
  accent?: string;
  accentWord?: string;
  size?: number;
  lineHeight?: number;
  maxWidth?: number | string;
  delay?: number;
  stagger?: number;
  align?: "left" | "center" | "right";
  style?: CSSProperties;
}

/** Word-by-word title reveal with a gentle spring, tuned for premium launch-film pacing. */
export function KineticTitle({
  text,
  children,
  eyebrow,
  subline,
  tone = "light",
  accent = PALETTE.copperSoft,
  accentWord,
  size = 104,
  lineHeight = 0.96,
  maxWidth = 1100,
  delay = 0,
  stagger = 4,
  align = "left",
  style,
}: KineticTitleProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const copy = text ?? (typeof children === "string" ? children : "");
  const words = copy.trim().split(/\s+/).filter(Boolean);
  const wordKeys = new Map<string, number>();
  const colors = resolveTone(tone);
  const sublineProgress = fadeIn(
    frame,
    delay + Math.max(1, words.length) * stagger + 12,
    24,
  );

  return (
    <div
      style={{
        width: "100%",
        maxWidth,
        textAlign: align,
        color: colors.foreground,
        ...style,
      }}
    >
      {eyebrow ? (
        <div
          style={{
            marginBottom: 24,
            color: accent,
            opacity: fadeIn(frame, delay, 18),
            fontFamily: PROGRAM_CUE_SANS,
            fontSize: 14,
            fontWeight: 750,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </div>
      ) : null}
      {words.length > 0 ? (
        <h1
          style={{
            margin: 0,
            fontFamily: PROGRAM_CUE_SANS,
            fontSize: size,
            fontWeight: 700,
            lineHeight,
            letterSpacing: "-0.065em",
            textWrap: "balance",
          }}
        >
          {words.map((word, index) => {
            const progress = springIn(
              frame,
              fps,
              delay + index * stagger,
              0.54,
            );
            const isAccent =
              accentWord !== undefined &&
              word.toLowerCase() === accentWord.toLowerCase();
            const occurrence = wordKeys.get(word) ?? 0;
            wordKeys.set(word, occurrence + 1);
            return (
              <React.Fragment key={`${word}-${occurrence}`}>
                <span
                  style={{
                    display: "inline-block",
                    color: isAccent ? accent : colors.foreground,
                    opacity: progress,
                    transform: `translate3d(0, ${slideFor(progress, 42)}px, 0) scale(${0.96 + progress * 0.04})`,
                    transformOrigin: "50% 90%",
                    willChange: "transform, opacity",
                  }}
                >
                  {word}
                </span>
                {index < words.length - 1 ? " " : null}
              </React.Fragment>
            );
          })}
        </h1>
      ) : (
        <div style={{ fontSize: size, fontWeight: 700 }}>{children}</div>
      )}
      {subline ? (
        <div
          style={{
            maxWidth: 700,
            marginTop: 30,
            marginLeft: align === "center" ? "auto" : 0,
            marginRight: align === "center" ? "auto" : 0,
            color: tone === "dark" ? PALETTE.muted : "rgba(255,253,248,.68)",
            opacity: sublineProgress,
            transform: `translate3d(0, ${slideFor(sublineProgress, 15)}px, 0)`,
            fontFamily: PROGRAM_CUE_SANS,
            fontSize: 23,
            fontWeight: 450,
            lineHeight: 1.4,
            letterSpacing: "-0.02em",
          }}
        >
          {subline}
        </div>
      ) : null}
    </div>
  );
}

export const Title = KineticTitle;
export const KineticText = KineticTitle;

export interface RoleChipProps {
  label?: string;
  role?: string;
  icon?: LucideIcon;
  tone?: Tone;
  delay?: number;
  compact?: boolean;
  style?: CSSProperties;
}

/** Compact audience marker for organiser, speaker, reviewer, and attendee flows. */
export function RoleChip({
  label,
  role,
  icon: Icon = UsersRound,
  tone = "light",
  delay = 0,
  compact = false,
  style,
}: RoleChipProps) {
  const frame = useCurrentFrame();
  const progress = fadeIn(frame, delay, 20);
  const colors = resolveTone(tone);
  const copy = label ?? role ?? "Participant";

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 7 : 9,
        minHeight: compact ? 28 : 34,
        padding: compact ? "0 10px" : "0 13px",
        border: `1px solid ${colors.line}`,
        borderRadius: 99,
        background: colors.background,
        color: colors.foreground,
        opacity: progress,
        transform: `translate3d(0, ${slideFor(progress, 9)}px, 0)`,
        fontFamily: PROGRAM_CUE_SANS,
        fontSize: compact ? 12 : 13,
        fontWeight: 650,
        letterSpacing: "-0.01em",
        ...style,
      }}
    >
      <Icon size={compact ? 13 : 15} strokeWidth={2} />
      <span>{copy}</span>
    </div>
  );
}

export const PersonaChip = RoleChip;

export interface CursorProps {
  from?: Point;
  to?: Point;
  x?: number;
  y?: number;
  label?: string;
  color?: string;
  delay?: number;
  duration?: number;
  clickAt?: number;
  scale?: number;
  style?: CSSProperties;
}

/** A branded pointer that travels on a deterministic path and gives a tactile click cue. */
export function Cursor({
  from,
  to,
  x = 960,
  y = 540,
  label,
  color = PALETTE.copper,
  delay = 0,
  duration = 38,
  clickAt,
  scale = 1,
  style,
}: CursorProps) {
  const frame = useCurrentFrame();
  const pathFrom = from ?? { x, y };
  const pathTo = to ?? pathFrom;
  const progress = fadeIn(frame, delay, duration);
  const cursorX = interpolate(progress, [0, 1], [pathFrom.x, pathTo.x], CLAMP);
  const cursorY = interpolate(progress, [0, 1], [pathFrom.y, pathTo.y], CLAMP);
  const clickFrame =
    clickAt === undefined
      ? Number.POSITIVE_INFINITY
      : clickAt <= 1
        ? delay + clickAt * duration
        : clickAt;
  const clickPulse = Number.isFinite(clickFrame)
    ? interpolate(
        frame,
        [clickFrame, clickFrame + 5, clickFrame + 13],
        [0, 1, 0],
        {
          easing: OUT_EASE,
          ...CLAMP,
        },
      )
    : 0;

  return (
    <div
      style={{
        position: "absolute",
        zIndex: 30,
        left: cursorX,
        top: cursorY,
        opacity: progress,
        transform: `translate3d(-2px, -2px, 0) scale(${scale})`,
        transformOrigin: "6px 6px",
        pointerEvents: "none",
        ...style,
      }}
    >
      {clickPulse > 0 ? (
        <span
          style={{
            position: "absolute",
            left: -13,
            top: -13,
            width: 35,
            height: 35,
            borderRadius: "50%",
            border: `1.5px solid ${color}`,
            opacity: clickPulse * 0.72,
            transform: `scale(${0.54 + clickPulse * 0.68})`,
          }}
        />
      ) : null}
      <MousePointer2
        size={29}
        strokeWidth={1.75}
        color={PALETTE.ink}
        fill={PALETTE.paper}
        style={{ filter: `drop-shadow(0 3px 5px rgba(0,0,0,.42))` }}
      />
      {label ? (
        <span
          style={{
            position: "absolute",
            left: 25,
            top: 25,
            display: "inline-flex",
            alignItems: "center",
            minHeight: 25,
            padding: "0 9px",
            borderRadius: 7,
            background: color,
            color: PALETTE.paper,
            whiteSpace: "nowrap",
            fontFamily: PROGRAM_CUE_SANS,
            fontSize: 11,
            fontWeight: 750,
            letterSpacing: "0.02em",
            boxShadow: "0 5px 14px rgba(0,0,0,.22)",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}

export const Pointer = Cursor;
export const CursorPath = Cursor;

export interface CalloutProps {
  title: string;
  body?: ReactNode;
  children?: ReactNode;
  x: number;
  y: number;
  target?: Point;
  side?: "left" | "right" | "top" | "bottom";
  width?: number;
  height?: number;
  tone?: Tone;
  accent?: string;
  delay?: number;
  style?: CSSProperties;
}

/** A polished annotation card with an optional measured leader line to a UI detail. */
export function Callout({
  title,
  body,
  children,
  x,
  y,
  target,
  side = "right",
  width = 286,
  height = 104,
  tone = "light",
  accent = PALETTE.copper,
  delay = 0,
  style,
}: CalloutProps) {
  const frame = useCurrentFrame();
  const progress = fadeIn(frame, delay, 22);
  const colors = resolveTone(tone);
  const lineStart =
    side === "left"
      ? { x, y: y + height / 2 }
      : side === "top"
        ? { x: x + width / 2, y }
        : side === "bottom"
          ? { x: x + width / 2, y: y + height }
          : { x: x + width, y: y + height / 2 };
  const lineLength = target
    ? Math.sqrt((target.x - lineStart.x) ** 2 + (target.y - lineStart.y) ** 2)
    : 0;
  const lineAngle = target
    ? (Math.atan2(target.y - lineStart.y, target.x - lineStart.x) * 180) /
      Math.PI
    : 0;
  const copy = body ?? children;

  return (
    <>
      {target ? (
        <>
          <span
            style={{
              position: "absolute",
              zIndex: 4,
              left: lineStart.x,
              top: lineStart.y,
              width: lineLength,
              height: 1,
              transformOrigin: "0 50%",
              transform: `rotate(${lineAngle}deg) scaleX(${progress})`,
              background: `linear-gradient(90deg, ${accent}, ${accent}44)`,
              opacity: progress * 0.88,
              pointerEvents: "none",
            }}
          />
          <span
            style={{
              position: "absolute",
              zIndex: 5,
              left: target.x - 4,
              top: target.y - 4,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: accent,
              opacity: progress,
              boxShadow: `0 0 0 5px ${accent}24`,
              pointerEvents: "none",
            }}
          />
        </>
      ) : null}
      <div
        style={{
          position: "absolute",
          zIndex: 6,
          left: x,
          top: y,
          width,
          minHeight: height,
          padding: "17px 18px 16px",
          border: `1px solid ${colors.line}`,
          borderRadius: 13,
          background:
            tone === "light" ? "rgba(19,32,31,.92)" : "rgba(255,253,248,.94)",
          color: colors.foreground,
          opacity: progress,
          transform: `translate3d(0, ${slideFor(progress, 14)}px, 0)`,
          boxShadow:
            "0 18px 38px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.1)",
          fontFamily: PROGRAM_CUE_SANS,
          ...style,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginBottom: copy ? 9 : 0,
          }}
        >
          <CornerMark color={accent} />
          <strong
            style={{ fontSize: 14, fontWeight: 720, letterSpacing: "-0.02em" }}
          >
            {title}
          </strong>
        </div>
        {copy ? (
          <div
            style={{
              color: tone === "light" ? "rgba(255,253,248,.66)" : PALETTE.muted,
              fontSize: 12,
              lineHeight: 1.42,
              letterSpacing: "-0.005em",
            }}
          >
            {copy}
          </div>
        ) : null}
      </div>
    </>
  );
}

export const FeatureCallout = Callout;
export const CalloutCard = Callout;

export type FlowChipItem =
  | string
  | {
      label: string;
      detail?: string;
      icon?: LucideIcon;
      tone?: Tone;
    };

export interface FlowChipsProps {
  items: FlowChipItem[];
  activeIndex?: number;
  completeThrough?: number;
  delay?: number;
  stagger?: number;
  tone?: Tone;
  compact?: boolean;
  style?: CSSProperties;
}

/** Connected flow steps that make a long product journey legible at a glance. */
export function FlowChips({
  items,
  activeIndex = -1,
  completeThrough = -1,
  delay = 0,
  stagger = 7,
  tone = "light",
  compact = false,
  style,
}: FlowChipsProps) {
  const frame = useCurrentFrame();
  const itemKeys = new Map<string, number>();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: compact ? 8 : 11,
        flexWrap: "nowrap",
        ...style,
      }}
    >
      {items.map((item, index) => {
        const config = typeof item === "string" ? { label: item } : item;
        const occurrence = itemKeys.get(config.label) ?? 0;
        itemKeys.set(config.label, occurrence + 1);
        const Icon = config.icon;
        const progress = fadeIn(frame, delay + index * stagger, 20);
        const itemTone = config.tone ?? tone;
        const colors = resolveTone(itemTone);
        const isActive = index === activeIndex;
        const isComplete = index <= completeThrough;
        const fill = isActive
          ? PALETTE.copper
          : isComplete
            ? PALETTE.sage
            : colors.background;
        const foreground =
          isActive || isComplete ? PALETTE.paper : colors.foreground;

        return (
          <React.Fragment key={`${config.label}-${occurrence}`}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: compact ? 7 : 9,
                minHeight: compact ? 32 : 40,
                padding: compact ? "0 11px" : "0 14px",
                border: `1px solid ${isActive ? PALETTE.copper : isComplete ? PALETTE.sage : colors.line}`,
                borderRadius: 10,
                background: fill,
                color: foreground,
                opacity: progress,
                transform: `translate3d(0, ${slideFor(progress, 12)}px, 0)`,
                boxShadow: isActive ? "0 8px 22px rgba(190,98,66,.2)" : "none",
                fontFamily: PROGRAM_CUE_SANS,
                fontSize: compact ? 12 : 13,
                fontWeight: 650,
                letterSpacing: "-0.01em",
                whiteSpace: "nowrap",
              }}
            >
              {isComplete ? (
                <Check size={compact ? 13 : 15} strokeWidth={2.5} />
              ) : Icon ? (
                <Icon size={compact ? 13 : 15} strokeWidth={2} />
              ) : (
                <Circle
                  size={compact ? 9 : 10}
                  fill="currentColor"
                  strokeWidth={0}
                />
              )}
              <span>{config.label}</span>
              {config.detail ? (
                <span style={{ opacity: 0.6, fontWeight: 500 }}>
                  {config.detail}
                </span>
              ) : null}
            </div>
            {index < items.length - 1 ? (
              <ArrowRight
                size={compact ? 16 : 19}
                strokeWidth={1.6}
                color={
                  index < completeThrough ? PALETTE.sage : colors.foreground
                }
                style={{ opacity: progress * 0.72, flex: "0 0 auto" }}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export const Flow = FlowChips;
export const FlowChipRow = FlowChips;

export type TruthStatus =
  | "verified"
  | "live"
  | "preview"
  | "simulation"
  | "draft";

export interface TruthBadgeProps {
  label?: string;
  status?: TruthStatus;
  icon?: LucideIcon;
  delay?: number;
  style?: CSSProperties;
}

/** Explicit evidence marker used to distinguish live UI from illustrative states. */
export function TruthBadge({
  label,
  status = "verified",
  icon: CustomIcon,
  delay = 0,
  style,
}: TruthBadgeProps) {
  const frame = useCurrentFrame();
  const progress = fadeIn(frame, delay, 18);
  const config: Record<
    TruthStatus,
    { copy: string; color: string; background: string; Icon: LucideIcon }
  > = {
    verified: {
      copy: "Verified flow",
      color: PALETTE.sageDeep,
      background: "#dcefe0",
      Icon: BadgeCheck,
    },
    live: {
      copy: "Live in Program Cue",
      color: PALETTE.sageDeep,
      background: "#dcefe0",
      Icon: ShieldCheck,
    },
    preview: {
      copy: "Product preview",
      color: PALETTE.copperDeep,
      background: "#f8dfd1",
      Icon: Sparkles,
    },
    simulation: {
      copy: "Illustrative state",
      color: PALETTE.copperDeep,
      background: "#f8dfd1",
      Icon: Sparkles,
    },
    draft: {
      copy: "Draft state",
      color: PALETTE.muted,
      background: "#e9ebe4",
      Icon: Circle,
    },
  };
  const current = config[status];
  const Icon = CustomIcon ?? current.Icon;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minHeight: 29,
        padding: "0 10px",
        borderRadius: 99,
        background: current.background,
        color: current.color,
        opacity: progress,
        transform: `translate3d(0, ${slideFor(progress, 8)}px, 0)`,
        fontFamily: PROGRAM_CUE_SANS,
        fontSize: 11,
        fontWeight: 750,
        letterSpacing: "0.015em",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <Icon size={14} strokeWidth={2.2} />
      <span>{label ?? current.copy}</span>
    </div>
  );
}

export const EvidenceBadge = TruthBadge;
export const Truth = TruthBadge;

export interface MiniBrowserControlsProps {
  tone?: "light" | "dark";
  style?: CSSProperties;
}

/** Optional compact chrome for hand-built product panels inside a scene. */
export function MiniBrowserControls({
  tone = "dark",
  style,
}: MiniBrowserControlsProps) {
  const foreground = tone === "dark" ? "rgba(255,253,248,.55)" : PALETTE.muted;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: foreground,
        ...style,
      }}
    >
      <Menu size={15} strokeWidth={1.8} />
      <MoreHorizontal size={17} strokeWidth={1.8} />
    </div>
  );
}

/** Shared dimensions for scenes that want to reason in the film's native space. */
export const FILM = {
  width: VIDEO.width,
  height: VIDEO.height,
  fps: VIDEO.fps,
} as const;

export { PALETTE };
