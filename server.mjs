import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoEvent, programmeSessions } from './public/seed.js';

const root = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const rawPort = process.env.PORT || '4173';
const port = Number(rawPort);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a valid TCP port; received ${rawPort}.`);

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.yaml': 'application/yaml; charset=utf-8', '.yml': 'application/yaml; charset=utf-8',
};
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
  'cross-origin-opener-policy': 'same-origin',
};

function write(req, res, status, headers, body = '') {
  res.writeHead(status, { ...securityHeaders, ...headers });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function safePath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const candidate = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(`..${sep}`)) return null;
  return candidate;
}

function localDateTime(day, time) {
  const year = demoEvent.startDate?.slice(0, 4) || '2025';
  const monthMap = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const [monthName, dayValue] = String(day).split(/\s+/);
  const parts = String(time).split(/\s*[–-]\s*/);
  if (parts.length !== 2) throw new Error(`Invalid programme time: ${time}`);
  const endPeriod = parts[1].match(/(AM|PM)$/i)?.[1]?.toUpperCase();
  const clock = (raw, fallbackPeriod) => {
    const match = raw.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (!match) throw new Error(`Invalid programme time: ${time}`);
    let hour = Number(match[1]);
    const period = (match[3] || fallbackPeriod || '').toUpperCase();
    if (!period) throw new Error(`Missing AM/PM in programme time: ${time}`);
    if (hour === 12) hour = 0;
    if (period === 'PM') hour += 12;
    return `${String(hour).padStart(2, '0')}:${match[2]}:00`;
  };
  const date = `${year}-${monthMap[monthName] || '05'}-${String(Number(dayValue)).padStart(2, '0')}`;
  // The canonical demo event is in Toronto during EDT (UTC-04:00).
  return {
    startsAt: new Date(`${date}T${clock(parts[0], endPeriod)}-04:00`).toISOString(),
    endsAt: new Date(`${date}T${clock(parts[1], endPeriod)}-04:00`).toISOString(),
  };
}

function icsEscape(value = '') {
  return String(value).replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll(/\r?\n/g, '\\n');
}

function icsDate(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function programmeCalendar(data) {
  const stamp = icsDate(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Program Cue//Programme//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const session of data.sessions) {
    lines.push('BEGIN:VEVENT', `UID:${icsEscape(session.id)}@programcue-demo`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(session.startsAt)}`, `DTEND:${icsDate(session.endsAt)}`, `SUMMARY:${icsEscape(session.title)}`, `LOCATION:${icsEscape([session.room, session.building, session.level, data.event.venue].filter(Boolean).join(', '))}`, `DESCRIPTION:${icsEscape([session.format, session.track, ...(session.speakers || [])].filter(Boolean).join(' · '))}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

function publicProgramme() {
  return {
    event: {
      id: demoEvent.id,
      slug: demoEvent.slug,
      name: demoEvent.name,
      timezone: demoEvent.timezone,
      venue: demoEvent.venue,
      city: demoEvent.city,
      dates: demoEvent.dates,
    },
    sessions: programmeSessions.map((session) => ({
      id: session.id, ...localDateTime(session.day, session.time), title: session.title, format: session.format,
      track: session.track, room: session.room, building: session.building, level: null, description: session.description,
      speakers: session.speaker ? session.speaker.split(',').map((name) => name.trim()).filter(Boolean) : [],
    })),
  };
}

const server = createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    if (!['GET', 'HEAD'].includes(method)) return write(req, res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }, 'Method not allowed');
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (url.pathname === '/healthz') return write(req, res, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'ok');
    if (url.pathname === '/api/v1/health') {
      return write(req, res, 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }, JSON.stringify({ ok: true, service: 'program-cue', environment: 'local' }));
    }
    if (url.pathname === '/api/v1/public/events/future-of-events-2025/programme') {
      return write(req, res, 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' }, JSON.stringify(publicProgramme(), null, 2));
    }
    if (url.pathname === '/api/v1/public/events/future-of-events-2025/calendar.ics') {
      return write(req, res, 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="programme.ics"', 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' }, programmeCalendar(publicProgramme()));
    }
    if (url.pathname.startsWith('/api/')) return write(req, res, 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify({ error: { code: 'NOT_FOUND', message: 'API route not found' } }));
    if (url.pathname.startsWith('/embed/') && url.pathname !== '/embed/future-of-events-2025') {
      return write(req, res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Published event programme not found');
    }

    const candidate = safePath(url.pathname);
    if (!candidate) return write(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Invalid path');
    let filePath = candidate;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
    } catch {
      if (extname(candidate)) return write(req, res, 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Not found');
      filePath = resolve(root, 'index.html');
    }
    const data = await readFile(filePath);
    const extension = extname(filePath).toLowerCase();
    const cacheControl = extension === '.html' ? 'no-store' : 'public, max-age=300';
    const embedHeaders = url.pathname.startsWith('/embed/')
      ? { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors *; form-action 'self'" }
      : {};
    return write(req, res, 200, { 'content-type': types[extension] || 'application/octet-stream', 'cache-control': cacheControl, ...embedHeaders }, data);
  } catch (error) {
    console.error(error);
    return write(req, res, 500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'Server error');
  }
});

server.on('error', (error) => {
  console.error(`Program Cue demo server failed: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, host, () => console.log(`Program Cue demo running at http://${host}:${port}`));
