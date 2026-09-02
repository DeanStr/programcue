import type { ReactNode } from "react";

import {
  AbsoluteFill,
  interpolate,
  interpolateColors,
  useCurrentFrame,
} from "remotion";

import { ASSETS } from "../assets";

import { PALETTE } from "../constants";
import {
  Arrow,
  AssetWindow,
  after,
  Check,
  Chip,
  clamp,
  copper,
  copperText,
  cut,
  DotGrid,
  deep,
  Eyebrow,
  ease,
  FooterRail,
  frameProgress,
  ink,
  line,
  local,
  Metric,
  muted,
  paper,
  Reveal,
  SceneHeader,
  type SceneProps,
  sage,
} from "./PlacePublishOperateSceneShared";

function CodeLine({
  children,
  dim = false,
  focus = 0,
  number,
  cursor = 0,
}: {
  children: ReactNode;
  dim?: boolean;
  focus?: number;
  number: string;
  cursor?: number;
}) {
  const focusAmount = clamp(focus);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        minHeight: 28,
        alignItems: "center",
        padding: "0 17px",
        background: `rgba(143,191,154,${focusAmount * 0.11})`,
        borderLeft: `2px solid rgba(143,191,154,${focusAmount})`,
        color: dim ? "rgba(255,253,248,.36)" : "rgba(255,253,248,.83)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        transform: `translate3d(${interpolate(focusAmount, [0, 1], [0, 3])}px, 0, 0)`,
        whiteSpace: "pre",
      }}
    >
      <span
        style={{
          width: 29,
          color: "rgba(255,253,248,.25)",
          fontSize: 10,
          userSelect: "none",
        }}
      >
        {number}
      </span>
      <span>{children}</span>
      <span
        style={{
          width: 6,
          height: 15,
          marginLeft: 4,
          borderRadius: 1,
          background: sage,
          boxShadow: "0 0 12px rgba(143,191,154,.52)",
          opacity: focusAmount * cursor,
        }}
      />
    </div>
  );
}

function Syntax({
  children,
  color = "#d6a8ff",
}: {
  children: ReactNode;
  color?: string;
}) {
  return <span style={{ color }}>{children}</span>;
}

