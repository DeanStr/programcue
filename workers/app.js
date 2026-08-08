const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};
const IMPACTS = new Set(['critical', 'high', 'medium', 'low']);
const encoder = new TextEncoder();

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...JSON_HEADERS, ...headers },
  });
}

function errorResponse(status, code, message, correlationId, details, headers = {}) {
  return json({ error: { code, message, ...(details ? { details } : {}) }, correlationId }, status, { 'cache-control': 'no-store', ...headers });
}

function requireBinding(env, name) {
  const value = env[name];
  if (!value) throw new ApiError(503, 'CONFIGURATION_ERROR', `Required Cloudflare binding ${name} is unavailable`);
  return value;
}

function correlationId(request) {
  return request.headers.get('cf-ray') || request.headers.get('x-correlation-id') || crypto.randomUUID();
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function secretsEqual(a, b) {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left[index % left.length] ?? 0) ^ (right[index % right.length] ?? 0);
  return mismatch === 0;
}

async function requireInternalAuth(request, env) {
  const expected = requireBinding(env, 'INTERNAL_API_TOKEN');
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw new ApiError(401, 'AUTH_REQUIRED', 'Bearer authentication is required');
  const supplied = header.slice(7).trim();
  if (!supplied || !(await secretsEqual(supplied, expected))) throw new ApiError(403, 'AUTH_FORBIDDEN', 'The supplied credential is not authorised');
}

