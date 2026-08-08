import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/app.js';

const assets = { fetch: async () => new Response('asset') };
const baseEnv = { APP_ENV:'test', DEMO_MODE:'false', ASSETS:assets, INTERNAL_API_TOKEN:'test-secret' };

test('health endpoint reports explicit environment and security headers', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/v1/health'), { ...baseEnv, DEMO_MODE:'true' }, {});
  assert.equal(response.status,200);
  const body = await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.environment,'test');
  assert.ok(body.correlationId);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});

test('demo public programme and calendar are available without a database binding', async () => {
  const env = { APP_ENV:'demo', DEMO_MODE:'true', ASSETS:assets };
  const response = await worker.fetch(new Request('https://example.test/api/v1/public/events/future-of-events-2025/programme'), env, {});
  assert.equal(response.status,200);
  const body = await response.json();
  assert.equal(body.event.slug,'future-of-events-2025');
  assert.equal(body.sessions.length, 8);
  assert.equal(body.sessions[0].building, 'South Building');
  assert.equal(body.sessions[0].level, 'Level 200');
  const calendar = await worker.fetch(new Request('https://example.test/api/v1/public/events/future-of-events-2025/calendar.ics'), env, {});
  assert.equal(calendar.status,200);
  assert.match(await calendar.text(),/BEGIN:VCALENDAR/);
});

test('private endpoint rejects a missing bearer credential before touching storage', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/v1/events/event-1/tasks'), baseEnv, {});
  assert.equal(response.status,401);
  const body = await response.json();
  assert.equal(body.error.code,'AUTH_REQUIRED');
});

test('private endpoint rejects a wrong bearer credential', async () => {
  const request = new Request('https://example.test/api/v1/events/event-1/tasks',{headers:{authorization:'Bearer wrong-secret'}});
  const response = await worker.fetch(request, baseEnv, {});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,'AUTH_FORBIDDEN');
});

test('authorised private endpoint fails closed when DB binding is missing', async () => {
  const request = new Request('https://example.test/api/v1/events/event-1/tasks',{headers:{authorization:'Bearer test-secret'}});
  const response = await worker.fetch(request, { ...baseEnv, APP_ENV:'production' }, {});
  assert.equal(response.status,503);
  const body = await response.json();
  assert.equal(body.error.code,'CONFIGURATION_ERROR');
  assert.match(body.error.message,/DB is unavailable/);
});


test('public programme errors remain cache-safe and CORS-readable', async () => {
  const fakeDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  const response = await worker.fetch(new Request('https://example.test/api/v1/public/events/missing/programme'), { ...baseEnv, DB: fakeDb }, {});
  assert.equal(response.status,404);
  assert.equal(response.headers.get('access-control-allow-origin'),'*');
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('demo reset cannot be used in production mode', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/v1/demo/reset',{method:'POST'}), { ...baseEnv, APP_ENV:'production' }, {});
  assert.equal(response.status,403);
});

test('private CORS preflight is restricted to the configured application origin', async () => {
  const forbidden = await worker.fetch(new Request('https://api.example.test/api/v1/events/event-1/tasks', {
    method: 'OPTIONS', headers: { origin: 'https://evil.example' },
  }), { ...baseEnv, CORS_ALLOWED_ORIGINS: 'https://app.example.test, https://admin.example.test' }, {});
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'CORS_FORBIDDEN');

  const allowed = await worker.fetch(new Request('https://api.example.test/api/v1/events/event-1/tasks', {
    method: 'OPTIONS', headers: { origin: 'https://app.example.test' },
  }), { ...baseEnv, CORS_ALLOWED_ORIGINS: 'https://app.example.test, https://admin.example.test' }, {});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.test');
});

test('task list rejects a malformed limit instead of binding NaN', async () => {
  const request = new Request('https://example.test/api/v1/events/event-1/tasks?limit=not-a-number', {
    headers: { authorization: 'Bearer test-secret' },
  });
  const response = await worker.fetch(request, { ...baseEnv, DB: {} }, {});
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});

test('operation enqueue is persisted before delivery and is idempotent', async () => {
  const jobs = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('SELECT id FROM events')) return { id: args[0] };
              if (sql.startsWith('SELECT id, status FROM operation_jobs')) return jobs.get(`${args[0]}:${args[1]}`) || null;
              throw new Error(`Unexpected first query: ${sql}`);
            },
            async run() {
              if (sql.startsWith('INSERT OR IGNORE INTO operation_jobs')) {
                const [id, eventId, type, key] = args;
                const scopedKey = `${eventId}:${key}`;
                if (jobs.has(scopedKey)) return { meta: { changes: 0 } };
                jobs.set(scopedKey, { id, eventId, type, status: 'queued' });
                return { meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE operation_jobs SET status')) return { meta: { changes: 1 } };
              throw new Error(`Unexpected run query: ${sql}`);
            },
          };
        },
      };
    },
  };
  let sends = 0;
  const queue = { async send() { sends += 1; } };
  const makeRequest = () => new Request('https://example.test/api/v1/events/event-1/operations', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'speaker.reminder', idempotencyKey: 'reminder-event-1-001' }),
  });
  const env = { ...baseEnv, DB: db, OPERATIONS_QUEUE: queue };
  const first = await worker.fetch(makeRequest(), env, {});
  assert.equal(first.status, 202);
  assert.equal((await first.json()).duplicate, false);
  assert.equal(sends, 1);

  const duplicate = await worker.fetch(makeRequest(), env, {});
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.status, 'queued');
  assert.equal(sends, 1);
});

test('allowed private API responses include the configured CORS origin', async () => {
  const request = new Request('https://api.example.test/api/v1/events/event-1/tasks?limit=invalid', {
    headers: { authorization: 'Bearer test-secret', origin: 'https://app.example.test' },
  });
  const response = await worker.fetch(request, { ...baseEnv, CORS_ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test', DB: {} }, {});
  assert.equal(response.status, 422);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://app.example.test');
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('embed assets opt in to configured framing and rewrite to the SPA entry point', async () => {
  const requestedPaths = [];
  const env = {
    ...baseEnv,
    PUBLIC_EVENT_SLUG: 'future-of-events-2025',
    EMBED_FRAME_ANCESTORS: 'https://site.example',
    ASSETS: { fetch: async (request) => { requestedPaths.push(new URL(request.url).pathname); return new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }); } },
  };
  const embed = await worker.fetch(new Request('https://app.example.test/embed/future-of-events-2025'), env, {});
  assert.equal(embed.status, 200);
  assert.equal(requestedPaths[0], '/index.html');
  assert.match(embed.headers.get('content-security-policy') || '', /frame-ancestors https:\/\/site\.example/);
  const missing = await worker.fetch(new Request('https://app.example.test/embed/not-this-event'), env, {});
  assert.equal(missing.status, 404);
  const normal = await worker.fetch(new Request('https://app.example.test/'), env, {});
  assert.match(normal.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
});

test('production embed fails closed when frame ancestors are not configured', async () => {
  const env = { ...baseEnv, PUBLIC_EVENT_SLUG: 'future-of-events-2025' };
  const response = await worker.fetch(new Request('https://app.example.test/embed/future-of-events-2025'), env, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'CONFIGURATION_ERROR');
});
