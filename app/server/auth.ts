import { redirect } from "react-router";
import { getSessionUser, type SessionUser } from "./session";
import { safeReturnTo } from "./url";

export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (user) return user;

  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.pathname + url.search, "/");
  throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