async function readJson(request, maxBytes = 256_000) {
  const type = request.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`);
  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function publicProgrammeSeed() {
  return {
    event: {
      id: 'evt-foe-2025',
      slug: 'future-of-events-2025',
      name: 'Future of Events 2025',
      timezone: 'America/Toronto',
      venue: 'Metro Toronto Convention Centre',
      city: 'Toronto',
    },
    sessions: [
      { id: 'p1', title: 'Opening Keynote: The Next Chapter for Events', startsAt: '2025-05-20T13:00:00Z', endsAt: '2025-05-20T13:45:00Z', room: 'Main Stage', building: 'South Building', level: 'Level 200', format: 'Keynote', track: 'Leadership', speakers: ['Alex Morgan'] },
      { id: 'p2', title: 'AI in Action: Real-World Event Innovation', startsAt: '2025-05-20T14:15:00Z', endsAt: '2025-05-20T15:00:00Z', room: 'Room 301', building: 'North Building', level: 'Level 300', format: 'Panel', track: 'AI & Innovation', speakers: ['Alex Morgan', 'Jamie Lee', 'Priya Shah'] },
      { id: 'p3', title: 'Designing Inclusive and Accessible Experiences', startsAt: '2025-05-20T15:15:00Z', endsAt: '2025-05-20T16:00:00Z', room: 'Room 205', building: 'South Building', level: 'Level 200', format: 'Presentation', track: 'Experience Design', speakers: ['Taylor Lee'] },
      { id: 'p4', title: 'Networking Lunch', startsAt: '2025-05-20T16:00:00Z', endsAt: '2025-05-20T17:00:00Z', room: 'Exhibit Hall', building: 'North Building', level: 'Level 100', format: 'Other', track: null, speakers: [] },
      { id: 'p5', title: 'From Data to Impact: Measuring What Matters', startsAt: '2025-05-20T17:15:00Z', endsAt: '2025-05-20T18:00:00Z', room: 'Room 302', building: 'North Building', level: 'Level 300', format: 'Panel', track: 'Event Operations', speakers: ['Priya Shah', 'Jordan Lee'] },
      { id: 'p6', title: 'Hybrid Done Right: Lessons from the Field', startsAt: '2025-05-21T18:15:00Z', endsAt: '2025-05-21T19:00:00Z', room: 'Room 206', building: 'South Building', level: 'Level 200', format: 'Presentation', track: 'Leadership', speakers: ['Jordan Kim'] },
      { id: 'p7', title: 'Community and Connection in a Digital World', startsAt: '2025-05-21T13:00:00Z', endsAt: '2025-05-21T13:45:00Z', room: 'Room 205', building: 'South Building', level: 'Level 200', format: 'Panel', track: 'Experience Design', speakers: ['Morgan Patel', 'Riley Thompson'] },
      { id: 'p8', title: 'Closing Keynote: Building the Future Together', startsAt: '2025-05-22T13:00:00Z', endsAt: '2025-05-22T13:45:00Z', room: 'Main Stage', building: 'South Building', level: 'Level 200', format: 'Keynote', track: 'Leadership', speakers: ['Priya Nair'] },
    ],
  };
}

async function queryPublicProgramme(env, slug) {
  if (env.DEMO_MODE === 'true') return publicProgrammeSeed();
  const db = requireBinding(env, 'DB');
  const event = await db.prepare('SELECT id, slug, name, timezone, venue_name AS venue, city FROM events WHERE slug = ? AND programme_published_at IS NOT NULL').bind(slug).first();
  if (!event) return null;
  const { results } = await db.prepare(`
    SELECT s.id, s.title, strftime('%Y-%m-%dT%H:%M:%SZ', se.starts_at, 'unixepoch') AS startsAt,
           strftime('%Y-%m-%dT%H:%M:%SZ', se.ends_at, 'unixepoch') AS endsAt,
           r.name AS room, r.building, r.level, s.format, t.name AS track,
           GROUP_CONCAT(p.display_name, '||') AS speakerNames
      FROM schedule_entries se
      JOIN sessions s ON s.id = se.session_id
      JOIN rooms r ON r.id = se.room_id
      LEFT JOIN tracks t ON t.id = s.track_id
      LEFT JOIN session_speakers ss ON ss.session_id = s.id
      LEFT JOIN people p ON p.id = ss.person_id
     WHERE se.event_id = ? AND se.schedule_version_id = (
       SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 1
     )
     GROUP BY s.id, se.id, r.id, t.id
     ORDER BY se.starts_at ASC
  `).bind(event.id, event.id).all();
  return {
    event,
    sessions: results.map(({ speakerNames, ...session }) => ({
      ...session,
      speakers: speakerNames ? speakerNames.split('||') : [],
    })),
  };
}

function icsEscape(value = '') {
  return String(value).replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll(/\r?\n/g, '\\n');
}

function icsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function programmeCalendar(data) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Program Cue//Programme//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const session of data.sessions) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(session.id)}@programcue`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(session.startsAt)}`,
      `DTEND:${icsDate(session.endsAt)}`,
      `SUMMARY:${icsEscape(session.title)}`,
      `LOCATION:${icsEscape([session.room, session.building, session.level, data.event.venue].filter(Boolean).join(', '))}`,
      `DESCRIPTION:${icsEscape([session.track, session.format, ...(session.speakers || [])].filter(Boolean).join(' · '))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function configuredOrigins(env) {
  return String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function allowedPrivateOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return configuredOrigins(env).includes(origin) ? origin : null;
}

async function handleApi(request, env, url, id) {
  if (request.method === 'OPTIONS') {
    const publicPreflight = url.pathname === '/api/v1/health' || url.pathname.startsWith('/api/v1/public/');
    const allowedOrigin = publicPreflight ? '*' : allowedPrivateOrigin(request, env);
    if (!allowedOrigin) return errorResponse(403, 'CORS_FORBIDDEN', 'Origin is not allowed for private API routes', id);
    const headers = {
      ...SECURITY_HEADERS,
      'access-control-allow-origin': allowedOrigin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,x-correlation-id',
      'access-control-max-age': '600',
      ...(publicPreflight ? {} : { vary: 'Origin' }),
    };
    return new Response(null, { status: 204, headers });
  }

  if (url.pathname === '/api/v1/health' && request.method === 'GET') {
    return json({ ok: true, service: 'program-cue', environment: env.APP_ENV || 'unknown', correlationId: id }, 200, { 'cache-control': 'no-store' });
  }

  const publicMatch = url.pathname.match(/^\/api\/v1\/public\/events\/([^/]+)\/programme$/);
  if (publicMatch && request.method === 'GET') {
    const data = await queryPublicProgramme(env, decodeURIComponent(publicMatch[1]));
    return data
      ? json(data, 200, { 'cache-control': 'public, max-age=60, stale-while-revalidate=300', 'access-control-allow-origin': '*' })
      : errorResponse(404, 'EVENT_NOT_FOUND', 'Published event programme not found', id, undefined, { 'access-control-allow-origin': '*' });
  }

  const calendarMatch = url.pathname.match(/^\/api\/v1\/public\/events\/([^/]+)\/calendar\.ics$/);
  if (calendarMatch && request.method === 'GET') {
    const data = await queryPublicProgramme(env, decodeURIComponent(calendarMatch[1]));
    if (!data) return errorResponse(404, 'EVENT_NOT_FOUND', 'Published event programme not found', id, undefined, { 'access-control-allow-origin': '*' });
    return new Response(programmeCalendar(data), {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="programme.ics"', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' },
    });
  }

  if (url.pathname === '/api/v1/demo/reset' && request.method === 'POST') {
    if (env.DEMO_MODE !== 'true') return errorResponse(403, 'DEMO_DISABLED', 'Demo reset is disabled', id);
    return json({ ok: true, reset: 'client-local-state', correlationId: id });
  }

  const eventRoute = url.pathname.startsWith('/api/v1/events/');
  if (eventRoute) await requireInternalAuth(request, env);

  const taskMatch = url.pathname.match(/^\/api\/v1\/events\/([^/]+)\/tasks$/);
  if (taskMatch && request.method === 'GET') {
    const db = requireBinding(env, 'DB');
    const rawLimit = url.searchParams.get('limit') ?? '100';
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return errorResponse(422, 'VALIDATION_ERROR', 'limit must be a whole number from 1 to 200', id);
    const { results } = await db.prepare('SELECT id, title, status, impact, readiness_percent, due_at, owner_person_id FROM task_instances WHERE event_id = ? ORDER BY due_at IS NULL, due_at ASC LIMIT ?').bind(taskMatch[1], limit).all();
    return json({ tasks: results, correlationId: id });
  }
  if (taskMatch && request.method === 'POST') {
    const db = requireBinding(env, 'DB');
    const body = await readJson(request);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const impact = typeof body.impact === 'string' ? body.impact.toLowerCase() : '';
    if (!title || title.length > 200 || !IMPACTS.has(impact)) {
      return errorResponse(422, 'VALIDATION_ERROR', 'title (1–200 characters) and a valid impact are required', id);
    }
    const event = await db.prepare('SELECT id FROM events WHERE id = ?').bind(taskMatch[1]).first();
    if (!event) return errorResponse(404, 'EVENT_NOT_FOUND', 'Event not found', id);
    const taskId = crypto.randomUUID();
    await db.prepare("INSERT INTO task_instances (id, event_id, title, impact, status, readiness_percent, created_at, updated_at) VALUES (?, ?, ?, ?, 'not_started', 0, unixepoch(), unixepoch())")
      .bind(taskId, taskMatch[1], title, impact).run();
    return json({ id: taskId, correlationId: id }, 201);
  }

  const publishMatch = url.pathname.match(/^\/api\/v1\/events\/([^/]+)\/schedule\/publish$/);
  if (publishMatch && request.method === 'POST') {
    const db = requireBinding(env, 'DB');
    const body = await readJson(request);
    if (typeof body.scheduleVersionId !== 'string' || !body.scheduleVersionId.trim()) {
      return errorResponse(422, 'VALIDATION_ERROR', 'scheduleVersionId is required', id);
    }
    const target = await db.prepare("SELECT id FROM schedule_versions WHERE id = ? AND event_id = ? AND status = 'draft'").bind(body.scheduleVersionId, publishMatch[1]).first();
    if (!target) return errorResponse(404, 'DRAFT_SCHEDULE_NOT_FOUND', 'Draft schedule version not found', id);
    const blockers = await db.prepare("SELECT COUNT(*) AS count FROM schedule_conflicts WHERE event_id = ? AND schedule_version_id = ? AND resolved_at IS NULL AND severity = 'blocking'").bind(publishMatch[1], body.scheduleVersionId).first();
    if ((blockers?.count || 0) > 0) return errorResponse(409, 'BLOCKING_CONFLICTS', 'Resolve blocking schedule conflicts before publishing', id, { count: blockers.count });

    await db.batch([
      db.prepare("UPDATE schedule_versions SET status = 'archived' WHERE event_id = ? AND status = 'published' AND id <> ?").bind(publishMatch[1], body.scheduleVersionId),
      db.prepare("UPDATE schedule_versions SET status = 'published', published_at = unixepoch() WHERE id = ? AND event_id = ? AND status = 'draft'").bind(body.scheduleVersionId, publishMatch[1]),
      db.prepare("UPDATE events SET programme_published_at = unixepoch(), updated_at = unixepoch() WHERE id = ?").bind(publishMatch[1]),
      db.prepare("INSERT INTO audit_events (id, event_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, 'schedule.published', 'schedule_version', ?, '{}', unixepoch())").bind(crypto.randomUUID(), publishMatch[1], body.scheduleVersionId),
    ]);
    return json({ published: true, scheduleVersionId: body.scheduleVersionId, correlationId: id });
  }

  const queueMatch = url.pathname.match(/^\/api\/v1\/events\/([^/]+)\/operations$/);
  if (queueMatch && request.method === 'POST') {
    const db = requireBinding(env, 'DB');
    const queue = requireBinding(env, 'OPERATIONS_QUEUE');
    const body = await readJson(request, 64_000);
    if (typeof body.type !== 'string' || !/^[a-z][a-z0-9_.-]{2,63}$/.test(body.type) || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 128) {
      return errorResponse(422, 'VALIDATION_ERROR', 'type and an idempotencyKey of 8–128 characters are required', id);
    }
    const event = await db.prepare('SELECT id FROM events WHERE id = ?').bind(queueMatch[1]).first();
    if (!event) return errorResponse(404, 'EVENT_NOT_FOUND', 'Event not found', id);
    const operationId = crypto.randomUUID();
    const payload = JSON.stringify({ ...body, eventId: queueMatch[1], correlationId: id, operationId });
    const insert = await db.prepare("INSERT OR IGNORE INTO operation_jobs (id, event_id, type, idempotency_key, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, unixepoch(), unixepoch())")
      .bind(operationId, queueMatch[1], body.type, body.idempotencyKey, payload).run();
    if ((insert.meta?.changes || 0) === 0) {
      const existing = await db.prepare('SELECT id, status FROM operation_jobs WHERE event_id = ? AND idempotency_key = ?').bind(queueMatch[1], body.idempotencyKey).first();
      return json({ queued: existing?.status === 'queued', duplicate: true, operationId: existing?.id, status: existing?.status, correlationId: id }, 200);
    }
    try {
      await queue.send(JSON.parse(payload));
    } catch (error) {
      await db.prepare("UPDATE operation_jobs SET status = 'failed', updated_at = unixepoch() WHERE id = ?").bind(operationId).run();
      throw error;
    }
    return json({ queued: true, duplicate: false, operationId, correlationId: id }, 202);
  }

  return errorResponse(404, 'NOT_FOUND', 'API route not found', id);
}

