export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: {
    attempts: number;
    delayMs: number;
    sleep?: (milliseconds: number) => Promise<void>;
    shouldRetry?: (error: unknown) => boolean;
  },
) {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new Error("Retry attempts must be a positive integer");
  }
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts || options.shouldRetry?.(error) === false) break;
      await sleep(options.delayMs * attempt);
    }
  }
  throw lastError;
}
