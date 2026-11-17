export interface SignalSource {
  once(event: 'SIGINT', listener: () => void): unknown;
  removeListener(event: 'SIGINT', listener: () => void): unknown;
}

export interface InterruptHandlers {
  readonly onFirst: () => void;
  readonly onSecond: () => void;
}

export function handleInterrupts(source: SignalSource, handlers: InterruptHandlers): () => void {
  const second = (): void => {
    handlers.onSecond();
  };

  const first = (): void => {
    handlers.onFirst();
    source.once('SIGINT', second);
  };

  source.once('SIGINT', first);

  return () => {
    source.removeListener('SIGINT', first);
    source.removeListener('SIGINT', second);
  };
}