function apiCorsHeaders(request, env, pathname) {
  if (pathname === '/api/v1/health' || pathname.startsWith('/api/v1/public/')) return { 'access-control-allow-origin': '*' };
  const origin = allowedPrivateOrigin(request, env);
  return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

function applyApiCors(response, request, env, pathname) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(apiCorsHeaders(request, env, pathname))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function applyAssetHeaders(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (new URL(request.url).pathname.startsWith('/embed/')) {
    const ancestors = env.EMBED_FRAME_ANCESTORS || (env.DEMO_MODE === 'true' ? '*' : null);
    if (!ancestors) throw new ApiError(503, 'CONFIGURATION_ERROR', 'EMBED_FRAME_ANCESTORS is required for public embeds');
    if (/[\r\n;]/.test(ancestors)) throw new ApiError(500, 'CONFIGURATION_ERROR', 'EMBED_FRAME_ANCESTORS contains invalid characters');
    headers.set('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${ancestors}`);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const id = correlationId(request);
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return applyApiCors(await handleApi(request, env, url, id), request, env, url.pathname);
      if (url.pathname.startsWith('/embed/')) {
        const slug = decodeURIComponent(url.pathname.slice('/embed/'.length)).replace(/\/$/, '');
        if (!slug || slug.includes('/') || slug !== (env.PUBLIC_EVENT_SLUG || 'future-of-events-2025')) {
          return errorResponse(404, 'EVENT_NOT_FOUND', 'Published event programme not found', id);
        }
        const indexUrl = new URL('/index.html', request.url);
        const indexRequest = new Request(indexUrl, { method: request.method, headers: request.headers });
        return applyAssetHeaders(await requireBinding(env, 'ASSETS').fetch(indexRequest), request, env);
      }
      return applyAssetHeaders(await requireBinding(env, 'ASSETS').fetch(request), request, env);
    } catch (error) {
      const response = error instanceof ApiError
        ? errorResponse(error.status, error.code, error.message, id, error.details)
        : (() => {
            console.error(JSON.stringify({ level: 'error', correlationId: id, method: request.method, path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
            return errorResponse(500, 'INTERNAL_ERROR', env.APP_ENV === 'production' ? 'Unexpected server error' : String(error), id);
          })();
      return url.pathname.startsWith('/api/') ? applyApiCors(response, request, env, url.pathname) : response;
    }
  },

  async queue(batch, env) {
    const db = requireBinding(env, 'DB');
    for (const message of batch.messages) {
      try {
        const job = message.body;
        if (!job?.idempotencyKey || !job?.type || !job?.eventId) throw new Error('Invalid operation message');
        const update = await db.prepare("UPDATE operation_jobs SET status = CASE WHEN status = 'queued' THEN 'received' ELSE status END, updated_at = unixepoch() WHERE event_id = ? AND idempotency_key = ?")
          .bind(job.eventId, job.idempotencyKey).run();
        if ((update.meta?.changes || 0) === 0) {
          await db.prepare("INSERT OR IGNORE INTO operation_jobs (id, event_id, type, idempotency_key, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'received', ?, unixepoch(), unixepoch())")
            .bind(job.operationId || crypto.randomUUID(), job.eventId, job.type, job.idempotencyKey, JSON.stringify(job)).run();
        }
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', subsystem: 'queue', message: error instanceof Error ? error.message : String(error) }));
        message.retry();
      }
    }
  },
};
