export class CrmStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "CrmStateError";
  }
}
