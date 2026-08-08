const CHANNELS = new Set(['email', 'sms', 'push', 'calendar']);

export function calculateRecipients({ selected, suppressed, invalid }) {
  for (const [name, value] of Object.entries({ selected, suppressed, invalid })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  }
  if (suppressed + invalid > selected) throw new Error('Recipient exclusions cannot exceed the selected audience.');
  return selected - suppressed - invalid;
}

export function validateCommunication(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('Communication draft is required.');
  const errors = [];
  const channels = Array.isArray(draft.channels) ? draft.channels : [];
  if (channels.length === 0) errors.push('Select at least one delivery channel.');
  if (new Set(channels).size !== channels.length) errors.push('Delivery channels must not contain duplicates.');
  for (const channel of channels) if (!CHANNELS.has(channel)) errors.push(`Unsupported delivery channel: ${channel}.`);

  if (channels.includes('email')) {
    if (!draft.subject?.trim()) errors.push('Email subject is required.');
    if (!draft.emailBody?.trim()) errors.push('Email body is required.');
    if (!draft.physicalAddress?.trim()) errors.push('Physical address is required for the email footer.');
  }
  if (channels.includes('sms')) {
    if (!draft.smsBody?.trim()) errors.push('SMS body is required.');
    else if ([...draft.smsBody].length > 160) errors.push('SMS exceeds 160 characters.');
  }
  if (channels.includes('push')) {
    if (!draft.pushTitle?.trim()) errors.push('Push title is required.');
    if (!draft.pushBody?.trim()) errors.push('Push body is required.');
    if ([...(draft.pushTitle || '')].length > 60) errors.push('Push title exceeds 60 characters.');
    if ([...(draft.pushBody || '')].length > 180) errors.push('Push body exceeds 180 characters.');
  }
  if (channels.includes('calendar')) {
    if (!draft.calendarTitle?.trim()) errors.push('Calendar title is required.');
    if (!draft.calendarLocation?.trim()) errors.push('Calendar location is required.');
    if (!draft.calendarStart || !draft.calendarEnd) errors.push('Calendar start and end are required.');
    if (draft.calendarStart && draft.calendarEnd && new Date(draft.calendarStart) >= new Date(draft.calendarEnd)) {
      errors.push('Calendar end must be after its start.');
    }
  }
  return { valid: errors.length === 0, errors };
}
