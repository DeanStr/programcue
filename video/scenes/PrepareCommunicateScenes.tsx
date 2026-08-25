import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

import { ASSETS } from "../assets";
import { ProgramCueMark } from "../components/ProgramCueBrand";
import { PALETTE } from "../constants";

export type SceneProps = {
  duration: number;
};

const WHITE_92 = "rgba(255, 253, 248, 0.92)";
const WHITE_72 = "rgba(255, 253, 248, 0.72)";
const WHITE_56 = "rgba(255, 253, 248, 0.56)";
const BORDER_GLASS = "rgba(255, 253, 248, 0.16)";
const PAPER_BORDER = "rgba(24, 37, 34, 0.12)";

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const smooth = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

const at = (frame: number, duration: number) =>
  clamp01(frame / Math.max(duration, 1));

const between = (frame: number, duration: number, start: number, end: number) =>
  smooth((at(frame, duration) - start) / Math.max(end - start, 0.001));

// Dense product surfaces need temporal separation. The outgoing state clears
// before the incoming state begins, leaving a short visual breath for the
// continuity pulse below instead of an illegible whole-screen dissolve.
const cleanShotExit = (frame: number, duration: number, center: number) =>
  1 - between(frame, duration, center - 0.009, center - 0.003);

const cleanShotEnter = (frame: number, duration: number, center: number) =>
  between(frame, duration, center + 0.003, center + 0.009);

const visible = (opacity: number, y = 0, x = 0): CSSProperties => ({
  opacity,
  transform: `translate3d(${x}px, ${y}px, 0)`,
});

const mono: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  letterSpacing: "0.12em",
};

const label: CSSProperties = {
  ...mono,
  color: PALETTE.copperSoft,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.2,
  textTransform: "uppercase",
};

const sceneBackground: CSSProperties = {
  backgroundColor: PALETTE.inkDeep,
  backgroundImage:
    "radial-gradient(circle at 78% 8%, rgba(190, 98, 66, 0.22), transparent 28%), radial-gradient(circle at 9% 82%, rgba(143, 191, 154, 0.14), transparent 31%), linear-gradient(135deg, #0b1413 0%, #102321 48%, #0b1413 100%)",
  color: PALETTE.paper,
  overflow: "hidden",
};

const screenShadow =
  "0 32px 70px rgba(3, 10, 9, 0.38), 0 5px 16px rgba(3, 10, 9, 0.28)";

