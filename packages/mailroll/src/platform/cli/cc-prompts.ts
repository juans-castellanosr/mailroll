import { checkbox, input } from '@inquirer/prompts';
import { type EmailAddress, normalizeEmail, parseEmailAddress } from '@mailroll/core';
import type { CcPrompts } from './cc';

const CONTEXT = { output: process.stderr };

export const inquirerCcPrompts: CcPrompts = {
  pickFromList: (choices: readonly EmailAddress[], checked: readonly EmailAddress[]): Promise<readonly string[]> =>
    checkbox<string>(
      {
        message: 'Select CC addresses to copy on every email (space to toggle, enter to confirm)',
        choices: choices.map((address) => ({
          name: address,
          value: address,
          checked: checked.some((c) => normalizeEmail(c) === normalizeEmail(address)),
        })),
      },
      CONTEXT,
    ),
  addNew: (): Promise<string> =>
    input(
      {
        message: 'Additional CC addresses (comma-separated, blank to skip)',
        validate: (value: string): true | string => {
          const invalid = value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .find((part) => !parseEmailAddress(part).ok);

          return invalid === undefined ? true : `"${invalid}" is not a valid email`;
        },
      },
      CONTEXT,
    ),
};
