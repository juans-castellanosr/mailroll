import { errorCode } from './error-code';

export function isEnoent(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