function Grain() {
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

function StateHandoff({
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

function TopBar({
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

function Eyebrow({
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

function Dot({
  active = false,
  complete = false,
}: {
  active?: boolean;
  complete?: boolean;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        backgroundColor: complete
          ? PALETTE.sage
          : active
            ? PALETTE.copper
            : "transparent",
        border: `1px solid ${complete ? PALETTE.sage : active ? PALETTE.copper : "rgba(255, 253, 248, 0.34)"}`,
        borderRadius: "50%",
        display: "flex",
        height: 14,
        justifyContent: "center",
        width: 14,
      }}
    >
      {complete ? (
        <span style={{ color: PALETTE.inkDeep, fontSize: 10 }}>✓</span>
      ) : null}
    </div>
  );
}

function Rail({
  items,
  active,
  progress,
}: {
  items: readonly string[];
  active: number;
  progress: number;
}) {
  return (
    <div style={{ marginTop: 52, width: 366 }}>
      {items.map((item, index) => {
        const complete = index < active;
        const isActive = index === active;
        const next = index < items.length - 1;
        return (
          <div
            key={item}
            style={{ display: "flex", minHeight: next ? 76 : 30 }}
          >
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flexDirection: "column",
                width: 24,
              }}
            >
              <Dot active={isActive} complete={complete} />
              {next ? (
                <div
                  style={{
                    backgroundColor: complete
                      ? PALETTE.sage
                      : "rgba(255, 253, 248, 0.18)",
                    flex: 1,
                    margin: "6px 0",
                    position: "relative",
                    width: 1,
                  }}
                >
                  {isActive ? (
                    <div
                      style={{
                        backgroundColor: PALETTE.copper,
                        height: `${Math.round(progress * 100)}%`,
                        left: 0,
                        position: "absolute",
                        top: 0,
                        width: 1,
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            <div style={{ marginLeft: 19, paddingTop: 0 }}>
              <div
                style={{
                  color: complete || isActive ? PALETTE.paper : WHITE_56,
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                {item}
              </div>
              <div
                style={{
                  color: complete
                    ? PALETTE.sage
                    : isActive
                      ? PALETTE.copperSoft
                      : WHITE_56,
                  fontSize: 12,
                  marginTop: 6,
                }}
              >
                {complete ? "complete" : isActive ? "in progress" : "next"}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BrowserFrame({
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

function IllustrativeEventMoment({ progress }: { progress: number }) {
  const reveal = smooth(clamp01(progress) / 0.1);
  const heldProgress = smooth(clamp01(progress));
  const roomBreath = Math.sin(heldProgress * Math.PI * 2.6);
  const scale =
    interpolate(clamp01(progress), [0, 0.72, 1], [1.025, 1.07, 1.064]) +
    roomBreath * 0.004;
  const drift = interpolate(clamp01(progress), [0, 0.72, 1], [-16, 5, 2]);
  const ribbonShift = interpolate(
    clamp01(progress),
    [0, 0.72, 1],
    [34, -8, -3],
  );
  const panelLift = interpolate(smooth(clamp01(progress)), [0, 1], [22, 0]);
  const thread = interpolate(clamp01(progress), [0, 1], [0, 100]);
  const readinessPulse = interpolate(
    Math.sin(heldProgress * Math.PI * 2.2),
    [-1, 1],
    [0.88, 1],
  );

  return (
    <AbsoluteFill
      style={{
        opacity: reveal,
        overflow: "hidden",
        zIndex: 30,
      }}
    >
      <Img
        src={staticFile("video/illustrative-event-moment.png")}
        style={{
          height: "100%",
          objectFit: "cover",
          objectPosition: "center center",
          transform: `translate3d(${drift}px, 0, 0) scale(${scale})`,
          transformOrigin: "center center",
          width: "100%",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(7, 15, 14, 0.52) 0%, rgba(7, 15, 14, 0.16) 44%, rgba(7, 15, 14, 0.72) 100%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(0deg, rgba(7, 15, 14, 0.72) 0%, rgba(7, 15, 14, 0.12) 48%, rgba(7, 15, 14, 0.3) 100%)",
        }}
      />
      <div
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(246, 197, 169, 0.72), rgba(143, 191, 154, 0.68), transparent)",
          height: 1,
          left: 710,
          opacity: 0.68,
          position: "absolute",
          top: 502,
          transform: `translate3d(${thread * 2.4}px, 0, 0)`,
          width: 560,
        }}
      />
      <div
        style={{
          left: 1028,
          position: "absolute",
          top: 128,
          width: 760,
        }}
      >
        <ProgramCueMark ink={PALETTE.paper} size={48} />
        <div
          style={{
            ...mono,
            backgroundColor: "rgba(7, 15, 14, 0.84)",
            border: `1px solid rgba(246, 197, 169, 0.66)`,
            borderRadius: 999,
            boxShadow: "0 10px 28px rgba(3, 10, 9, 0.24)",
            color: PALETTE.paper,
            display: "inline-block",
            fontSize: 14,
            fontWeight: 850,
            marginTop: 22,
            padding: "11px 16px",
          }}
        >
          FROM SPEAKER PREP TO SHOW DAY
        </div>
        <div
          style={{
            alignItems: "stretch",
            backdropFilter: "blur(10px)",
            background:
              "linear-gradient(135deg, rgba(8, 16, 15, 0.82) 0%, rgba(16, 35, 33, 0.76) 55%, rgba(35, 20, 16, 0.76) 100%)",
            border: "1px solid rgba(255, 253, 248, 0.14)",
            borderRadius: 22,
            boxShadow: "0 24px 58px rgba(4, 10, 9, 0.28)",
            display: "flex",
            gap: 16,
            marginTop: 28,
            overflow: "hidden",
            padding: "18px 20px",
            transform: `translate3d(${ribbonShift}px, ${panelLift}px, 0)`,
            width: 630,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              paddingTop: 2,
              width: 64,
            }}
          >
            {["Accepted session", "Speaker tasks", "Organiser view"].map(
              (item, index) => (
                <div
                  key={item}
                  style={{
                    alignItems: "center",
                    color: index < 2 ? PALETTE.paper : PALETTE.copperSoft,
                    display: "flex",
                    flexDirection: "column",
                    fontSize: 10,
                    fontWeight: 750,
                    gap: 8,
                    opacity: 0.94,
                    textAlign: "center",
                    width: "100%",
                  }}
                >
                  <span
                    style={{
                      backgroundColor:
                        index < 2
                          ? "rgba(143, 191, 154, 0.22)"
                          : `rgba(246, 197, 169, ${0.18 + readinessPulse * 0.1})`,
                      border: `1px solid ${
                        index < 2
                          ? "rgba(143, 191, 154, 0.34)"
                          : "rgba(246, 197, 169, 0.34)"
                      }`,
                      borderRadius: "50%",
                      height: 12,
                      width: 12,
                    }}
                  />
                  {item}
                </div>
              ),
            )}
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                ...label,
                color: PALETTE.copperSoft,
                fontSize: 10,
              }}
            >
              Speaker onboarding
            </div>
            <div
              style={{
                alignItems: "center",
                display: "flex",
                gap: 12,
                marginTop: 10,
              }}
            >
              <div
                style={{
                  backgroundColor: "rgba(255, 253, 248, 0.1)",
                  border: "1px solid rgba(255, 253, 248, 0.12)",
                  borderRadius: 12,
                  color: PALETTE.paper,
                  fontSize: 13,
                  fontWeight: 750,
                  padding: "11px 14px",
                }}
              >
                Priya Shah · accepted session · speaker workspace
              </div>
              <div
                style={{
                  background:
                    "linear-gradient(90deg, rgba(143, 191, 154, 0.2), rgba(246, 197, 169, 0.3))",
                  height: 2,
                  opacity: 0.92,
                  width: 76,
                }}
              />
              <div
                style={{
                  backgroundColor: "rgba(246, 197, 169, 0.12)",
                  border: "1px solid rgba(246, 197, 169, 0.34)",
                  borderRadius: 12,
                  color: PALETTE.copperSoft,
                  fontSize: 12,
                  fontWeight: 800,
                  padding: "11px 14px",
                }}
              >
                Onboarding in progress
              </div>
            </div>
            <div
              style={{
                backgroundColor: "rgba(255, 253, 248, 0.08)",
                border: "1px solid rgba(255, 253, 248, 0.12)",
                borderRadius: 14,
                display: "grid",
                gap: 8,
                gridTemplateColumns: "1fr 1fr 1fr",
                marginTop: 12,
                padding: 11,
              }}
            >
              {[
                ["Record", "accepted session"],
                ["Tasks", "1 complete · 2 open"],
                ["Access", "private workspace"],
              ].map(([title, detail]) => (
                <div key={title}>
                  <div style={{ ...label, color: WHITE_56, fontSize: 8 }}>
                    {title}
                  </div>
                  <div
                    style={{
                      color: PALETTE.paper,
                      fontSize: 12,
                      fontWeight: 800,
                      marginTop: 5,
                    }}
                  >
                    {detail}
                  </div>
                </div>
              ))}
            </div>
            <div
              style={{
                alignItems: "center",
                display: "flex",
                gap: 10,
                marginTop: 12,
              }}
            >
              <span
                style={{
                  backgroundColor: `rgba(143, 191, 154, ${0.18 + readinessPulse * 0.18})`,
                  border: "1px solid rgba(143, 191, 154, 0.34)",
                  borderRadius: 999,
                  color: PALETTE.paper,
                  fontSize: 11,
                  fontWeight: 800,
                  padding: "8px 12px",
                }}
              >
                One connected record
              </span>
              <span style={{ color: WHITE_72, fontSize: 12, lineHeight: 1.45 }}>
                Session, speaker and tasks stay in sync.
              </span>
            </div>
            <div
              style={{
                borderTop: "1px solid rgba(255, 253, 248, 0.12)",
                color: PALETTE.copperSoft,
                fontSize: 11,
                fontWeight: 800,
                marginTop: 13,
                opacity: smooth((clamp01(progress) - 0.76) / 0.16),
                paddingTop: 11,
                textTransform: "uppercase",
              }}
            >
              Next action · review outstanding tasks
            </div>
          </div>
        </div>
        <h2
          style={{
            color: PALETTE.paper,
            fontSize: 64,
            fontWeight: 800,
            letterSpacing: "-0.065em",
            lineHeight: 0.94,
            margin: "24px 0 0",
            maxWidth: 620,
          }}
        >
          One view from
          <br />
          <span style={{ color: PALETTE.copperSoft }}>
            acceptance to readiness.
          </span>
        </h2>
        <p
          style={{
            color: WHITE_92,
            fontSize: 18,
            lineHeight: 1.45,
            margin: "22px 0 0",
            maxWidth: 470,
          }}
        >
          See the session, speaker and next action in one connected view.
        </p>
      </div>
    </AbsoluteFill>
  );
}

function PhoneFrame({
  src,
  width,
  height,
  label: phoneLabel,
  objectPosition = "center top",
  style,
}: {
  src: string;
  width: number;
  height: number;
  label?: string;
  objectPosition?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        backgroundColor: "#101b1a",
        border: "7px solid #273c38",
        borderRadius: 28,
        boxSizing: "border-box",
        boxShadow: screenShadow,
        height,
        overflow: "hidden",
        padding: 3,
        position: "relative",
        width,
        ...style,
      }}
    >
      <div
        style={{
          backgroundColor: "#273c38",
          borderRadius: 10,
          height: 5,
          left: "50%",
          position: "absolute",
          top: 8,
          transform: "translateX(-50%)",
          width: 55,
          zIndex: 1,
        }}
      />
      <Img
        src={src}
        style={{
          borderRadius: 19,
          display: "block",
          height: "100%",
          objectFit: "cover",
          objectPosition,
          width: "100%",
        }}
      />
      {phoneLabel ? (
        <div
          style={{
            backgroundColor: "rgba(11, 20, 19, 0.88)",
            border: `1px solid ${BORDER_GLASS}`,
            borderRadius: 999,
            bottom: 14,
            color: WHITE_92,
            fontSize: 10,
            fontWeight: 700,
            left: "50%",
            padding: "7px 10px",
            position: "absolute",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
          }}
        >
          {phoneLabel}
        </div>
      ) : null}
    </div>
  );
}

function StageHeader({
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

function MiniPill({
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

function ProposalCard({ progress }: { progress: number }) {
  return (
    <div
      style={{
        background: "linear-gradient(145deg, #fffdf8 0%, #f7eee8 100%)",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 22,
        boxShadow: "0 22px 58px rgba(19, 32, 31, 0.18)",
        left: 65,
        padding: 28,
        position: "absolute",
        top: 142,
        transform: `translate3d(${(1 - progress) * -24}px, ${(1 - progress) * 18}px, 0) rotate(${(1 - progress) * -1.2}deg)`,
        width: 580,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <MiniPill tone="sage" active>
          Accepted session record
        </MiniPill>
        <span style={{ ...mono, color: PALETTE.muted, fontSize: 10 }}>
          ACCEPTED SESSION
        </span>
      </div>
      <div
        style={{
          color: PALETTE.ink,
          fontSize: 27,
          fontWeight: 800,
          letterSpacing: "-0.045em",
          marginTop: 23,
        }}
      >
        Designing inclusive event technology
      </div>
      <div
        style={{
          color: PALETTE.muted,
          fontSize: 14,
          lineHeight: 1.45,
          marginTop: 10,
        }}
      >
        Practical patterns for accessible, calm and effective attendee
        experiences.
      </div>
      <div
        style={{
          borderTop: `1px solid ${PAPER_BORDER}`,
          display: "flex",
          gap: 25,
          marginTop: 24,
          paddingTop: 17,
        }}
      >
        <div>
          <div style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
            Speaker
          </div>
          <div
            style={{
              color: PALETTE.ink,
              fontSize: 13,
              fontWeight: 700,
              marginTop: 5,
            }}
          >
            Priya Shah
          </div>
        </div>
        <div>
          <div style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
            Onboarding state
          </div>
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 13,
              fontWeight: 700,
              marginTop: 5,
            }}
          >
            In progress
          </div>
        </div>
      </div>
      <div
        style={{
          alignItems: "center",
          backgroundColor: "#19312b",
          borderRadius: 12,
          color: WHITE_92,
          display: "flex",
          fontSize: 13,
          fontWeight: 750,
          gap: 8,
          marginTop: 23,
          padding: "12px 15px",
          width: "fit-content",
        }}
      >
        <span style={{ color: PALETTE.sage, fontSize: 16 }}>↗</span>
        Speaker workspace linked
      </div>
    </div>
  );
}

function LinkSummary({ progress }: { progress: number }) {
  const links = [
    ["Session", "Designing inclusive event technology"],
    ["Speaker", "Priya Shah · linked speaker"],
    ["Tasks", "3 requirements · assigned"],
  ] as const;
  const connected = Math.min(3, Math.max(1, Math.ceil(clamp01(progress) * 3)));
  return (
    <div
      style={{
        backgroundColor: "rgba(255, 253, 248, 0.97)",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 17,
        bottom: 34,
        boxShadow: "0 18px 46px rgba(19, 32, 31, 0.16)",
        padding: 17,
        position: "absolute",
        right: 34,
        transform: `translate3d(${(1 - progress) * 26}px, 0, 0)`,
        width: 344,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span style={{ color: PALETTE.ink, fontSize: 13, fontWeight: 800 }}>
          Relationships connected
        </span>
        <span
          style={{ color: PALETTE.sageDeep, fontSize: 11, fontWeight: 750 }}
        >
          {connected} / 3
        </span>
      </div>
      {links.map(([name, detail], index) => {
        const isConnected = index < connected;
        return (
          <div
            key={name}
            style={{
              alignItems: "center",
              borderTop: `1px solid ${PAPER_BORDER}`,
              display: "flex",
              gap: 11,
              opacity: isConnected ? 1 : 0.46,
              padding: "10px 0 2px",
            }}
          >
            <div
              style={{
                alignItems: "center",
                backgroundColor: isConnected ? "#edf5ee" : "transparent",
                border: isConnected ? "none" : `1px solid ${PAPER_BORDER}`,
                borderRadius: 8,
                color: isConnected ? PALETTE.sageDeep : PALETTE.muted,
                display: "flex",
                fontSize: 12,
                fontWeight: 800,
                height: 26,
                justifyContent: "center",
                width: 26,
              }}
            >
              {isConnected ? "✓" : index + 1}
            </div>
            <div>
              <div
                style={{
                  color: PALETTE.muted,
                  fontSize: 10,
                  fontWeight: 750,
                  textTransform: "uppercase",
                }}
              >
                {name}
              </div>
              <div
                style={{
                  color: PALETTE.ink,
                  fontSize: 11,
                  fontWeight: 700,
                  marginTop: 2,
                }}
              >
                {detail}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UploadLifecycle({ progress }: { progress: number }) {
  const statuses = ["Quarantined", "Scanning", "Clean", "Released"] as const;
  const scaledProgress = clamp01(progress) * statuses.length;
  const active = Math.min(statuses.length - 1, Math.floor(scaledProgress));
  const activeProgress = clamp01(scaledProgress - active);
  const activityPulse = Math.sin(activeProgress * Math.PI);
  const sweep = interpolate(clamp01(progress), [0, 1], [-18, 108]);
  return (
    <div
      style={{
        backgroundColor: "rgba(19, 32, 31, 0.93)",
        border: `1px solid ${BORDER_GLASS}`,
        borderRadius: 16,
        bottom: 64,
        color: PALETTE.paper,
        left: 35,
        overflow: "hidden",
        padding: "15px 17px 17px",
        position: "absolute",
        right: 35,
      }}
    >
      <div
        aria-hidden
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(246, 197, 169, 0.13), transparent)",
          bottom: 0,
          left: `${sweep}%`,
          position: "absolute",
          top: 0,
          transform: "skewX(-14deg)",
          width: 120,
        }}
      />
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          position: "relative",
        }}
      >
        <div>
          <div style={{ ...label, color: PALETTE.copperSoft, fontSize: 11 }}>
            Private file security
          </div>
          <div style={{ fontSize: 13, fontWeight: 750, marginTop: 5 }}>
            Session deck stays quarantined until clean, then role-restricted
          </div>
        </div>
        <MiniPill tone="dark" active={active === statuses.length - 1}>
          {statuses[active]}
        </MiniPill>
      </div>
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          marginTop: 15,
          position: "relative",
        }}
      >
        {statuses.map((status, index) => {
          const complete = index < active;
          const current = index === active;
          const connectorProgress =
            index < active ? 1 : index === active ? activeProgress : 0;
          return (
            <div
              key={status}
              style={{
                alignItems: "center",
                display: "flex",
                flex: index === statuses.length - 1 ? "0 0 auto" : 1,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: 7,
                }}
              >
                <div
                  style={{
                    alignItems: "center",
                    backgroundColor: complete
                      ? PALETTE.sage
                      : current
                        ? PALETTE.copper
                        : "transparent",
                    border: `1px solid ${complete ? PALETTE.sage : current ? PALETTE.copper : "rgba(255, 253, 248, 0.32)"}`,
                    borderRadius: "50%",
                    display: "flex",
                    height: 21,
                    justifyContent: "center",
                    boxShadow: current
                      ? `0 0 ${12 + activityPulse * 14}px rgba(190, 98, 66, ${0.18 + activityPulse * 0.2})`
                      : "none",
                    transform: `scale(${current ? 1 + activityPulse * 0.12 : 1})`,
                    width: 21,
                  }}
                >
                  {complete ? (
                    <span style={{ color: PALETTE.inkDeep, fontSize: 11 }}>
                      ✓
                    </span>
                  ) : current ? (
                    <span
                      style={{
                        backgroundColor: PALETTE.paper,
                        borderRadius: "50%",
                        height: 5,
                        width: 5,
                      }}
                    />
                  ) : null}
                </div>
                <span
                  style={{
                    color: complete || current ? WHITE_92 : WHITE_56,
                    fontSize: 10,
                    fontWeight: current ? 750 : 600,
                  }}
                >
                  {status}
                </span>
              </div>
              {index < statuses.length - 1 ? (
                <div
                  style={{
                    backgroundColor: "rgba(255, 253, 248, 0.20)",
                    height: 1,
                    margin: "10px 9px 0",
                    flex: 1,
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      background: `linear-gradient(90deg, ${PALETTE.copper}, ${PALETTE.sage})`,
                      height: "100%",
                      left: 0,
                      position: "absolute",
                      top: 0,
                      width: `${connectorProgress * 100}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReadinessCadence({ progress }: { progress: number }) {
  const items = [
    {
      detail: "complete · recorded",
      eyebrow: "Requirement 01",
      state: "✓ Complete",
      title: "Complete your speaker profile",
    },
    {
      detail: "not started · owner visible",
      eyebrow: "Requirement 02",
      state: "Open",
      title: "Read the speaker handbook",
    },
    {
      detail: "not started · private upload",
      eyebrow: "Requirement 03",
      state: "Open",
      title: "Upload presentation slides",
    },
  ] as const;
  const focusPosition = clamp01(progress) * (items.length - 1);

  return (
    <div
      style={{
        backgroundColor: "rgba(255, 253, 248, 0.72)",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 17,
        boxShadow: "0 16px 38px rgba(19, 32, 31, 0.08)",
        left: 58,
        overflow: "hidden",
        padding: "14px 16px 15px",
        position: "absolute",
        top: 572,
        transform: `translate3d(${interpolate(clamp01(progress), [0, 1], [8, -8])}px, 0, 0)`,
        width: 970,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ ...label, color: PALETTE.copperDeep, fontSize: 9 }}>
          Speaker onboarding tasks
        </div>
        <div style={{ ...mono, color: PALETTE.sageDeep, fontSize: 9 }}>
          1 COMPLETE · 2 OPEN
        </div>
      </div>
      <div
        style={{
          backgroundColor: "rgba(24, 37, 34, 0.10)",
          height: 1,
          marginTop: 11,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: `linear-gradient(90deg, ${PALETTE.copper}, ${PALETTE.sageDeep})`,
            height: "100%",
            width: `${clamp01(progress) * 100}%`,
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        {items.map((item, index) => {
          const emphasis = clamp01(1 - Math.abs(focusPosition - index));
          const complete = index === 0;
          return (
            <div
              key={item.title}
              style={{
                backgroundColor: complete
                  ? "rgba(237, 245, 238, 0.9)"
                  : emphasis > 0.18
                    ? "rgba(255, 241, 233, 0.82)"
                    : "rgba(255, 253, 248, 0.78)",
                border: `1px solid ${
                  complete
                    ? "rgba(58, 95, 66, 0.18)"
                    : emphasis > 0.18
                      ? "rgba(190, 98, 66, 0.22)"
                      : PAPER_BORDER
                }`,
                borderRadius: 11,
                flex: 1,
                opacity: 0.72 + emphasis * 0.28,
                padding: "10px 11px",
                transform: `translate3d(0, ${-4 * emphasis}px, 0)`,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ ...label, color: PALETTE.muted, fontSize: 8 }}>
                  {item.eyebrow}
                </span>
                <span
                  style={{
                    color: complete
                      ? PALETTE.sageDeep
                      : emphasis > 0.18
                        ? PALETTE.copperDeep
                        : PALETTE.muted,
                    fontSize: 9,
                    fontWeight: 800,
                  }}
                >
                  {item.state}
                </span>
              </div>
              <div
                style={{
                  color: PALETTE.ink,
                  fontSize: 12,
                  fontWeight: 800,
                  marginTop: 7,
                }}
              >
                {item.title}
              </div>
              <div style={{ color: PALETTE.muted, fontSize: 10, marginTop: 3 }}>
                {item.detail}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReadyNotice({ progress }: { progress: number }) {
  return (
    <div
      style={{
        background: "linear-gradient(135deg, #f8fff6 0%, #e6f2e8 100%)",
        border: "1px solid rgba(58, 95, 66, 0.20)",
        borderRadius: 22,
        boxShadow: "0 24px 58px rgba(16, 45, 30, 0.20)",
        left: 124,
        padding: "31px 34px 28px",
        position: "absolute",
        top: 133,
        transform: `translate3d(${(1 - progress) * 28}px, ${(1 - progress) * 18}px, 0) scale(${0.97 + progress * 0.03})`,
        width: 796,
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 13 }}>
        <div
          style={{
            alignItems: "center",
            backgroundColor: PALETTE.sageDeep,
            borderRadius: "50%",
            color: PALETTE.paper,
            display: "flex",
            fontSize: 19,
            fontWeight: 800,
            height: 38,
            justifyContent: "center",
            width: 38,
          }}
        >
          ✓
        </div>
        <div>
          <div style={{ ...label, color: PALETTE.sageDeep, fontSize: 10 }}>
            Preparation ready
          </div>
          <div
            style={{
              color: PALETTE.ink,
              fontSize: 25,
              fontWeight: 800,
              letterSpacing: "-0.04em",
              marginTop: 5,
            }}
          >
            Everything you need is in view.
          </div>
        </div>
      </div>
      <div
        style={{
          color: PALETTE.muted,
          fontSize: 14,
          lineHeight: 1.5,
          margin: "20px 0 23px 51px",
          maxWidth: 615,
        }}
      >
        The accepted session, speaker workspace, onboarding tasks and files stay
        connected from acceptance to show day.
      </div>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginLeft: 51 }}
      >
        <MiniPill tone="sage" active>
          Session linked
        </MiniPill>
        <MiniPill tone="sage" active>
          Speaker workspace
        </MiniPill>
        <MiniPill tone="sage" active>
          1 task complete · 2 outstanding
        </MiniPill>
        <MiniPill tone="light" active>
          Private by default
        </MiniPill>
      </div>
      <div
        style={{
          alignItems: "center",
          borderTop: "1px solid rgba(58, 95, 66, 0.16)",
          color: PALETTE.sageDeep,
          display: "flex",
          fontSize: 12,
          fontWeight: 700,
          gap: 9,
          marginTop: 24,
          paddingTop: 16,
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
        Preparation review · organiser can review current task status
      </div>
    </div>
  );
}

function PreparationSideNote({ progress }: { progress: number }) {
  return (
    <div
      style={{
        backgroundColor: "rgba(24, 37, 34, 0.035)",
        border: "1px solid rgba(24, 37, 34, 0.12)",
        borderRadius: 18,
        padding: 20,
        position: "absolute",
        right: 37,
        top: 143,
        transform: `translate3d(${(1 - progress) * 20}px, ${(1 - progress) * 12}px, 0)`,
        width: 278,
      }}
    >
      <div style={{ ...label, color: PALETTE.sageDeep, fontSize: 9 }}>
        Preparation status
      </div>
      <div
        style={{
          color: PALETTE.ink,
          fontSize: 17,
          fontWeight: 750,
          letterSpacing: "-0.02em",
          lineHeight: 1.25,
          marginTop: 10,
        }}
      >
        See every relevant task and file change.
      </div>
      <div
        style={{
          color: PALETTE.muted,
          fontSize: 12,
          lineHeight: 1.5,
          marginTop: 12,
        }}
      >
        This view combines acceptance, linked records and current onboarding
        status.
      </div>
      <div
        style={{
          borderTop: "1px solid rgba(24, 37, 34, 0.1)",
          color: PALETTE.sageDeep,
          fontSize: 11,
          fontWeight: 700,
          marginTop: 18,
          paddingTop: 13,
        }}
      >
        AUDIT TRAIL · CONNECTED
      </div>
    </div>
  );
}

export function PrepareScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = at(frame, duration);
  const linkedCenter = 0.1975;
  const workspaceCenter = 0.4075;
  const readyCenter = 0.7325;
  const eventProgress = clamp01((frame - (duration - 225)) / 225);
  const activeStep =
    progress < 0.2 ? 0 : progress < 0.41 ? 1 : progress < 0.735 ? 2 : 3;
  const stageProgress =
    activeStep === 0
      ? between(frame, duration, 0, 0.2)
      : activeStep === 1
        ? between(frame, duration, 0.2, 0.41)
        : activeStep === 2
          ? between(frame, duration, 0.41, 0.735)
          : between(frame, duration, 0.735, 1);
  const linkedStageProgress = between(frame, duration, 0.2, 0.41);
  const readinessProgress = between(frame, duration, 0.41, 0.735);
  const uploadProgress = between(frame, duration, 0.43, 0.72);

  const acceptedOpacity = cleanShotExit(frame, duration, linkedCenter);
  const linkedOpacity =
    cleanShotEnter(frame, duration, linkedCenter) *
    cleanShotExit(frame, duration, workspaceCenter);
  const workspaceOpacity =
    cleanShotEnter(frame, duration, workspaceCenter) *
    cleanShotExit(frame, duration, readyCenter);
  const readyOpacity = cleanShotEnter(frame, duration, readyCenter);

  return (
    <AbsoluteFill style={sceneBackground}>
      <Grain />
      <TopBar
        chapter="Prepare"
        chapterNumber="07 / 13"
        roleLabel="ORGANISER · SPEAKER SUCCESS"
      />
      <div
        style={{
          bottom: 40,
          left: 74,
          position: "absolute",
          top: 120,
          width: 390,
          zIndex: 2,
        }}
      >
        <Eyebrow>Prepare / preparation record</Eyebrow>
        <h1
          style={{
            color: PALETTE.paper,
            fontSize: 50,
            fontWeight: 780,
            letterSpacing: "-0.065em",
            lineHeight: 0.98,
            margin: "20px 0 0",
            maxWidth: 410,
          }}
        >
          Turn every “yes”
          <br />
          <span style={{ color: PALETTE.copperSoft }}>into ready.</span>
        </h1>
        <p
          style={{
            color: WHITE_72,
            fontSize: 16,
            lineHeight: 1.52,
            margin: "22px 0 0",
            maxWidth: 340,
          }}
        >
          Connect the accepted session, speaker, tasks and files in one
          preparation view.
        </p>
        <Rail
          items={["Accepted", "Linked", "In progress", "Ready"]}
          active={activeStep}
          progress={stageProgress}
        />
        <div
          style={{
            alignItems: "center",
            bottom: 0,
            color: WHITE_56,
            display: "flex",
            fontSize: 12,
            gap: 9,
            left: 0,
            position: "absolute",
          }}
        >
          <span
            style={{
              backgroundColor: PALETTE.copper,
              borderRadius: "50%",
              height: 7,
              width: 7,
            }}
          />
          Organiser preparation view
        </div>
      </div>
      <div
        style={{
          backgroundColor: PALETTE.canvas,
          border: `1px solid ${BORDER_GLASS}`,
          borderRadius: 28,
          bottom: 42,
          boxShadow: "0 30px 90px rgba(0, 0, 0, 0.25)",
          left: 523,
          overflow: "hidden",
          position: "absolute",
          right: 74,
          top: 126,
        }}
      >
        <StageHeader
          eyebrow="Record / Future of Events 2027"
          title="One connected preparation view"
          detail="Session, speaker, tasks and files move together from acceptance to show day."
          status={
            activeStep === 3
              ? "Ready"
              : activeStep === 2
                ? "Tasks active"
                : activeStep === 1
                  ? "Records linked"
                  : "Accepted session"
          }
        />
        <div
          style={{
            backgroundColor: "rgba(24, 37, 34, 0.10)",
            height: 1,
            left: 30,
            position: "absolute",
            right: 30,
            top: 112,
          }}
        />

        <div
          style={{
            ...visible(acceptedOpacity, (1 - acceptedOpacity) * 20),
            inset: 0,
            position: "absolute",
          }}
        >
          <ProposalCard progress={clamp01(progress / linkedCenter)} />
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 12,
              left: 686,
              position: "absolute",
              top: 181,
              width: 215,
            }}
          >
            <div style={{ ...label, color: PALETTE.copperDeep, fontSize: 9 }}>
              01 · session accepted
            </div>
            <div
              style={{
                color: PALETTE.ink,
                fontSize: 18,
                fontWeight: 760,
                lineHeight: 1.2,
                marginTop: 10,
              }}
            >
              An accepted session starts onboarding.
            </div>
            <div style={{ lineHeight: 1.5, marginTop: 9 }}>
              Acceptance links the session, speakers and selected onboarding
              tasks.
            </div>
          </div>
        </div>

        <div
          style={{
            ...visible(linkedOpacity, (1 - linkedOpacity) * 18),
            inset: 0,
            position: "absolute",
          }}
        >
          <BrowserFrame
            src={ASSETS.speakerDashboard}
            width={676}
            height={414}
            label="app.programcue.com / overview"
            objectPosition="center top"
            imageScale={1.3}
            imageOrigin="left top"
            style={{
              left: 65,
              position: "absolute",
              top: 132,
              transform: `translate3d(${interpolate(linkedStageProgress, [0, 1], [7, -8])}px, ${interpolate(linkedStageProgress, [0, 1], [4, -4])}px, 0) scale(${interpolate(linkedStageProgress, [0, 1], [1, 1.012])})`,
              transformOrigin: "left top",
            }}
          />
          <div style={{ left: 52, position: "absolute", top: 132 }}>
            <MiniPill tone="sage" active>
              Speaker workspace linked
            </MiniPill>
          </div>
          <PhoneFrame
            src={ASSETS.speakerDashboardMobile}
            width={260}
            height={430}
            label="mobile workspace"
            style={{
              left: 790,
              position: "absolute",
              top: 132,
              transform: `translate3d(${interpolate(linkedStageProgress, [0, 1], [-5, 8])}px, ${interpolate(linkedStageProgress, [0, 1], [-3, 6])}px, 0)`,
            }}
          />
          <div
            style={{
              left: 1080,
              position: "absolute",
              top: 164,
              transform: `translate3d(0, ${interpolate(linkedStageProgress, [0, 1], [6, -4])}px, 0)`,
            }}
          >
            <div style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
              02 · linked records
            </div>
            <div
              style={{
                color: PALETTE.ink,
                fontSize: 18,
                fontWeight: 780,
                letterSpacing: "-0.04em",
                lineHeight: 1.08,
                marginTop: 9,
                width: 170,
              }}
            >
              Link session, speaker and tasks.
            </div>
            <div
              style={{
                color: PALETTE.muted,
                fontSize: 12,
                lineHeight: 1.45,
                marginTop: 10,
                width: 170,
              }}
            >
              Linked records show status, owner and next action without manual
              reconciliation.
            </div>
          </div>
          <LinkSummary progress={between(frame, duration, 0.18, 0.42)} />
        </div>

        <div
          style={{
            ...visible(workspaceOpacity, (1 - workspaceOpacity) * 18),
            inset: 0,
            position: "absolute",
          }}
        >
          <BrowserFrame
            src={ASSETS.tasksReadiness}
            width={748}
            height={402}
            label="app.programcue.com / tasks"
            objectPosition="center top"
            imageScale={1.25}
            imageOrigin="left 90%"
            style={{
              left: 48,
              position: "absolute",
              top: 132,
              transform: `translate3d(${interpolate(readinessProgress, [0, 1], [7, -10])}px, ${interpolate(readinessProgress, [0, 1], [5, -5])}px, 0) scale(${interpolate(readinessProgress, [0, 1], [1, 1.014])})`,
              transformOrigin: "left top",
            }}
          />
          <div style={{ left: 48, position: "absolute", top: 128 }}>
            <MiniPill tone="copper" active>
              Readiness · 33%
            </MiniPill>
          </div>
          <PhoneFrame
            src={ASSETS.speakerProfileMobile}
            width={250}
            height={420}
            label="speaker profile"
            objectPosition="center top"
            style={{
              left: 810,
              position: "absolute",
              top: 132,
              transform: `translate3d(${interpolate(readinessProgress, [0, 1], [-6, 9])}px, ${interpolate(readinessProgress, [0, 1], [-4, 7])}px, 0)`,
            }}
          />
          <div
            style={{
              left: 1080,
              position: "absolute",
              top: 164,
              transform: `translate3d(0, ${interpolate(readinessProgress, [0, 1], [6, -5])}px, 0)`,
            }}
          >
            <div style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
              03 · speaker workspace
            </div>
            <div
              style={{
                color: PALETTE.ink,
                fontSize: 18,
                fontWeight: 780,
                letterSpacing: "-0.04em",
                lineHeight: 1.08,
                marginTop: 9,
                width: 170,
              }}
            >
              Current task completion.
            </div>
            <div
              style={{
                color: PALETTE.muted,
                fontSize: 12,
                lineHeight: 1.45,
                marginTop: 10,
                width: 170,
              }}
            >
              Onboarding tasks show status, owner and next action. Uploaded
              files remain private.
            </div>
          </div>
          <ReadinessCadence progress={readinessProgress} />
          <UploadLifecycle progress={uploadProgress} />
        </div>

        <div
          style={{
            ...visible(readyOpacity, (1 - readyOpacity) * 16),
            inset: 0,
            position: "absolute",
          }}
        >
          <ReadyNotice progress={between(frame, duration, 0.72, 0.775)} />
          <PreparationSideNote
            progress={between(frame, duration, 0.72, 0.775)}
          />
          <div
            style={{
              bottom: 39,
              color: PALETTE.muted,
              fontSize: 12,
              left: 126,
              position: "absolute",
            }}
          >
            <span style={{ color: PALETTE.sageDeep, fontWeight: 750 }}>
              Private file security
            </span>{" "}
            · clean files remain restricted to authorised event roles
          </div>
        </div>

        {[
          { center: linkedCenter, from: "Accepted", to: "Linked" },
          { center: workspaceCenter, from: "Linked", to: "Tasks active" },
          { center: readyCenter, from: "Tasks active", to: "Reviewable" },
        ].map(({ center, from, to }) => (
          <StateHandoff
            key={center}
            fromLabel={from}
            progress={between(frame, duration, center - 0.011, center + 0.011)}
            toLabel={to}
            top={112}
          />
        ))}

        <div
          style={{
            alignItems: "center",
            bottom: 25,
            display: "flex",
            left: 35,
            position: "absolute",
            right: 35,
            zIndex: 3,
          }}
        >
          <div style={{ color: PALETTE.muted, fontSize: 11 }}>
            CONNECTED RECORD
          </div>
          <div
            style={{
              backgroundColor: "rgba(24, 37, 34, 0.13)",
              height: 1,
              margin: "0 13px",
              flex: 1,
            }}
          />
          <div style={{ color: PALETTE.muted, fontSize: 11 }}>
            SESSION · SPEAKER · TASKS · PRIVATE WORKSPACE
          </div>
        </div>
      </div>
      <div
        style={{
          ...mono,
          bottom: 17,
          color: "rgba(255, 253, 248, 0.28)",
          fontSize: 9,
          position: "absolute",
          right: 74,
        }}
      >
        PROGRAM CUE / PREPARE / 2027
      </div>
      <IllustrativeEventMoment progress={eventProgress} />
    </AbsoluteFill>
  );
}

function CommunicationRail({ active }: { active: number }) {
  const items = [
    "Compose",
    "Preview",
    "Confirm",
    "Queued",
    "Handoff",
    "Result",
  ] as const;
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        left: 35,
        position: "absolute",
        right: 35,
        top: 124,
      }}
    >
      {items.map((item, index) => {
        const complete = index < active;
        const current = index === active;
        return (
          <div
            key={item}
            style={{
              alignItems: "center",
              display: "flex",
              flex: index === items.length - 1 ? "0 0 auto" : 1,
            }}
          >
            <div style={{ alignItems: "center", display: "flex", gap: 7 }}>
              <div
                style={{
                  alignItems: "center",
                  backgroundColor: complete
                    ? PALETTE.sage
                    : current
                      ? PALETTE.copper
                      : "transparent",
                  border: `1px solid ${complete ? PALETTE.sage : current ? PALETTE.copper : "rgba(24, 37, 34, 0.27)"}`,
                  borderRadius: "50%",
                  color: complete ? PALETTE.inkDeep : PALETTE.paper,
                  display: "flex",
                  fontSize: 10,
                  fontWeight: 800,
                  height: 19,
                  justifyContent: "center",
                  width: 19,
                }}
              >
                {complete ? "✓" : index + 1}
              </div>
              <span
                style={{
                  color: complete || current ? PALETTE.ink : PALETTE.muted,
                  fontSize: 10,
                  fontWeight: current ? 800 : 650,
                }}
              >
                {item}
              </span>
            </div>
            {index < items.length - 1 ? (
              <div
                style={{
                  backgroundColor:
                    index < active ? PALETTE.sage : "rgba(24, 37, 34, 0.13)",
                  height: 1,
                  margin: "0 10px",
                  flex: 1,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ComposeOverlay({ progress }: { progress: number }) {
  return (
    <div
      style={{
        backgroundColor: "rgba(255, 253, 248, 0.97)",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 18,
        boxShadow: "0 18px 44px rgba(19, 32, 31, 0.18)",
        left: 58,
        padding: 20,
        position: "absolute",
        top: 187,
        transform: `translate3d(${(1 - progress) * -22}px, ${(1 - progress) * 12}px, 0)`,
        width: 360,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ ...label, color: PALETTE.copperDeep, fontSize: 9 }}>
          01 · compose
        </div>
        <MiniPill tone="copper" active>
          Published v1
        </MiniPill>
      </div>
      <div
        style={{
          color: PALETTE.ink,
          fontSize: 19,
          fontWeight: 800,
          letterSpacing: "-0.035em",
          marginTop: 18,
        }}
      >
        Speaker welcome
      </div>
      <div
        style={{
          borderTop: `1px solid ${PAPER_BORDER}`,
          color: PALETTE.muted,
          fontSize: 12,
          lineHeight: 1.55,
          marginTop: 14,
          paddingTop: 13,
        }}
      >
        Welcome to {"{{event.name}}"}. Your speaker workspace is ready.
      </div>
      <div style={{ display: "flex", gap: 7, marginTop: 17 }}>
        <MiniPill tone="light" active>
          To · 1
        </MiniPill>
        <MiniPill tone="light">Transactional</MiniPill>
      </div>
      <div
        style={{
          alignItems: "center",
          backgroundColor: PALETTE.ink,
          borderRadius: 9,
          color: PALETTE.paper,
          display: "flex",
          fontSize: 11,
          fontWeight: 750,
          gap: 7,
          marginTop: 18,
          padding: "10px 12px",
          width: "fit-content",
        }}
      >
        Save as new draft
        <span style={{ color: PALETTE.copperSoft }}>↗</span>
      </div>
    </div>
  );
}

function PreviewOverlay({ progress }: { progress: number }) {
  return (
    <div
      style={{
        backgroundColor: "rgba(255, 253, 248, 0.98)",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 18,
        bottom: 42,
        boxShadow: "0 20px 50px rgba(19, 32, 31, 0.20)",
        padding: "16px 18px 17px",
        position: "absolute",
        right: 39,
        transform: `translate3d(${(1 - progress) * 24}px, ${(1 - progress) * 12}px, 0)`,
        width: 380,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ ...label, color: PALETTE.sageDeep, fontSize: 9 }}>
          02 · preview
        </div>
        <MiniPill tone="sage" active>
          Welcome template
        </MiniPill>
      </div>
      <div
        style={{
          color: PALETTE.ink,
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: "-0.03em",
          marginTop: 14,
        }}
      >
        Personalised preview · Alex Morgan
      </div>
      <div
        style={{
          color: PALETTE.muted,
          fontSize: 12,
          lineHeight: 1.45,
          marginTop: 7,
        }}
      >
        Resolved merge values show the personalised welcome before the audience
        is rechecked at confirmation.
      </div>
      <div
        style={{
          alignItems: "center",
          borderTop: `1px solid ${PAPER_BORDER}`,
          display: "flex",
          gap: 9,
          marginTop: 13,
          paddingTop: 12,
        }}
      >
        <span style={{ color: PALETTE.sageDeep, fontSize: 15 }}>✓</span>
        <span
          style={{ color: PALETTE.sageDeep, fontSize: 11, fontWeight: 750 }}
        >
          Preview shows resolved content, sender and required footer
        </span>
      </div>
    </div>
  );
}

function ConfirmationCard({ progress }: { progress: number }) {
  const validationProgress = between(progress, 1, 0.04, 0.5);
  const cursorProgress = between(progress, 1, 0.36, 0.64);
  const pressProgress = between(progress, 1, 0.58, 0.72);
  const commitProgress = between(progress, 1, 0.68, 0.79);
  const cursorOpacity =
    between(progress, 1, 0.3, 0.4) * (1 - between(progress, 1, 0.75, 0.84));
  const pressEnvelope = Math.sin(pressProgress * Math.PI);
  const committed = commitProgress > 0.58;
  const confirmationDetails = [
    ["Audience", "1 speaker", "rechecked"],
    ["Template", "Speaker welcome · v1", "versioned"],
    ["Dispatch", "Queue after confirmation", "ready"],
  ] as const;
  const sweep = interpolate(between(progress, 1, 0.1, 0.9), [0, 1], [-20, 112]);

  return (
    <div
      style={{
        backgroundColor: "#fffdf8",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 20,
        boxShadow: "0 20px 50px rgba(19, 32, 31, 0.16)",
        left: 89,
        overflow: "hidden",
        padding: 29,
        position: "absolute",
        top: 186,
        transform: `translate3d(${interpolate(clamp01(progress), [0, 1], [10, -7])}px, ${interpolate(clamp01(progress), [0, 1], [8, -5])}px, 0) scale(${interpolate(clamp01(progress), [0, 1], [0.992, 1.006])})`,
        transformOrigin: "center center",
        width: 930,
      }}
    >
      <div
        aria-hidden
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(246, 197, 169, 0.1), transparent)",
          bottom: 0,
          left: `${sweep}%`,
          position: "absolute",
          top: 0,
          transform: "skewX(-12deg)",
          width: 110,
        }}
      />
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          position: "relative",
        }}
      >
        <div>
          <div style={{ ...label, color: PALETTE.copperDeep, fontSize: 9 }}>
            03 · confirm delivery
          </div>
          <div
            style={{
              color: PALETTE.ink,
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: "-0.045em",
              marginTop: 10,
            }}
          >
            Ready to queue 1 welcome?
          </div>
        </div>
        <div style={{ alignItems: "flex-end", display: "flex", gap: 10 }}>
          <span style={{ ...mono, color: PALETTE.muted, fontSize: 8 }}>
            READY TO QUEUE
          </span>
          <MiniPill tone={committed ? "sage" : "copper"} active>
            {committed
              ? "Welcome queued"
              : validationProgress >= 1
                ? "Checks complete"
                : "Ready to confirm"}
          </MiniPill>
        </div>
      </div>
      <div
        style={{
          color: PALETTE.muted,
          fontSize: 13,
          lineHeight: 1.5,
          marginTop: 20,
          maxWidth: 650,
          position: "relative",
        }}
      >
        One audience, one template and one clear next step.
      </div>
      <div
        style={{
          display: "flex",
          gap: 11,
          marginTop: 26,
          position: "relative",
        }}
      >
        {confirmationDetails.map(([title, detail, proof], index) => {
          const checked = smooth(
            clamp01(validationProgress * confirmationDetails.length - index),
          );
          const checking = Math.sin(checked * Math.PI);
          return (
            <div
              key={title}
              style={{
                backgroundColor: checked > 0.86 ? "#eef5ee" : "#f5f3ed",
                border: `1px solid ${
                  checked > 0.08 ? "rgba(58, 95, 66, 0.24)" : PAPER_BORDER
                }`,
                borderRadius: 12,
                boxShadow:
                  checking > 0.05
                    ? `0 12px 28px rgba(55, 113, 83, ${checking * 0.12})`
                    : "none",
                flex: 1,
                padding: 14,
                transform: `translate3d(0, ${checking * -5}px, 0)`,
              }}
            >
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span style={{ ...label, color: PALETTE.muted, fontSize: 9 }}>
                  {title}
                </span>
                <span
                  style={{
                    color: PALETTE.sageDeep,
                    fontSize: 9,
                    fontWeight: 800,
                    opacity: checked,
                    transform: `translate3d(${(1 - checked) * 5}px, 0, 0)`,
                  }}
                >
                  ✓ {proof}
                </span>
              </div>
              <div
                style={{
                  color: PALETTE.ink,
                  fontSize: 12,
                  fontWeight: 750,
                  marginTop: 8,
                }}
              >
                {detail}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginTop: 26,
          position: "relative",
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: committed ? PALETTE.sageDeep : PALETTE.ink,
            borderRadius: 10,
            boxShadow: pressEnvelope
              ? `0 10px ${20 + pressEnvelope * 14}px rgba(19, 32, 31, ${0.15 + pressEnvelope * 0.12})`
              : "none",
            color: PALETTE.paper,
            display: "flex",
            fontSize: 13,
            fontWeight: 800,
            gap: 8,
            justifyContent: "center",
            minWidth: 278,
            padding: "13px 16px",
            transform: `scale(${1 - pressEnvelope * 0.035})`,
          }}
        >
          {committed
            ? "Welcome queued"
            : pressProgress > 0.42
              ? "Queuing welcome…"
              : "Confirm and queue welcome"}
          <span style={{ color: PALETTE.copperSoft }}>
            {committed ? "✓" : "↗"}
          </span>
        </div>
        <div
          style={{
            alignItems: "center",
            color: committed ? PALETTE.sageDeep : PALETTE.muted,
            display: "flex",
            fontSize: 10,
            fontWeight: 750,
            gap: 8,
          }}
        >
          <span
            style={{
              backgroundColor: committed ? PALETTE.sageDeep : PALETTE.copper,
              borderRadius: "50%",
              height: 6,
              width: 6,
            }}
          />
          {committed
            ? "Queue handoff complete"
            : `${Math.min(3, Math.ceil(validationProgress * 3))} / 3 checks`}
        </div>
      </div>
      <div
        aria-hidden
        style={{
          alignItems: "center",
          backgroundColor: PALETTE.copper,
          border: "2px solid rgba(255, 253, 248, 0.92)",
          borderRadius: "50%",
          boxShadow: "0 9px 22px rgba(19, 32, 31, 0.22)",
          color: PALETTE.paper,
          display: "flex",
          fontSize: 13,
          fontWeight: 900,
          height: 28,
          justifyContent: "center",
          left: interpolate(cursorProgress, [0, 1], [796, 234]),
          opacity: cursorOpacity,
          position: "absolute",
          top: interpolate(cursorProgress, [0, 1], [155, 267]),
          transform: `scale(${1 - pressEnvelope * 0.12})`,
          width: 28,
          zIndex: 4,
        }}
      >
        ↖
      </div>
    </div>
  );
}

function DeliveryState({
  active,
  motionPhase,
  progress,
}: {
  active: number;
  motionPhase: number;
  progress: number;
}) {
  const states = [
    ["Confirmed", "audience checked", "ready", "sage"],
    ["Queued", "welcome queued", "queue recorded", "copper"],
    ["Handoff", "accepted", "handoff recorded", "dark"],
    ["Result", "1 / 1 recorded", "message ready to inspect", "sage"],
  ] as const;
  const activeIndex = Math.min(states.length - 1, Math.max(0, active));
  const focusProgress = between(progress, 1, 0.08, 0.92);
  const ambientX = Math.sin(motionPhase * Math.PI * 10) * 3;
  const ambientY = Math.cos(motionPhase * Math.PI * 8) * 1.5;
  const driftCycle = (motionPhase * 12) % 1;
  const continuousDrift = interpolate(driftCycle, [0, 0.5, 1], [-8, 8, -8]);
  const sweepPhase = (motionPhase * 4) % 1;
  const sweepPosition = interpolate(sweepPhase, [0, 1], [-24, 108]);
  const cameraX = interpolate(focusProgress, [0, 0.52, 1], [0, -28, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cameraY = interpolate(focusProgress, [0, 1], [0, -4], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cameraScale = interpolate(
    focusProgress,
    [0, 0.52, 1],
    [1.03, 1.08, 1.02],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );
  return (
    <div
      style={{
        backgroundColor: "#fffdf8",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 20,
        boxShadow: "0 20px 54px rgba(19, 32, 31, 0.16)",
        left: 52,
        overflow: "hidden",
        padding: 24,
        position: "absolute",
        right: 32,
        top: 158,
        transform: `translate3d(0, ${(1 - between(progress, 1, 0, 0.25)) * 18}px, 0)`,
      }}
    >
      <div
        aria-hidden
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(143,191,154,0.2), rgba(246,197,169,0.28), transparent)",
          bottom: 0,
          left: `${sweepPosition}%`,
          mixBlendMode: "multiply",
          opacity: 0.32,
          pointerEvents: "none",
          position: "absolute",
          top: 0,
          transform: "skewX(-10deg)",
          width: 260,
          zIndex: 3,
        }}
      />
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ ...label, color: PALETTE.sageDeep, fontSize: 11 }}>
            Speaker welcome · delivery status
          </div>
          <div
            style={{
              color: PALETTE.ink,
              fontSize: 21,
              fontWeight: 800,
              letterSpacing: "-0.04em",
              marginTop: 7,
            }}
          >
            One welcome, visible from confirmation to result.
          </div>
        </div>
        <div
          style={{
            ...mono,
            color: PALETTE.sageDeep,
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          {activeIndex >= states.length - 1
            ? "RESULT RECORDED"
            : "DELIVERY IN PROGRESS"}
        </div>
      </div>
      <div
        style={{
          backgroundColor: "#ffffff",
          border: `1px solid ${PAPER_BORDER}`,
          borderRadius: 18,
          height: 244,
          marginTop: 22,
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            backgroundColor: "#f3f1eb",
            height: 1,
            left: 58,
            position: "absolute",
            right: 58,
            top: 122,
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 18,
            left: 42,
            position: "absolute",
            top: 54,
            transform: `translate3d(${cameraX + ambientX + continuousDrift}px, ${cameraY + ambientY}px, 0) scale(${cameraScale})`,
            transformOrigin: "left center",
          }}
        >
          {states.map(([state, detail, proof, tone], index) => {
            const done = index < activeIndex;
            const current = index === activeIndex;
            const isResult = state === "Result";
            const resultRecorded = isResult && activeIndex >= index;
            const visibleDetail = isResult
              ? resultRecorded
                ? detail
                : "0 / 1 recorded"
              : detail;
            const visibleState = resultRecorded
              ? "recorded"
              : done
                ? "recorded"
                : current
                  ? "current"
                  : "waiting";
            const emphasis = current ? 1 : 0.92;
            return (
              <div
                key={state}
                style={{
                  backgroundColor: "#fffdf8",
                  border: `1px solid ${
                    current
                      ? tone === "sage"
                        ? "rgba(55, 113, 83, 0.34)"
                        : "rgba(190, 98, 66, 0.34)"
                      : PAPER_BORDER
                  }`,
                  borderRadius: 14,
                  boxShadow: current
                    ? "0 22px 46px rgba(19, 32, 31, 0.14)"
                    : "0 9px 20px rgba(19, 32, 31, 0.04)",
                  flex: `0 0 ${218 * emphasis}px`,
                  minHeight: 128,
                  opacity: current || done ? 1 : 0.64,
                  padding: "16px 16px 14px",
                  transform: `translate3d(0, ${current ? -8 : done ? -3 : 0}px, 0)`,
                }}
              >
                <div
                  style={{
                    alignItems: "center",
                    color: done
                      ? PALETTE.sageDeep
                      : current
                        ? PALETTE.copperDeep
                        : PALETTE.muted,
                    display: "flex",
                    fontSize: 12,
                    fontWeight: 800,
                    gap: 7,
                  }}
                >
                  <span
                    style={{
                      backgroundColor: done
                        ? PALETTE.sageDeep
                        : current
                          ? PALETTE.copper
                          : "#b8beb8",
                      borderRadius: "50%",
                      height: 7,
                      width: 7,
                    }}
                  />
                  {state}
                </div>
                <div
                  style={{
                    color: PALETTE.ink,
                    fontSize: 14,
                    fontWeight: 780,
                    letterSpacing: "-0.02em",
                    marginTop: 9,
                  }}
                >
                  {visibleDetail}
                </div>
                <div
                  style={{
                    color: PALETTE.muted,
                    fontSize: 11,
                    lineHeight: 1.35,
                    marginTop: 8,
                  }}
                >
                  {proof}
                </div>
                <div
                  style={{
                    color:
                      tone === "dark"
                        ? PALETTE.ink
                        : tone === "copper"
                          ? PALETTE.copperDeep
                          : PALETTE.sageDeep,
                    fontSize: 11,
                    fontWeight: 750,
                    marginTop: 8,
                    textTransform: "uppercase",
                  }}
                >
                  {visibleState}
                </div>
              </div>
            );
          })}
        </div>
        <div
          style={{
            ...mono,
            backgroundColor: "#fffdf8",
            border: `1px solid ${PAPER_BORDER}`,
            borderRadius: 999,
            bottom: 16,
            color: PALETTE.ink,
            fontSize: 11,
            fontWeight: 800,
            left: 22,
            padding: "8px 10px",
            position: "absolute",
          }}
        >
          TRACKED DELIVERY TIMELINE
        </div>
        <div
          aria-hidden
          style={{
            background:
              "linear-gradient(90deg, rgba(143,191,154,0.28), rgba(190,98,66,0.74))",
            bottom: 0,
            height: 3,
            left: 0,
            position: "absolute",
            width: `${clamp01(motionPhase) * 100}%`,
          }}
        />
      </div>
      <div
        style={{
          alignItems: "center",
          color: PALETTE.muted,
          display: "flex",
          fontSize: 11,
          gap: 9,
          marginTop: 17,
        }}
      >
        <span
          style={{
            backgroundColor: PALETTE.sage,
            borderRadius: "50%",
            height: 7,
            width: 7,
          }}
        />
        Confirmation and handoff result stay recorded.
      </div>
    </div>
  );
}

function CalendarLifecycle({ progress }: { progress: number }) {
  const states = ["Drafted", "Stable UID", "Queued", "Handoff ready"] as const;
  const active = Math.min(
    states.length - 1,
    Math.floor(clamp01(progress) * states.length),
  );
  return (
    <div
      style={{
        backgroundColor: "#f2f0e9",
        border: `1px solid ${PAPER_BORDER}`,
        borderRadius: 16,
        bottom: 27,
        left: 35,
        padding: "14px 16px 13px",
        position: "absolute",
        right: 35,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
          <div
            style={{
              alignItems: "center",
              backgroundColor: PALETTE.ink,
              borderRadius: 9,
              color: PALETTE.paper,
              display: "flex",
              fontSize: 14,
              height: 28,
              justifyContent: "center",
              width: 28,
            }}
          >
            ⌁
          </div>
          <div>
            <div style={{ color: PALETTE.ink, fontSize: 12, fontWeight: 800 }}>
              Calendar invite lifecycle
            </div>
            <div style={{ color: PALETTE.muted, fontSize: 10, marginTop: 3 }}>
              Stable UID · queued for handoff
            </div>
          </div>
        </div>
        <MiniPill
          tone={active === states.length - 1 ? "sage" : "copper"}
          active
        >
          {states[active]}
        </MiniPill>
      </div>
      <div style={{ alignItems: "center", display: "flex", marginTop: 13 }}>
        {states.map((state, index) => (
          <div
            key={state}
            style={{
              alignItems: "center",
              display: "flex",
              flex: index === states.length - 1 ? "0 0 auto" : 1,
            }}
          >
            <span
              style={{
                backgroundColor: index <= active ? PALETTE.sageDeep : "#b7beb8",
                borderRadius: "50%",
                height: 6,
                width: 6,
              }}
            />
            <span
              style={{
                color: index <= active ? PALETTE.sageDeep : PALETTE.muted,
                fontSize: 11,
                fontWeight: index === active ? 800 : 600,
                marginLeft: 6,
              }}
            >
              {state}
            </span>
            {index < states.length - 1 ? (
              <div
                style={{
                  backgroundColor:
                    index < active ? PALETTE.sage : "rgba(24, 37, 34, 0.14)",
                  height: 1,
                  margin: "0 9px",
                  flex: 1,
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CommunicateScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = at(frame, duration);
  const previewCenter = 0.1975;
  const confirmCenter = 0.4075;
  const deliveryCenter = 0.6075;
  const activeStep =
    progress < 0.18
      ? 0
      : progress < 0.39
        ? 1
        : progress < 0.55
          ? 2
          : progress < 0.72
            ? 3
            : progress < 0.86
              ? 4
              : 5;
  const composeOpacity = cleanShotExit(frame, duration, previewCenter);
  const previewOpacity =
    cleanShotEnter(frame, duration, previewCenter) *
    cleanShotExit(frame, duration, confirmCenter);
  const confirmOpacity =
    cleanShotEnter(frame, duration, confirmCenter) *
    cleanShotExit(frame, duration, deliveryCenter);
  const deliveryOpacity = cleanShotEnter(frame, duration, deliveryCenter);
  const composeProgress = between(frame, duration, 0, 0.2);
  const previewProgress = between(frame, duration, 0.2, 0.41);
  const confirmProgress = between(frame, duration, 0.41, 0.61);
  const calendarProgress = between(frame, duration, 0.61, 0.98);
  const deliveryProgress = between(frame, duration, 0.55, 0.98);

  return (
    <AbsoluteFill
      style={{
        ...sceneBackground,
        backgroundImage:
          "radial-gradient(circle at 18% 9%, rgba(143, 191, 154, 0.15), transparent 27%), radial-gradient(circle at 86% 82%, rgba(190, 98, 66, 0.18), transparent 32%), linear-gradient(135deg, #0b1413 0%, #102321 48%, #0b1413 100%)",
      }}
    >
      <Grain />
      <TopBar
        chapter="Communicate"
        chapterNumber="09 / 13"
        roleLabel="ORGANISER · DELIVERY WORKFLOW"
      />
      <div
        style={{
          bottom: 44,
          left: 74,
          position: "absolute",
          top: 126,
          width: 385,
          zIndex: 2,
        }}
      >
        <Eyebrow>Communicate / delivery status</Eyebrow>
        <h1
          style={{
            color: PALETTE.paper,
            fontSize: 50,
            fontWeight: 780,
            letterSpacing: "-0.065em",
            lineHeight: 0.98,
            margin: "20px 0 0",
            maxWidth: 390,
          }}
        >
          The right message.
          <br />
          The right person.
          <br />
          <span style={{ color: PALETTE.copperSoft }}>The whole story.</span>
        </h1>
        <p
          style={{
            color: WHITE_72,
            fontSize: 16,
            lineHeight: 1.52,
            margin: "22px 0 0",
            maxWidth: 340,
          }}
        >
          Version, personalise, confirm and follow every delivery from one
          place.
        </p>
        <div
          style={{
            backgroundColor: "rgba(255, 253, 248, 0.07)",
            border: `1px solid ${BORDER_GLASS}`,
            borderRadius: 15,
            marginTop: 35,
            padding: "15px 16px",
          }}
        >
          <div style={{ ...label, color: PALETTE.copperSoft, fontSize: 9 }}>
            Communication you can follow
          </div>
          <div
            style={{
              color: WHITE_92,
              fontSize: 14,
              fontWeight: 700,
              lineHeight: 1.35,
              marginTop: 9,
            }}
          >
            Every message keeps its audience, approval and recorded result
            together.
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            bottom: 0,
            color: WHITE_56,
            display: "flex",
            fontSize: 12,
            gap: 9,
            left: 0,
            position: "absolute",
          }}
        >
          <span
            style={{
              backgroundColor: PALETTE.sage,
              borderRadius: "50%",
              height: 7,
              width: 7,
            }}
          />
          Organiser view · audience, approval and result together
        </div>
      </div>
      <div
        style={{
          backgroundColor: PALETTE.canvas,
          border: `1px solid ${BORDER_GLASS}`,
          borderRadius: 28,
          bottom: 42,
          boxShadow: "0 30px 90px rgba(0, 0, 0, 0.25)",
          left: 523,
          overflow: "hidden",
          position: "absolute",
          right: 74,
          top: 126,
        }}
      >
        <StageHeader
          eyebrow="Communications / Future of Events 2027"
          title="Trace delivery status."
          detail="Speaker welcome · versioned, confirmed and tracked."
          status={
            activeStep === 5
              ? "Result recorded"
              : activeStep === 4
                ? "Handoff"
                : activeStep === 3
                  ? "Queued"
                  : activeStep === 2
                    ? progress < 0.41
                      ? "Preview checked"
                      : "Ready to confirm"
                    : activeStep === 1
                      ? "Previewing"
                      : "Draft"
          }
        />
        <CommunicationRail active={activeStep} />
        <div
          style={{
            backgroundColor: "rgba(24, 37, 34, 0.10)",
            height: 1,
            left: 30,
            position: "absolute",
            right: 30,
            top: 153,
          }}
        />

        <div
          style={{
            ...visible(composeOpacity, (1 - composeOpacity) * 16),
            inset: 0,
            position: "absolute",
          }}
        >
          <BrowserFrame
            src={ASSETS.communications}
            width={802}
            height={453}
            label="app.programcue.com / communications"
            objectPosition="center top"
            style={{
              left: 58,
              position: "absolute",
              top: 177,
              transform: `translate3d(${interpolate(composeProgress, [0, 1], [6, -8])}px, ${interpolate(composeProgress, [0, 1], [4, -5])}px, 0) scale(${interpolate(composeProgress, [0, 1], [1, 1.012])})`,
              transformOrigin: "left top",
            }}
          />
          <ComposeOverlay progress={between(frame, duration, 0, 0.18)} />
          <div
            style={{
              ...label,
              color: PALETTE.muted,
              fontSize: 9,
              position: "absolute",
              right: 68,
              top: 196,
            }}
          >
            ORGANISER · AUTHORING
          </div>
          <div
            style={{
              color: PALETTE.ink,
              fontSize: 18,
              fontWeight: 780,
              left: 869,
              lineHeight: 1.16,
              position: "absolute",
              top: 221,
              width: 250,
            }}
          >
            Build a versioned welcome.
          </div>
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 12,
              left: 869,
              lineHeight: 1.45,
              position: "absolute",
              top: 281,
              width: 235,
            }}
          >
            Refine the message, sender details and audience rules.
          </div>
        </div>

        <div
          style={{
            ...visible(previewOpacity, (1 - previewOpacity) * 16),
            inset: 0,
            position: "absolute",
          }}
        >
          <div
            style={{
              left: 75,
              position: "absolute",
              top: 177,
              transform: `translate3d(${interpolate(previewProgress, [0, 1], [7, -9])}px, ${interpolate(previewProgress, [0, 1], [4, -5])}px, 0) scale(${interpolate(previewProgress, [0, 1], [1, 1.014])})`,
              transformOrigin: "left top",
            }}
          >
            <BrowserFrame
              src={ASSETS.communications}
              width={696}
              height={432}
              label="speaker welcome / personalised preview"
              objectPosition="right 29%"
              imageScale={1.1}
              imageOrigin="right 29%"
            />
          </div>
          <PreviewOverlay progress={between(frame, duration, 0.18, 0.39)} />
        </div>

        <div
          style={{
            ...visible(confirmOpacity, (1 - confirmOpacity) * 16),
            inset: 0,
            position: "absolute",
          }}
        >
          <ConfirmationCard progress={confirmProgress} />
          <div
            style={{
              color: PALETTE.muted,
              fontSize: 12,
              left: 119,
              position: "absolute",
              top: 504,
            }}
          >
            Audience checked · template versioned · ready to queue
          </div>
        </div>

        <div
          style={{
            ...visible(deliveryOpacity, (1 - deliveryOpacity) * 16),
            inset: 0,
            position: "absolute",
          }}
        >
          <DeliveryState
            active={Math.max(0, activeStep - 2)}
            motionPhase={progress}
            progress={deliveryProgress}
          />
          <CalendarLifecycle progress={calendarProgress} />
        </div>

        {[
          { center: previewCenter, from: "Compose", to: "Preview" },
          { center: confirmCenter, from: "Preview", to: "Confirm" },
          { center: deliveryCenter, from: "Confirm", to: "Queued" },
        ].map(({ center, from, to }) => (
          <StateHandoff
            key={center}
            fromLabel={from}
            progress={between(frame, duration, center - 0.011, center + 0.011)}
            toLabel={to}
            top={153}
          />
        ))}

        <div
          style={{
            alignItems: "center",
            bottom: 15,
            display: "flex",
            left: 35,
            position: "absolute",
            right: 35,
            zIndex: 3,
          }}
        >
          <div style={{ color: PALETTE.muted, fontSize: 11 }}>
            DELIVERY LEDGER
          </div>
          <div
            style={{
              backgroundColor: "rgba(24, 37, 34, 0.13)",
              height: 1,
              margin: "0 13px",
              flex: 1,
            }}
          />
          <div style={{ color: PALETTE.muted, fontSize: 11 }}>
            speaker welcome · confirmation · delivery status
          </div>
        </div>
      </div>
      <div
        style={{
          ...mono,
          bottom: 17,
          color: "rgba(255, 253, 248, 0.28)",
          fontSize: 9,
          position: "absolute",
          right: 74,
        }}
      >
        PROGRAM CUE / COMMUNICATE / 2027
      </div>
    </AbsoluteFill>
  );
}
