export function retrySync(operation, maxAttempts) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
