import { readFile } from 'node:fs/promises';
import { ConfigError } from '@mailroll/core';
import { isEnoent } from '../fs/is-enoent';

const BYTE_ORDER_MARK = '﻿';

function parse(path: string, raw: string): unknown {
  try {
    return JSON.parse(raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw);
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${path}`, { cause: error });
  }
}

export async function readJson(path: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path}`, { cause: error });
  }

  return parse(path, raw);
}

export async function readOptionalJson(path: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }

    throw new ConfigError(`cannot read ${path}`, { cause: error });
  }

  return parse(path, raw);
}
