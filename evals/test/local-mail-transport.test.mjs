import assert from "node:assert/strict";
import test from "node:test";
import { Request as MiniflareRequest } from "miniflare";
import { localMailSendUrl, sendLocalMail } from "../scripts/local-mail-transport.mjs";

test("local mail forwards actual Miniflare request bytes and the real provider response", async () => {
  const body = JSON.stringify({ Subject: "correlated capture", Text: "Hello Priya" });
  const request = new MiniflareRequest(localMailSendUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const response = new Response('{"ID":"retained-provider-id"}', { status: 202 });
  assert.equal(
    await sendLocalMail(request, async (url, init) => {
      assert.equal(url, localMailSendUrl);
      assert.equal(init.method, "POST");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(Buffer.from(init.body).toString(), body);
      assert.equal(init.redirect, "error");
      assert.equal(init.signal.aborted, false);
      return response;
    }),
    response,
  );
});

test("local mail rejects other destinations, paths and methods before forwarding", async () => {
  for (const [url, method] of [
    ["https://api.resend.com/emails", "POST"],
    ["http://localhost:8025/api/v1/send", "POST"],
    [`${localMailSendUrl}?redirect=remote`, "POST"],
    ["http://127.0.0.1:8025/api/v1/messages", "DELETE"],
    [localMailSendUrl, "GET"],
  ]) {
    await assert.rejects(
      sendLocalMail(new MiniflareRequest(url, { method }), () => {
        assert.fail("disallowed request reached network");
      }),
      /accepts only POST/,
    );
  }
});

test("local mail preserves transport failures instead of inventing capture success", async () => {
  await assert.rejects(
    sendLocalMail(
      new MiniflareRequest(localMailSendUrl, {
        method: "POST",
        body: "{}",
      }),
      async () => {
        throw new Error("Mailpit unavailable");
      },
    ),
    /Mailpit unavailable/,
  );
});
