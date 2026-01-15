import { createHmac } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import * as cookie from "cookie";
import { env } from "./env";

export type SessionUser = {
  uid: number;
  username: string;
  authtk: string;
  // Server-side only: later we can enrich it with DB role.
};

type SessionPayload = {
  u: SessionUser;
};

const SESSION_COOKIE = "pn_session";

function isProd() {
  return env.nodeEnv === "production";
}

function getSessionKey() {
  // Allow shorter dev secrets but keep a minimum sanity check.
  const secret = env.sessionSecret();
  if (secret.length < 16) {
    throw new Error("SESSION_SECRET 太短，至少需要 16 个字符");
  }
  return new TextEncoder().encode(secret);
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const raw = request.headers.get("Cookie") ?? "";
  const parsed = cookie.parse(raw);
  const token = parsed[SESSION_COOKIE];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSessionKey());
    const u = (payload as any).u;
    if (!u || typeof u.uid !== "number" || typeof u.username !== "string") return null;
    if (typeof u.authtk !== "string") return null;
    return u as SessionUser;
  } catch {
    return null;
  }
}

export async function commitSessionUser(user: SessionUser): Promise<string> {
  // Session JWT is our own token (not the Privnode SSO token).
  // It only needs to be verifiable by this app.
  const jwt = await new SignJWT({ u: user } satisfies SessionPayload as any)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSessionKey());

  return cookie.serialize(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export function destroySession(): string {
  return cookie.serialize(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 0,
  });
}

// A small utility for flow state (nonce/metadata). We intentionally keep it short-lived.
const PRELOGIN_COOKIE = "pn_prelogin";

type PreloginPayload = {
  nonce: string;
  metadata: string;
  returnTo: string;
  // For cheap tamper detection (in addition to signature).
  sig: string;
};

function signPrelogin(nonce: string, metadata: string, returnTo: string) {
  const secret = env.sessionSecret();
  const h = createHmac("sha256", secret);
  h.update(`${nonce}.${metadata}.${returnTo}`);
  return h.digest("base64url");
}

export function commitPrelogin(params: {
  nonce: string;
  metadata: string;
  returnTo: string;
}): string {
  const payload: PreloginPayload = {
    ...params,
    sig: signPrelogin(params.nonce, params.metadata, params.returnTo),
  };

  return cookie.serialize(PRELOGIN_COOKIE, Buffer.from(JSON.stringify(payload)).toString("base64url"), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 60 * 10,
  });
}

export function readPrelogin(request: Request): {
  nonce: string;
  metadata: string;
  returnTo: string;
} | null {
  const raw = request.headers.get("Cookie") ?? "";
  const parsed = cookie.parse(raw);
  const value = parsed[PRELOGIN_COOKIE];
  if (!value) return null;

  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    const payload = JSON.parse(json) as PreloginPayload;
    if (!payload?.nonce || !payload?.metadata || !payload?.returnTo || !payload?.sig) return null;
    const expected = signPrelogin(payload.nonce, payload.metadata, payload.returnTo);
    if (payload.sig !== expected) return null;
    return { nonce: payload.nonce, metadata: payload.metadata, returnTo: payload.returnTo };
  } catch {
    return null;
  }
}

export function destroyPrelogin(): string {
  return cookie.serialize(PRELOGIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    path: "/",
    maxAge: 0,
  });
}

