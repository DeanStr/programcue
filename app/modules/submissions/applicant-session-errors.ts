export class ApplicantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicantInputError";
  }
}

export class ApplicantConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicantConfigurationError";
  }
}

export class ApplicantDeliveryError extends Error {
  constructor(
    message = "The verification email could not be delivered. Try again later.",
  ) {
    super(message);
    this.name = "ApplicantDeliveryError";
  }
}