function ApiConsole({ progress }: { progress: number }) {
  const endpoints = [
    ["GET", "/api/v1/public/events/{slug}/programme"],
    ["POST", "/api/v1/events/{eventId}/schedule/publish"],
    ["GET", "/api/v1/events/{eventId}/operations"],
    ["POST", "/api/webhooks/file-scanner"],
  ];
  const focusLine = interpolate(
    progress,
    [0, 0.14, 0.28, 0.45, 0.61, 0.76, 0.9, 1],
    [1, 1, 3, 5, 6, 7, 8, 8],
  );
  const codeScroll = interpolate(progress, [0, 1], [4, -72]);
  const cursor = interpolate(
    Math.sin(progress * Math.PI * 18),
    [-1, 1],
    [0.2, 1],
  );
  const scanY = interpolate(progress, [0, 1], [-60, 236]);
  const endpointFocus = interpolate(
    ease(local(progress, 0.54, 1)),
    [0, 1],
    [1, 2],
  );
  const lineFocus = (index: number) => clamp(1 - Math.abs(focusLine - index));
  return (
    <div
      style={{
        width: 760,
        borderRadius: 22,
        overflow: "hidden",
        background: "#111d1b",
        border: "1px solid rgba(255,255,255,.16)",
        boxShadow: "0 28px 90px rgba(0,0,0,.4)",
      }}
    >
      <div
        style={{
          height: 47,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 17px",
          borderBottom: "1px solid rgba(255,255,255,.12)",
          background: "rgba(255,255,255,.045)",
        }}
      >
        <span style={{ display: "flex", gap: 5 }}>
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#ff766a",
            }}
          />
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: PALETTE.gold,
            }}
          />
          <i
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: sage,
            }}
          />
        </span>
        <span
          style={{
            color: "rgba(255,253,248,.62)",
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: "0.1em",
          }}
        >
          PROGRAM CUE API / DOCUMENTED CONTRACT
        </span>
        <Chip tone="good" dark>
          OpenAPI
        </Chip>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginLeft: "auto",
            color: "rgba(255,253,248,.46)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: sage,
              boxShadow: "0 0 12px rgba(143,191,154,.6)",
              opacity: interpolate(cursor, [0.2, 1], [0.48, 1]),
            }}
          />
          CONTRACT / INSPECT
        </div>
      </div>
      <div
        style={{
          position: "relative",
          height: 196,
          overflow: "hidden",
          borderBottom: "1px solid rgba(255,255,255,.11)",
        }}
      >
        <div
          style={{
            padding: "17px 0 14px",
            transform: `translate3d(0, ${codeScroll}px, 0)`,
          }}
        >
          <CodeLine dim focus={lineFocus(0)} cursor={cursor} number="01">
            {"// inspect the schedule publication contract"}
          </CodeLine>
          <CodeLine focus={lineFocus(1)} cursor={cursor} number="02">
            <Syntax color="#8fbf9a">POST</Syntax> /api/v1/events/{`{eventId}`}
            /schedule/publish
          </CodeLine>
          <CodeLine dim focus={lineFocus(2)} cursor={cursor} number="03">
            {"// required API key scope: "}
            <Syntax color="#f5ca8e">schedule:publish</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(3)} cursor={cursor} number="04">
            Idempotency-Key:{" "}
            <Syntax color="#f6c5a9">publish-schedule-001</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(4)} cursor={cursor} number="05">
            {`{`}
          </CodeLine>
          <CodeLine focus={lineFocus(5)} cursor={cursor} number="06">
            {"  "}"scheduleVersionId":{" "}
            <Syntax color="#f6c5a9">"&lt;draft-schedule-version-id&gt;"</Syntax>
            ,
          </CodeLine>
          <CodeLine focus={lineFocus(6)} cursor={cursor} number="07">
            {"  "}"scheduleRevision": <Syntax color="#f5ca8e">1</Syntax>
          </CodeLine>
          <CodeLine focus={lineFocus(7)} cursor={cursor} number="08">
            {`}`}
          </CodeLine>
          <CodeLine dim focus={lineFocus(8)} cursor={cursor} number="09">
            {"// blocking conflicts recalculated before commit"}
          </CodeLine>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: scanY,
            height: 60,
            background:
              "linear-gradient(180deg, transparent, rgba(143,191,154,.085), transparent)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 11,
            padding: "5px 8px",
            borderRadius: 999,
            background: "rgba(11,20,19,.88)",
            border: "1px solid rgba(212,167,44,.28)",
            color: "#f5ca8e",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 8,
            fontWeight: 850,
            letterSpacing: "0.08em",
          }}
        >
          CONTRACT PREVIEW
        </div>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 7,
          padding: "15px 17px 19px",
        }}
      >
        {endpoints.map(([method, path], index) => (
          <div
            key={path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "rgba(255,253,248,.62)",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 10,
              opacity: interpolate(
                clamp(1 - Math.abs(endpointFocus - index)),
                [0, 1],
                [0.56, 1],
              ),
              transform: `translate3d(${interpolate(
                clamp(1 - Math.abs(endpointFocus - index)),
                [0, 1],
                [0, 4],
              )}px, 0, 0)`,
            }}
          >
            <span
              style={{
                width: 48,
                color:
                  method === "GET"
                    ? sage
                    : method === "POST"
                      ? copper
                      : PALETTE.gold,
                fontWeight: 900,
              }}
            >
              {method}
            </span>
            <span>{path}</span>
            <span
              style={{ marginLeft: "auto", color: "rgba(255,253,248,.32)" }}
            >
              {index === 3 ? "webhook" : "REST"}
            </span>
          </div>
        ))}
        <div
          style={{
            marginTop: 7,
            color: "rgba(255,253,248,.4)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
          }}
        >
          + 29 more entries · 33 documented API paths
        </div>
      </div>
    </div>
  );
}

function TrailStatus({
  from,
  progress,
  to,
  tone,
}: {
  from: string;
  progress: number;
  to: string;
  tone: string;
}) {
  const swap = ease(local(progress, 0.38, 0.86));
  return (
    <div
      style={{
        position: "relative",
        width: 112,
        height: 27,
        overflow: "hidden",
        borderRadius: 999,
        border: `1px solid ${interpolateColors(swap, [0, 1], [line, tone])}`,
        background: interpolateColors(
          swap,
          [0, 1],
          ["rgba(24,37,34,.04)", `${tone}18`],
        ),
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: "0.08em",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          color: muted,
          opacity: 1 - swap,
          transform: `translate3d(0, ${interpolate(swap, [0, 1], [0, -8])}px, 0)`,
        }}
      >
        {from}
      </span>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
          color: tone,
          opacity: swap,
          transform: `translate3d(0, ${interpolate(swap, [0, 1], [8, 0])}px, 0)`,
        }}
      >
        {to}
      </span>
    </div>
  );
}

