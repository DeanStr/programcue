export class FileMultipartStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FileMultipartStateError";
  }
}

export class FileMultipartConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileMultipartConflictError";
  }
}

export class FileMultipartIncompleteError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileMultipartIncompleteError";
  }
}
