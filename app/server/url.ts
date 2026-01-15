// Only allow relative in-app redirects to prevent open redirect bugs.
export function safeReturnTo(input: string | null | undefined, fallback = "/") {
  if (!input) return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback;
  return input;
}