function OperationCentreProgress({ progress }: { progress: number }) {
  const rows = [
    {
      id: "STEP 01",
      operation: "Assistant reminder",
      from: "APPROVED",
      to: "QUEUED",
      detail: "1 recipient · approval recorded",
      tone: sage,
      window: [0.02, 0.2],
    },
    {
      id: "STEP 02",
      operation: "Reminder delivery",
      from: "QUEUED",
      to: "RUNNING",
      detail: "delivery attempt started",
      tone: copper,
      window: [0.16, 0.36],
    },
    {
      id: "STEP 03",
      operation: "Recipient result",
      from: "RUNNING",
      to: "FAILED",
      detail: "delivery attempt failed",
      tone: PALETTE.gold,
      window: [0.3, 0.5],
    },
    {
      id: "STEP 04",
      operation: "Operation recovery",
      from: "FAILED",
      to: "READY",
      detail: "original audience preserved",
      tone: sage,
      window: [0.44, 0.62],
    },
  ] as const;
  const evidenceProgress = local(progress, 0.02, 0.72);
  const evidenceSweepX = interpolate(progress, [0, 1], [-5, 86]);
  const recordedCount = rows.filter(
    (row) => ease(local(progress, row.window[0], row.window[1])) >= 0.74,
  ).length;
  return (
    <div
      style={{
        position: "relative",
        width: 670,
        overflow: "hidden",
        borderRadius: 22,
        padding: 23,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 28px 90px rgba(0,0,0,.25)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -80,
          bottom: -80,
          left: `${evidenceSweepX}%`,
          width: 130,
          background:
            "linear-gradient(90deg, transparent, rgba(190,98,66,.09), transparent)",
          transform: "skewX(-12deg)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 18,
        }}
      >
        <div>
          <div
            style={{ fontSize: 21, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Unified Operation Centre
          </div>
          <div style={{ color: muted, fontSize: 13, marginTop: 4 }}>
            One reminder, tracked from approval to recorded result.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 7,
          }}
        >
          <Chip tone="copper">OPERATION RECOVERY</Chip>
          <div
            style={{
              color: muted,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 9,
              fontWeight: 900,
              letterSpacing: "0.1em",
            }}
          >
            PROGRESS {String(recordedCount).padStart(2, "0")} / 04
          </div>
        </div>
      </div>
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 29,
            bottom: 29,
            width: 2,
            borderRadius: 999,
            background: line,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 13,
            top: 29,
            bottom: 29,
            width: 2,
            borderRadius: 999,
            background: `linear-gradient(180deg, ${sage}, ${copper})`,
            boxShadow: "0 0 14px rgba(143,191,154,.35)",
            transform: `scaleY(${evidenceProgress})`,
            transformOrigin: "top center",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 9,
            top: interpolate(evidenceProgress, [0, 1], [29, 205]),
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: interpolateColors(
              evidenceProgress,
              [0, 1],
              [sage, copper],
            ),
            boxShadow: "0 0 0 5px rgba(143,191,154,.12)",
            opacity: interpolate(evidenceProgress, [0, 0.04, 1], [0, 1, 1]),
            transform: "translateY(-50%)",
          }}
        />
        {rows.map((row, index) => {
          const rowProgress = ease(
            local(progress, row.window[0], row.window[1]),
          );
          const nodePulse = interpolate(
            Math.sin(rowProgress * Math.PI),
            [0, 1],
            [1, 1.14],
          );
          return (
            <div
              key={row.id}
              style={{
                display: "grid",
                gridTemplateColumns: "30px 82px minmax(0, 1fr) 112px",
                minHeight: 59,
                alignItems: "center",
                gap: 10,
                borderTop: `1px solid ${line}`,
                opacity: interpolate(rowProgress, [0, 1], [0.28, 1]),
                transform: `translate3d(${interpolate(
                  rowProgress,
                  [0, 1],
                  [10, 0],
                )}px, 0, 0)`,
              }}
            >
              <div
                style={{
                  position: "relative",
                  zIndex: 2,
                  width: 27,
                  height: 27,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  border: `1px solid ${interpolateColors(
                    rowProgress,
                    [0, 1],
                    [line, row.tone],
                  )}`,
                  background: paper,
                  color: row.tone,
                  fontSize: 10,
                  fontWeight: 900,
                  transform: `scale(${nodePulse})`,
                }}
              >
                {rowProgress >= 0.74 ? "✓" : String(index + 1)}
              </div>
              <div
                style={{
                  color: muted,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 9,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                }}
              >
                {row.id}
              </div>
              <div>
                <div style={{ color: ink, fontSize: 14, fontWeight: 800 }}>
                  {row.operation}
                </div>
                <div style={{ color: muted, fontSize: 11, marginTop: 3 }}>
                  {row.detail}
                </div>
              </div>
              <TrailStatus
                from={row.from}
                progress={rowProgress}
                to={row.to}
                tone={row.tone}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: "relative",
          height: 3,
          marginTop: 12,
          overflow: "hidden",
          borderRadius: 999,
          background: "rgba(24,37,34,.08)",
        }}
      >
        <div
          style={{
            width: `${evidenceProgress * 100}%`,
            height: "100%",
            borderRadius: 999,
            background: `linear-gradient(90deg, ${sage}, ${copper})`,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginTop: 12,
          paddingTop: 12,
          borderTop: `1px solid ${line}`,
          color: muted,
          fontSize: 12,
          fontWeight: 750,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: sage,
            boxShadow: `0 0 ${interpolate(evidenceProgress, [0, 1], [0, 12])}px rgba(143,191,154,.42)`,
          }}
        />{" "}
        Queued → Running → Failed · ready to retry
      </div>
    </div>
  );
}

