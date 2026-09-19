export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function abortError(): AgentError {
  return new AgentError('aborted', 'Operation aborted', 409);
}
