import { SendCancelledError } from '../domain/kernel/errors';

const cancelledBeforeAttempt = new WeakSet<SendCancelledError>();

export function cancelBeforeAttempt(message: string): SendCancelledError {
  const error = new SendCancelledError(message);

  cancelledBeforeAttempt.add(error);

  return error;
}

export function wasCancelledBeforeAttempt(error: unknown): boolean {
  return error instanceof SendCancelledError && cancelledBeforeAttempt.has(error);
}
