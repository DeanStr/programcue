import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWeightedReview, validateRubric } from '../src/domain/review.mjs';
import { overlaps, validateScheduleMove, detectSpeakerConflicts, detectRoomConflicts } from '../src/domain/schedule.mjs';
import { calculateWeightedReadiness } from '../src/domain/readiness.mjs';
import { calculateRecipients, validateCommunication } from '../src/domain/communications.mjs';

const rubric = [
  { id: 'relevance', name: 'Relevance', weight: 25, rating: 4 },
  { id: 'originality', name: 'Originality', weight: 20, rating: 4 },
  { id: 'quality', name: 'Content quality', weight: 25, rating: 5 },
  { id: 'practical', name: 'Practical application', weight: 20, rating: 4 },
  { id: 'expertise', name: 'Expertise', weight: 10, rating: 4 },
];

test('weighted rubric is mathematically consistent', () => {
  assert.equal(validateRubric(rubric), true);
  assert.deepEqual(calculateWeightedReview(rubric), { score: 4.25, percentage: 85 });
});

test('rubric fails fast on malformed weights, ratings and ids', () => {
  assert.throws(() => validateRubric([{ id: 'a', name: 'A', weight: 90, rating: 4 }]), /must total 100/);
  assert.throws(() => validateRubric([{ id: 'a', name: 'A', weight: 'x', rating: 4 }]), /finite number/);
  assert.throws(() => validateRubric([{ id: 'a', name: 'A', weight: 50, rating: 4 }, { id: 'a', name: 'B', weight: 50, rating: 4 }]), /Duplicate/);
  assert.throws(() => validateRubric([{ id: 'a', name: 'A', weight: 100, rating: Number.NaN }]), /finite number/);
});

test('overlap uses half-open intervals and rejects invalid intervals', () => {
  assert.equal(overlaps(600, 660, 660, 720), false);
  assert.equal(overlaps(600, 660, 659, 720), true);
  assert.throws(() => overlaps(600, 600, 660, 720), /positive duration/);
});

test('schedule move validates room, speaker and capacity', () => {
  const sessions = [
    { id: 'a', title: 'AI in Event Ops', speakers: ['Jamie Lee'], room: '301A', start: 600, end: 660, attendance: 150 },
    { id: 'b', title: 'Event Marketing', speakers: ['Jamie Lee'], room: '301B', start: 600, end: 660, attendance: 160 },
    { id: 'c', title: 'Emerging Trends', speakers: ['Jordan Miles'], room: '303', start: 795, end: 855, attendance: 90 },
  ];
  const rooms = [{ id: '303', capacity: 150 }];
  const overlap = validateScheduleMove({ sessions, rooms, movingId: 'a', room: '303', start: 840, end: 900 });
  assert.equal(overlap.valid, false, '2:00 PM overlaps Emerging Trends until 2:15 PM');
  const valid = validateScheduleMove({ sessions, rooms, movingId: 'a', room: '303', start: 855, end: 915 });
  assert.equal(valid.valid, true);
  const tooSmall = validateScheduleMove({ sessions, rooms: [{ id: '303', capacity: 100 }], movingId: 'a', room: '303', start: 855, end: 915 });
  assert.equal(tooSmall.capacityConflict, '303');
  assert.throws(() => validateScheduleMove({ sessions, rooms, movingId: 'a', room: 'missing', start: 855, end: 915 }), /Unknown destination room/);
  assert.deepEqual(detectSpeakerConflicts(sessions), [['a', 'b']]);
});

test('schedule move applies explicit track policy', () => {
  const sessions = [
    { id:'a', title:'AI session', speaker:'Alex', track:'AI', room:'301A', start:600, end:660, attendance:50 },
    { id:'b', title:'Other AI session', speaker:'Blair', track:'AI', room:'302', start:800, end:900, attendance:50 },
  ];
  const rooms = [{ id:'303', capacity:100 }];
  const blocked = validateScheduleMove({ sessions, rooms, movingId:'a', room:'303', start:840, end:900, trackConflictPolicy:'block' });
  assert.equal(blocked.valid,false);
  assert.equal(blocked.trackConflict,'b');
  const warned = validateScheduleMove({ sessions, rooms, movingId:'a', room:'303', start:840, end:900, trackConflictPolicy:'warn' });
  assert.equal(warned.valid,true);
  assert.equal(warned.trackConflict,'b');
  assert.throws(() => validateScheduleMove({ sessions, rooms, movingId:'a', room:'303', start:840, end:900, trackConflictPolicy:'invented' }), /Unknown track conflict policy/);
});

test('room conflicts are detected independently of speaker conflicts', () => {
  assert.deepEqual(detectRoomConflicts([
    { id: 'a', room: '301A', start: 600, end: 660 },
    { id: 'b', room: '301A', start: 650, end: 700 },
    { id: 'c', room: '301B', start: 600, end: 660 },
  ]), [['a', 'b']]);
});

test('weighted readiness separates impact from completion and rejects invalid values', () => {
  const score = calculateWeightedReadiness([
    { id: 'a', impact: 'critical', readiness: 0 },
    { id: 'b', impact: 'high', readiness: 100 },
    { id: 'c', impact: 'low', readiness: 100 },
  ]);
  assert.equal(score, 50);
  assert.throws(() => calculateWeightedReadiness([{ id: 'a', impact: 'urgent', readiness: 50 }]), /Unknown impact/);
  assert.throws(() => calculateWeightedReadiness([{ id: 'a', impact: 'low', readiness: Number.NaN }]), /between 0 and 100/);
});

test('recipient arithmetic fails fast on impossible exclusions', () => {
  assert.equal(calculateRecipients({ selected: 28719, suppressed: 2036, invalid: 142 }), 26541);
  assert.throws(() => calculateRecipients({ selected: 10, suppressed: 9, invalid: 2 }), /cannot exceed/);
});

test('communication validation is channel-specific', () => {
  const result = validateCommunication({
    subject: 'Event starts tomorrow',
    emailBody: 'Hello',
    physicalAddress: '',
    channels: ['email', 'sms', 'push', 'calendar'],
    smsBody: 'x'.repeat(161),
    pushTitle: '',
    pushBody: '',
    calendarTitle: 'Session',
    calendarLocation: '',
    calendarStart: '2025-05-20T10:00:00Z',
    calendarEnd: '2025-05-20T09:00:00Z',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('Physical address is required for the email footer.'));
  assert.ok(result.errors.includes('SMS exceeds 160 characters.'));
  assert.ok(result.errors.includes('Push title is required.'));
  assert.ok(result.errors.includes('Calendar location is required.'));
  assert.ok(result.errors.includes('Calendar end must be after its start.'));
});
