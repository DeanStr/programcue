import type { CSSProperties } from "react";

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
import {
  at,
  BORDER_GLASS,
  BrowserFrame,
  between,
  clamp01,
  cleanShotEnter,
  cleanShotExit,
  Eyebrow,
  Grain,
  label,
  MiniPill,
  mono,
  PAPER_BORDER,
  type SceneProps,
  StageHeader,
  StateHandoff,
  sceneBackground,
  screenShadow,
  smooth,
  TopBar,
  visible,
  WHITE_56,
  WHITE_72,
  WHITE_92,
} from "./PrepareCommunicateSceneShared";

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
            Preparation in view
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
          <span style={{ color: PALETTE.copperSoft }}>into momentum.</span>
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
          items={["Accepted", "Linked", "In progress", "In view"]}
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
              ? "In view"
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
          { center: readyCenter, from: "Tasks active", to: "In view" },
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
