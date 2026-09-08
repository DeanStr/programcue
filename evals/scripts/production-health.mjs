const response = await fetch("https://app.programcue.com/api/v1/health", {
  redirect: "error",
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Production health failed (HTTP ${response.status})`);
const body = await response.json();
if (
  body?.ok !== true ||
  body.service !== "program-cue" ||
  body.environment !== "production" ||
  !/^[a-f0-9]{40}$/.test(body.sourceRevision)
)
  throw new Error("Production health did not identify a production Programcue revision");
console.log(JSON.stringify({ environment: body.environment, sourceRevision: body.sourceRevision }));
