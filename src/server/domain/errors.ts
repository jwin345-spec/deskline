/** Base class for failures that map to a user-facing response. */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
}

export class NotFoundError extends DomainError {
  readonly status = 404;
  readonly code = 'not_found';
  constructor(what = 'Resource') {
    super(`${what} not found`);
  }
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
  readonly code = 'forbidden';
  constructor(message = 'You do not have permission to do that') {
    super(message);
  }
}

export class UnauthenticatedError extends DomainError {
  readonly status = 401;
  readonly code = 'unauthenticated';
  constructor() {
    super('Sign in to continue');
  }
}

export class ValidationError extends DomainError {
  readonly status = 422;
  readonly code = 'validation_failed';
}

export class ConflictError extends DomainError {
  readonly status = 409;
  readonly code = 'conflict';
}

export class ServiceUnavailableError extends DomainError {
  readonly status = 503;
  readonly code: string;
  constructor(message: string, code = 'unavailable') {
    super(message);
    this.code = code;
  }
}
