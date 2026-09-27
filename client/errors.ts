/**
 * RPC failures arrive as `Error`s with the daemon's message, but a thrown non-Error (or a string
 * rejection) must not render as `[object Object]` on the screen.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "The request failed";
}
