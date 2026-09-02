import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { ASSETS } from "../assets";

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
  smooth,
  TopBar,
  visible,
  WHITE_56,
  WHITE_72,
  WHITE_92,
} from "./PrepareCommunicateSceneShared";

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
