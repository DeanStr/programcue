export function overlaps(aStart, aEnd, bStart, bEnd) {
  for (const [name, value] of Object.entries({ aStart, aEnd, bStart, bEnd })) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  }
  if (aStart >= aEnd || bStart >= bEnd) throw new Error('Schedule intervals must have a positive duration.');
  return aStart < bEnd && bStart < aEnd;
}

function speakersFor(session) {
  if (Array.isArray(session.speakers)) return new Set(session.speakers.map(String).map((value) => value.trim()).filter(Boolean));
  if (typeof session.speaker === 'string') return new Set(session.speaker.split(',').map((value) => value.trim()).filter(Boolean));
  return new Set();
}
function sharesSpeaker(a, b) {
  const aSpeakers = speakersFor(a); const bSpeakers = speakersFor(b);
  for (const speaker of aSpeakers) if (bSpeakers.has(speaker)) return speaker;
  return null;
}
function scheduled(session) { return Number.isFinite(session?.start) && Number.isFinite(session?.end); }

export function validateScheduleMove({ sessions, rooms = [], movingId, room, start, end, trackConflictPolicy = 'block' }) {
  if (!Array.isArray(sessions)) throw new Error('Sessions must be an array.');
  if (!Array.isArray(rooms)) throw new Error('Rooms must be an array.');
  if (!['block', 'warn', 'ignore'].includes(trackConflictPolicy)) throw new Error(`Unknown track conflict policy: ${trackConflictPolicy}.`);
  if (!room) throw new Error('A destination room is required.');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('A valid destination time is required.');
  const moving = sessions.find((session) => session.id === movingId);
  if (!moving) throw new Error(`Unknown session: ${movingId}.`);
  const roomRecord = rooms.find((candidate) => candidate.id === room);
  if (!roomRecord) throw new Error(`Unknown destination room: ${room}.`);
  if (!Number.isInteger(Number(roomRecord.capacity)) || Number(roomRecord.capacity) < 1) throw new Error(`Room ${room} has an invalid capacity.`);
  const others = sessions.filter((session) => session.id !== movingId && scheduled(session));
  const roomConflict = others.find((session) => session.room === room && overlaps(start, end, session.start, session.end));
  const speakerConflict = others.find((session) => sharesSpeaker(session, moving) && overlaps(start, end, session.start, session.end));
  const trackConflict = moving.track ? others.find((session) => session.track === moving.track && overlaps(start, end, session.start, session.end)) : null;
  const attendance = Number(moving.attendance || 0);
  if (!Number.isFinite(attendance) || attendance < 0) throw new Error(`Expected attendance for ${movingId} must be a non-negative number.`);
  const capacityConflict = attendance > Number(roomRecord.capacity) ? roomRecord : null;
  const blockingTrackConflict = trackConflictPolicy === 'block' ? trackConflict : null;
  return {
    valid: !roomConflict && !speakerConflict && !capacityConflict && !blockingTrackConflict,
    roomConflict: roomConflict?.id ?? null,
    speakerConflict: speakerConflict?.id ?? null,
    trackConflict: trackConflict?.id ?? null,
    capacityConflict: capacityConflict?.id ?? null,
    reasons: [
      roomConflict ? `Room overlaps ${roomConflict.title}.` : 'Room available.',
      speakerConflict ? `Speaker overlaps ${speakerConflict.title}.` : 'Speaker available.',
      trackConflict ? `${trackConflictPolicy === 'block' ? 'Track overlaps' : 'Track warning:'} ${trackConflict.title}.` : 'No track conflict.',
      capacityConflict ? `Expected attendance ${attendance} exceeds room capacity ${roomRecord.capacity}.` : 'Capacity is sufficient.'
    ]
  };
}

export function detectSpeakerConflicts(sessions) {
  if (!Array.isArray(sessions)) throw new Error('Sessions must be an array.');
  const conflicts = [];
  for (let i = 0; i < sessions.length; i += 1) for (let j = i + 1; j < sessions.length; j += 1) {
    const a = sessions[i]; const b = sessions[j];
    if (scheduled(a) && scheduled(b) && sharesSpeaker(a, b) && overlaps(a.start, a.end, b.start, b.end)) conflicts.push([a.id, b.id]);
  }
  return conflicts;
}
export function detectRoomConflicts(sessions) {
  if (!Array.isArray(sessions)) throw new Error('Sessions must be an array.');
  const conflicts = [];
  for (let i = 0; i < sessions.length; i += 1) for (let j = i + 1; j < sessions.length; j += 1) {
    const a = sessions[i]; const b = sessions[j];
    if (scheduled(a) && scheduled(b) && a.room && a.room === b.room && overlaps(a.start, a.end, b.start, b.end)) conflicts.push([a.id, b.id]);
  }
  return conflicts;
}
