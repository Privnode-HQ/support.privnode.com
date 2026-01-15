import type { Route } from "./+types/sso.callback";
import { data, redirect } from "react-router";
import {
  commitSessionUser,
  destroyPrelogin,
  readPrelogin,
} from "../server/session";
import { verifySsoToken } from "../server/sso";
import { ensureUserFromSso } from "../server/models/users.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const nonce = url.searchParams.get("nonce") ?? "";
  const metadata = url.searchParams.get("metadata") ?? "";
  const token = url.searchParams.get("token") ?? "";

  const prelogin = readPrelogin(request);
  if (!prelogin) {
    return data(
      { ok: false as const, error: "登录状态已过期，请重新登录。" },
      { status: 400 }
    );
  }

  if (prelogin.nonce !== nonce || prelogin.metadata !== metadata) {
    return data(
      { ok: false as const, error: "登录校验失败（nonce/metadata 不匹配）。" },
      { status: 400 }
    );
  }

  if (!token) {
    return data(
      { ok: false as const, error: "缺少 token 参数。" },
      { status: 400 }
    );
  }

  try {
    const payload = await verifySsoToken(token);

    // Best-effort: sync user record to Supabase if configured.
    await ensureUserFromSso({ uid: payload.uid, username: payload.username });

    const setSession = await commitSessionUser({
      uid: payload.uid,
      username: payload.username,
      authtk: payload.authtk,
    });

    const headers = new Headers();
    headers.append("Set-Cookie", setSession);
    headers.append("Set-Cookie", destroyPrelogin());

    return redirect(prelogin.returnTo, {
      headers,
    });
  } catch (e: any) {
    return data(
      {
        ok: false as const,
        error:
          e instanceof Error ? e.message : "登录失败（无法验证 token）。",
      },
      {
        status: 400,
        headers: {
          "Set-Cookie": destroyPrelogin(),
        },
      }
    );
  }
}

export default function SsoCallback({ loaderData }: Route.ComponentProps) {
  if (loaderData?.ok === false) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">登录失败</h1>
        <p className="text-default-600">{loaderData.error}</p>
        <a className="text-primary underline" href="/login">
          返回登录
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">正在跳转…</h1>
      <p className="text-default-600">如果页面没有自动跳转，请返回重新登录。</p>
    </div>
  );
}
