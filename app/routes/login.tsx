import type { Route } from "./+types/login";
import { randomUUID } from "node:crypto";
import { redirect } from "react-router";
import { env } from "../server/env";
import { commitPrelogin, getSessionUser } from "../server/session";
import { buildPrivnodeSsoUrl } from "../server/sso";
import { safeReturnTo } from "../server/url";

export async function loader({ request }: Route.LoaderArgs) {
  const existing = await getSessionUser(request);
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"), "/tickets");

  if (existing) {
    return redirect(returnTo);
  }

  const nonce = randomUUID();
  const metadata = Buffer.from(
    JSON.stringify({ v: 1, t: Date.now(), returnTo })
  ).toString("base64url");

  const setCookie = commitPrelogin({ nonce, metadata, returnTo });

  if (env.mockSsoEnabled) {
    return redirect(`/mock-sso?nonce=${encodeURIComponent(nonce)}&metadata=${encodeURIComponent(metadata)}`,
      {
        headers: { "Set-Cookie": setCookie },
      }
    );
  }

  const host = new URL(request.url).host;
  const ssoUrl = buildPrivnodeSsoUrl({ host, nonce, metadata });
  return redirect(ssoUrl, { headers: { "Set-Cookie": setCookie } });
}

export default function Login() {
  return null;
}
