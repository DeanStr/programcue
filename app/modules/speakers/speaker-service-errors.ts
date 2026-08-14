export class SpeakerAdminStateError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "SpeakerAdminStateError";
    this.status = status;
  }
}

export class SpeakerAdminIntegrityError extends SpeakerAdminStateError {
  constructor(message: string) {
    super(message, 500);
    this.name = "SpeakerAdminIntegrityError";
  }
}
