/** Remove the selected API key before an error can reach the UI or log. */
export function redact(message: string, apiKey: string | undefined): string {
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}

/** Keep useful network cause details while discarding unsanitized error objects. */
export function networkFailure(error: unknown, apiKey: string | undefined): Error {
  const source = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const cause = source?.cause;
  const code = typeof cause?.code === "string" ? redact(cause.code, apiKey) : undefined;
  const causeMessage = typeof cause?.message === "string" ? redact(cause.message, apiKey) : undefined;
  const details = [code, causeMessage].filter(Boolean).join(" ");
  const message = typeof source?.message === "string" ? source.message : String(error);
  return new Error(details || redact(message, apiKey), {
    cause: { code, message: causeMessage },
  });
}