function OperationCentreDetail({ progress }: { progress: number }) {
  const steps = [
    {
      label: "QUEUED",
      detail: "Speaker task reminder",
      boundary: "APPROVED · 1 RECIPIENT",
      tone: sage,
      icon: "01",
    },
    {
      label: "FAILED",
      detail: "1 delivery needs attention",
      boundary: "FAILED · RESULT RECORDED",
      tone: PALETTE.gold,
      icon: "02",
    },
    {
      label: "RETRY",
      detail: "Retry failed operation",
      boundary: "ORIGINAL AUDIENCE PRESERVED",
      tone: copper,
      icon: "03",
    },
  ];
  const flowPosition = interpolate(
    ease(local(progress, 0.06, 0.72)),
    [0, 1],
    [0, 1.94],
  );
  const connectorProgress = [
    ease(local(progress, 0.2, 0.42)),
    ease(local(progress, 0.46, 0.68)),
  ];
  const boundaryFocus = ease(local(progress, 0.56, 0.74));
  const retryFocus = ease(local(progress, 0.5, 0.7));
  const retryCursor = ease(local(progress, 0.48, 0.72));
  const retryPress = clamp(
    ease(local(progress, 0.72, 0.78)) - ease(local(progress, 0.78, 0.84)),
  );
  const cursorOpacity =
    ease(local(progress, 0.42, 0.5)) * (1 - ease(local(progress, 0.84, 0.91)));
  return (
    <div
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: 1280,
        padding: 32,
        borderRadius: 24,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 32px 100px rgba(0,0,0,.28)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 23,
        }}
      >
        <div>
          <div
            style={{ fontSize: 22, fontWeight: 850, letterSpacing: "-0.04em" }}
          >
            Assistant reminder recovery
          </div>
          <div style={{ color: muted, fontSize: 13, marginTop: 4 }}>
            The one-recipient operation is ready to retry with its original
            audience.
          </div>
        </div>
        <Chip tone="copper">OPERATION RECOVERY</Chip>
      </div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 14 }}>
        {steps.map((step, index) => {
          const stepFocus = clamp(1 - Math.abs(flowPosition - index));
          return (
            <div
              key={step.label}
              style={{
                display: "flex",
                alignItems: "center",
                flex: 1,
                gap: 14,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  flex: 1,
                  minHeight: 138,
                  padding: 20,
                  borderRadius: 16,
                  border: `1px solid ${interpolateColors(
                    stepFocus,
                    [0, 1],
                    [line, step.tone],
                  )}`,
                  background: interpolateColors(
                    stepFocus,
                    [0, 1],
                    ["rgba(24,37,34,.025)", `${step.tone}12`],
                  ),
                  boxShadow:
                    index === 2
                      ? `0 18px ${interpolate(
                          retryFocus,
                          [0, 1],
                          [0, 38],
                        )}px rgba(190,98,66,.14), inset 0 0 ${interpolate(
                          boundaryFocus,
                          [0, 1],
                          [0, 26],
                        )}px rgba(212,167,44,.08)`
                      : undefined,
                  transform: `translate3d(0, ${interpolate(
                    stepFocus,
                    [0, 1],
                    [0, index === 2 ? -7 : -3],
                  )}px, ${index === 2 ? interpolate(retryFocus, [0, 1], [0, 12]) : 0}px)`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 9,
                      display: "grid",
                      placeItems: "center",
                      background: step.tone,
                      color: step.tone === PALETTE.gold ? ink : paper,
                      fontSize: 11,
                      fontWeight: 900,
                      boxShadow: `0 0 0 ${interpolate(
                        stepFocus,
                        [0, 1],
                        [0, 5],
                      )}px ${step.tone}18`,
                    }}
                  >
                    {step.icon}
                  </span>
                  <span
                    style={{
                      color:
                        step.tone === PALETTE.gold
                          ? "#806315"
                          : step.tone === copper
                            ? copperText
                            : step.tone,
                      fontSize: 11,
                      fontWeight: 900,
                      letterSpacing: "0.12em",
                    }}
                  >
                    {step.label}
                  </span>
                </div>
                <div
                  style={{
                    color: ink,
                    fontSize: 17,
                    fontWeight: 800,
                    marginTop: 22,
                  }}
                >
                  {step.detail}
                </div>
                <div
                  style={{
                    color:
                      step.tone === PALETTE.gold
                        ? "#806315"
                        : step.tone === copper
                          ? copperText
                          : step.tone,
                    fontSize: 10,
                    fontWeight: 900,
                    letterSpacing: "0.11em",
                    marginTop: 9,
                  }}
                >
                  {step.boundary}
                </div>
              </div>
              {index < steps.length - 1 ? (
                <div
                  style={{
                    width: 92,
                    flexShrink: 0,
                    overflow: "hidden",
                    clipPath: `inset(0 ${100 - connectorProgress[index] * 100}% 0 0)`,
                  }}
                >
                  <Arrow color={step.tone} long />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginTop: 20,
          padding: "12px 14px",
          borderRadius: 13,
          background: interpolateColors(
            boundaryFocus,
            [0, 1],
            ["rgba(24,37,34,.045)", "rgba(212,167,44,.075)"],
          ),
          color: muted,
          fontSize: 13,
          fontWeight: 750,
        }}
      >
        <span style={{ color: copperText, fontWeight: 900 }}>
          ONE RECIPIENT · FAILED OPERATION
        </span>
        <span
          style={{
            marginLeft: "auto",
            padding: "8px 11px",
            borderRadius: 10,
            border: `1px solid ${interpolateColors(retryFocus, [0, 1], ["rgba(190,98,66,.08)", "rgba(190,98,66,.42)"])}`,
            background: interpolateColors(
              retryFocus,
              [0, 1],
              ["rgba(190,98,66,0)", "rgba(190,98,66,.12)"],
            ),
            color: copperText,
            fontWeight: 900,
            boxShadow: `0 10px ${interpolate(retryFocus, [0, 1], [0, 28])}px rgba(190,98,66,.16)`,
            transform: `translate3d(0, ${interpolate(retryFocus, [0, 1], [2, -2])}px, 0)`,
          }}
        >
          RETRY OPERATION · OPEN AUDIT ↗
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: interpolate(retryCursor, [0, 1], [1308, 1182]),
          top: interpolate(retryCursor, [0, 1], [188, 286]),
          zIndex: 8,
          opacity: cursorOpacity,
          transform: `rotate(-10deg) scale(${interpolate(retryPress, [0, 1], [1, 0.86])})`,
          filter: "drop-shadow(0 4px 6px rgba(0,0,0,.28))",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: 22,
            height: 30,
            background: deep,
            clipPath: "polygon(0 0, 100% 67%, 60% 71%, 49% 100%)",
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 1186,
          top: 290,
          width: 52,
          height: 52,
          zIndex: 7,
          borderRadius: "50%",
          border: "2px solid rgba(190,98,66,.62)",
          opacity: retryPress,
          boxShadow: "0 0 34px rgba(190,98,66,.22)",
          transform: `translate(-50%, -50%) scale(${interpolate(retryPress, [0, 1], [0.38, 1.48])})`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function ProviderPreview({ progress }: { progress: number }) {
  const steps = [
    {
      label: "Programme",
      status: "CHECKED",
      tone: muted,
    },
    {
      label: "Speakers & rooms",
      status: "INCLUDED",
      tone: copper,
    },
    {
      label: "Export package",
      status: "READY",
      tone: sage,
    },
  ];
  const previewProgress = interpolate(
    ease(local(progress, 0.04, 0.94)),
    [0, 1],
    [0, 0.64],
  );
  const activeStep = interpolate(
    ease(local(progress, 0.06, 0.9)),
    [0, 1],
    [0, 2],
  );
  const boundaryPulse = interpolate(
    Math.sin(progress * Math.PI * 8),
    [-1, 1],
    [0, 1],
  );
  const scanX = interpolate(progress, [0, 1], [-38, 138]);
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: 1340,
        borderRadius: 28,
        padding: 38,
        background: "rgba(255,253,248,.97)",
        color: ink,
        border: `1px solid ${line}`,
        boxShadow: "0 32px 100px rgba(0,0,0,.32)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              display: "grid",
              placeItems: "center",
              background: "#183d59",
              color: paper,
              fontSize: 22,
              fontWeight: 900,
            }}
          >
            a
          </div>
          <div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 850,
                letterSpacing: "-0.04em",
              }}
            >
              Accelevents export preview
            </div>
            <div style={{ color: muted, fontSize: 13, marginTop: 5 }}>
              Published programme fields mapped in one place
            </div>
          </div>
        </div>
        <Chip tone="good">READY TO EXPORT</Chip>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.08fr .92fr",
          gap: 16,
        }}
      >
        <div
          style={{
            position: "relative",
            overflow: "hidden",
            padding: 26,
            borderRadius: 18,
            border: `1px solid ${line}`,
            background: "#fff",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -40,
              bottom: -40,
              left: `${scanX}%`,
              width: 72,
              background:
                "linear-gradient(90deg, transparent, rgba(143,191,154,.09), transparent)",
              transform: "skewX(-12deg)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "relative",
              color: muted,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.11em",
            }}
          >
            PROGRAMME PAYLOAD
          </div>
          <div
            style={{
              position: "relative",
              color: ink,
              fontSize: 21,
              fontWeight: 800,
              marginTop: 14,
            }}
          >
            Programme payload
          </div>
          <div
            style={{
              position: "relative",
              color: muted,
              fontSize: 14,
              marginTop: 7,
            }}
          >
            Sessions, speakers, tracks and room fields
          </div>
          <div
            style={{
              position: "relative",
              height: 3,
              marginTop: 18,
              overflow: "hidden",
              borderRadius: 999,
              background: "rgba(24,37,34,.08)",
            }}
          >
            <div
              style={{
                width: `${previewProgress * 100}%`,
                height: "100%",
                borderRadius: 999,
                background: `linear-gradient(90deg, ${sage}, ${copper}, ${PALETTE.gold})`,
              }}
            />
          </div>
          <div
            style={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 10,
              marginTop: 15,
            }}
          >
            {steps.map((step, index) => {
              const stepFocus = clamp(1 - Math.abs(activeStep - index));
              return (
                <div
                  key={step.label}
                  style={{
                    padding: "12px 12px",
                    borderRadius: 14,
                    border: `1px solid ${interpolateColors(
                      stepFocus,
                      [0, 1],
                      [line, step.tone],
                    )}`,
                    background: interpolateColors(
                      stepFocus,
                      [0, 1],
                      ["rgba(24,37,34,.025)", `${step.tone}12`],
                    ),
                    opacity: interpolate(stepFocus, [0, 1], [0.62, 1]),
                    transform: `translate3d(0, ${interpolate(
                      stepFocus,
                      [0, 1],
                      [2, -2],
                    )}px, 0)`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      color: step.tone === copper ? copperText : step.tone,
                      fontSize: 9,
                      fontWeight: 900,
                      letterSpacing: "0.09em",
                    }}
                  >
                    <span>STEP 0{index + 1}</span>
                    <span>{step.status}</span>
                  </div>
                  <div
                    style={{
                      color: ink,
                      fontSize: 13,
                      fontWeight: 800,
                      marginTop: 8,
                    }}
                  >
                    {step.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div
          style={{
            padding: 26,
            borderRadius: 18,
            border: `1px solid rgba(143,191,154,${0.3 + boundaryPulse * 0.18})`,
            background: "rgba(143,191,154,.09)",
            boxShadow: `inset 0 0 ${interpolate(
              boundaryPulse,
              [0, 1],
              [0, 22],
            )}px rgba(143,191,154,.09)`,
          }}
        >
          <div
            style={{
              color: PALETTE.sageDeep,
              fontSize: 10,
              fontWeight: 900,
              letterSpacing: "0.11em",
            }}
          >
            EXPORT STATUS
          </div>
          <div
            style={{ color: ink, fontSize: 21, fontWeight: 800, marginTop: 14 }}
          >
            <span
              style={{
                display: "inline-block",
                width: 9,
                height: 9,
                marginRight: 9,
                borderRadius: "50%",
                background: PALETTE.sageDeep,
                boxShadow: `0 0 0 ${interpolate(
                  boundaryPulse,
                  [0, 1],
                  [2, 7],
                )}px rgba(143,191,154,.14)`,
              }}
            />
            Ready to export
          </div>
          <div style={{ color: muted, fontSize: 14, marginTop: 7 }}>
            Mappings complete
          </div>
          <div
            style={{
              marginTop: 20,
              padding: "16px 18px",
              borderRadius: 15,
              background: "rgba(255,253,248,.72)",
              border: "1px solid rgba(143,191,154,.28)",
              color: PALETTE.sageDeep,
              fontSize: 12,
              fontWeight: 800,
              lineHeight: 1.45,
            }}
          >
            Review once, then confirm the export
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 20,
          padding: "18px 20px",
          borderRadius: 13,
          background: "rgba(143,191,154,.08)",
          border: "1px solid rgba(143,191,154,.26)",
          color: PALETTE.sageDeep,
          fontSize: 14,
          fontWeight: 800,
        }}
      >
        <Check color={PALETTE.sageDeep} /> Speakers · tracks · sessions · room
        fields included
      </div>
    </div>
  );
}

export function OperateScene({ duration }: SceneProps) {
  const frame = useCurrentFrame();
  const progress = frameProgress(frame, duration);
  const hero = cut(progress, 0, 0.16);
  const api = cut(progress, 0.16, 0.39);
  const trail = cut(progress, 0.39, 0.6);
  const detail = cut(progress, 0.6, 0.78);
  const provider = after(progress, 0.78);
  const heroLocal = local(progress, 0, 0.16);
  const apiLocal = local(progress, 0.16, 0.39);
  const trailLocal = local(progress, 0.39, 0.6);
  const detailLocal = local(progress, 0.6, 0.78);
  const providerLocal = local(progress, 0.78, 1);
  const heroWindowX = interpolate(ease(heroLocal), [0, 1], [10, -10]);
  const heroWindowY = interpolate(
    Math.sin(heroLocal * Math.PI),
    [0, 1],
    [0, -5],
  );
  const heroWindowScale = interpolate(ease(heroLocal), [0, 1], [1.018, 1.032]);
  const apiCardY = interpolate(apiLocal, [0, 1], [-5, 5]);
  const trailCardY = interpolate(trailLocal, [0, 1], [-8, 8]);
  const detailSettle = ease(local(detailLocal, 0.02, 0.72));
  const detailDrift = interpolate(detailSettle, [0, 1], [-9, 0]);
  const detailScale = interpolate(detailSettle, [0, 1], [0.982, 1]);
  const providerCardY = interpolate(
    Math.sin(providerLocal * Math.PI * 2),
    [-1, 1],
    [-3, 3],
  );
  return (
    <AbsoluteFill
      style={{
        background: deep,
        overflow: "hidden",
        fontFamily: "Program Cue Inter, Inter, sans-serif",
      }}
    >
      <DotGrid opacity={0.3} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 12% 28%, rgba(143,191,154,.12), transparent 30%), radial-gradient(circle at 90% 77%, rgba(190,98,66,.2), transparent 32%)",
        }}
      />
      <SceneHeader
        chapter="EVENT OPERATIONS"
        index="12 / 13 · OPERATE"
        progress={progress}
      />
      <Reveal
        amount={hero}
        style={{ position: "absolute", left: 120, top: 210, zIndex: 5 }}
      >
        <Eyebrow tone="sage" dark>
          Operate
        </Eyebrow>
        <div
          style={{
            color: paper,
            fontSize: 84,
            lineHeight: 0.96,
            fontWeight: 880,
            letterSpacing: "-0.08em",
            marginTop: 20,
          }}
        >
          Stay in control
          <br />
          <span style={{ color: sage }}>after publish.</span>
        </div>
        <div
          style={{
            color: "rgba(255,253,248,.6)",
            fontSize: 17,
            lineHeight: 1.5,
            maxWidth: 460,
            marginTop: 25,
          }}
        >
          From API call to recipient result, see what happened—and act on what
          comes next.
        </div>
        <div style={{ display: "flex", gap: 30, marginTop: 34 }}>
          <Metric dark value="33" label="documented API paths" tone="sage" />
          <Metric dark value="01" label="operation centre" tone="copper" />
        </div>
      </Reveal>
      <Reveal
        amount={hero}
        x={50}
        y={35}
        style={{ position: "absolute", right: 110, top: 185, zIndex: 4 }}
      >
        <div
          style={{
            transform: `translate3d(${heroWindowX}px, ${heroWindowY}px, 0) scale(${heroWindowScale})`,
            transformOrigin: "center center",
          }}
        >
          <AssetWindow
            src={ASSETS.programmeAdmin}
            label="PROGRAMME PUBLISHING"
            caption="programme operations"
            width={750}
            height={560}
            objectPosition="center top"
            dark
          />
        </div>
      </Reveal>
      <Reveal
        amount={api}
        style={{ position: "absolute", inset: 0, zIndex: 10 }}
      >
        <div style={{ position: "absolute", left: 114, top: 180, width: 470 }}>
          <Eyebrow tone="sage" dark>
            01 · Connect
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 54,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Make Program Cue
            <br />
            part of your
            <br />
            <span style={{ color: sage }}>event stack.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              maxWidth: 380,
            }}
          >
            Use documented REST paths and webhooks to connect programme
            operations with the tools around them.
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 28 }}>
            <Chip tone="good" dark>
              33 documented paths
            </Chip>
            <Chip tone="copper" dark>
              scoped API keys
            </Chip>
            <Chip dark>webhook events</Chip>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 112,
            top: 180,
            transform: `translate3d(0, ${apiCardY}px, 0)`,
          }}
        >
          <ApiConsole progress={apiLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={trail}
        style={{ position: "absolute", inset: 0, zIndex: 12 }}
      >
        <div style={{ position: "absolute", left: 114, top: 192, width: 430 }}>
          <Eyebrow tone="copper" dark>
            02 · Operation Centre
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 54,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            One reminder.
            <br />
            <span style={{ color: copper }}>Every step visible.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              maxWidth: 350,
            }}
          >
            Track approval, queue progress and the recipient result in one
            place.
          </div>
          <div
            style={{
              marginTop: 28,
              display: "flex",
              alignItems: "center",
              gap: 11,
              color: sage,
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.1em",
            }}
          >
            <Check /> ONE CENTRE · RECIPIENT RESULT
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: 112,
            top: 175,
            transform: `translate3d(0, ${trailCardY}px, 0)`,
          }}
        >
          <OperationCentreProgress progress={trailLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={detail}
        style={{ position: "absolute", inset: 0, zIndex: 14 }}
      >
        <div
          style={{
            position: "absolute",
            left: 220,
            right: 220,
            top: 148,
            textAlign: "center",
          }}
        >
          <Eyebrow tone="sage" dark>
            03 · Results
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 64,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Recover the
            <br />
            <span style={{ color: sage }}>failed operation.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              marginLeft: "auto",
              marginRight: "auto",
              maxWidth: 580,
            }}
          >
            Keep the original audience, inspect the recorded result and restart
            the failed operation.
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 240 + detailDrift,
            top: 382,
            transform: `scale(${detailScale})`,
            transformOrigin: "top center",
          }}
        >
          <OperationCentreDetail progress={detailLocal} />
        </div>
      </Reveal>
      <Reveal
        amount={provider}
        style={{ position: "absolute", inset: 0, zIndex: 16 }}
      >
        <div
          style={{
            position: "absolute",
            left: 180,
            right: 180,
            top: 142,
            textAlign: "center",
          }}
        >
          <Eyebrow tone="copper" dark>
            04 · Accelevents export
          </Eyebrow>
          <div
            style={{
              color: paper,
              fontSize: 60,
              lineHeight: 0.98,
              fontWeight: 860,
              letterSpacing: "-0.07em",
              marginTop: 17,
            }}
          >
            Your programme,
            <br />
            <span style={{ color: copper }}>mapped for Accelevents.</span>
          </div>
          <div
            style={{
              color: "rgba(255,253,248,.56)",
              fontSize: 14,
              lineHeight: 1.5,
              marginTop: 19,
              marginLeft: "auto",
              marginRight: "auto",
              maxWidth: 710,
            }}
          >
            Bring published programme, speaker, track, session and room fields
            together in one export-ready package.
          </div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 11,
              marginTop: 17,
              padding: "12px 15px",
              borderRadius: 999,
              background: "rgba(143,191,154,.1)",
              border: "1px solid rgba(143,191,154,.3)",
              color: "#b8e7bf",
              fontSize: 11,
              fontWeight: 850,
              letterSpacing: "0.08em",
            }}
          >
            <Check color="#b8e7bf" /> EXPORT PACKAGE READY
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 25,
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 13,
                border: "1px solid rgba(212,167,44,.3)",
                background: "rgba(212,167,44,.08)",
                color: "#f7d56b",
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              SESSIONS · SPEAKERS · TRACKS · ROOM FIELDS
            </div>
            <div
              style={{
                background: "rgba(143,191,154,.08)",
                border: "1px solid rgba(143,191,154,.28)",
                borderRadius: 13,
                color: sage,
                fontSize: 10,
                fontWeight: 800,
                padding: "10px 13px",
              }}
            >
              ONE CONNECTED EXPORT
            </div>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: 292,
            top: 508,
            transform: `translate3d(0, ${providerCardY}px, 0) scale(.88)`,
            transformOrigin: "top center",
          }}
        >
          <ProviderPreview progress={providerLocal} />
        </div>
      </Reveal>
      <FooterRail
        progress={progress}
        items={["contract", "queue", "recovery", "export"]}
      />
    </AbsoluteFill>
  );
}
