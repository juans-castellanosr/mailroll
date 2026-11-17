import { type ValidationOutcome, invalid, valid } from '../kernel/validation-outcome';

declare const brand: unique symbol;
export type EmailAddress = string & { readonly [brand]: true };

const MAX_OCTETS = 254;
const MAX_LOCAL_OCTETS = 64;

const HIDDEN_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
const LOCAL_PART = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}-]{0,61}[\p{L}\p{M}\p{N}])?$/u;
const TOP_LEVEL = /^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu;

const encoder = new TextEncoder();
const octets = (text: string): number => encoder.encode(text).length;

export function parseEmailAddress(raw: unknown): ValidationOutcome<EmailAddress> {
  if (typeof raw !== 'string') {
    return invalid(['email must be text']);
  }

  const value = raw.trim().normalize('NFC');

  if (value.length === 0) {
    return invalid(['email is empty']);
  }

  if (octets(value) > MAX_OCTETS) {
    return invalid([`email exceeds ${String(MAX_OCTETS)} bytes`]);
  }

  if (HIDDEN_OR_CONTROL.test(value)) {
    return invalid(['email contains spaces, control or invisible characters']);
  }

  const at = value.indexOf('@');

  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) {
    return invalid(['email is not a valid address (it needs exactly one @ between a name and a domain)']);
  }

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);

  if (octets(local) > MAX_LOCAL_OCTETS) {
    return invalid([`email is not a valid address (the part before the @ exceeds ${String(MAX_LOCAL_OCTETS)} bytes)`]);
  }

  if (!LOCAL_PART.test(local)) {
    return invalid(['email is not a valid address (invalid characters before the @)']);
  }

  const labels = domain.split('.');
  const top = labels[labels.length - 1] ?? '';

  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label)) || !TOP_LEVEL.test(top)) {
    return invalid(['email is not a valid address (invalid domain)']);
  }

  return valid(value as EmailAddress);
}

export const normalizeEmail = (email: EmailAddress): string => email.toLowerCase();
