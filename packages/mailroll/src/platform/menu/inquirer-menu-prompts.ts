import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { forTerminal } from '../terminal/terminal-text';
import type { MenuChoice, MenuPrompts } from './menu-prompts';

const PAGE_SIZE = 15;
const CONTEXT = { output: process.stderr };

const safeChoice = <V, C extends MenuChoice<V>>(choice: C): C => ({
  ...choice,
  name: forTerminal(choice.name),
  ...(choice.description !== undefined ? { description: forTerminal(choice.description) } : {}),
});

export const inquirerMenuPrompts: MenuPrompts = {
  select: (message, choices, defaultValue) =>
    select(
      {
        message: forTerminal(message),
        pageSize: PAGE_SIZE,
        choices: choices.map((choice) => safeChoice(choice)),
        ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      },
      CONTEXT,
    ),
  checkbox: (message, choices) =>
    checkbox(
      {
        message: forTerminal(message),
        pageSize: PAGE_SIZE,
        required: true,
        choices: choices.map((choice) => safeChoice(choice)),
      },
      CONTEXT,
    ),
  confirm: (message, defaultValue) => confirm({ message: forTerminal(message), default: defaultValue }, CONTEXT),
  input: (message, options) =>
    input(
      {
        message: forTerminal(message),
        validate: options.validate,
        ...(options.default !== undefined ? { default: options.default } : {}),
      },
      CONTEXT,
    ),
  print: (lines) => {
    process.stderr.write(`${lines.map(forTerminal).join('\n')}\n`);
  },
};
