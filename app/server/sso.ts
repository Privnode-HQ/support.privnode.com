import { jwtVerify, type JWTPayload, SignJWT } from "jose";
import { env } from "./env";

export type PrivnodeSsoPayload = {
  uid: number;
  username: string;
  authtk: string;
};

export function buildPrivnodeSsoUrl(params: {
  host: string;
  nonce: string;
  metadata: string;
}): string {
  const url = new URL("https://privnode.com/sso-beta/v1");
  url.searchParams.set("protocol", "i0");
  url.searchParams.set("client_id", "ticket-v1");
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("metadata", params.metadata);
  // Spec: hostname without protocol & path (includes port in dev).
  url.searchParams.set("postauth", params.host);
  return url.toString();
}

function getSsoKey(): { alg: "HS256" | "RS256"; key: Uint8Array | CryptoKey } {
  const alg = env.ssoJwtAlg;
  if (alg === "HS256") {
    // In local mock mode, always verify with the mock secret so copying `.env.example`
    // (which contains a placeholder SSO_JWT_SECRET) won't break the flow.
    const secret = env.mockSsoEnabled ? env.mockSsoJwtSecret : env.ssoJwtSecret;
    if (!secret) {
      throw new Error("缺少 SSO_JWT_SECRET（HS256）");
    }
    return { alg, key: new TextEncoder().encode(secret) };
  }

  const pem = env.ssoJwtPublicKeyPem;
  if (!pem) {
    throw new Error("缺少 SSO_JWT_PUBLIC_KEY_PEM（RS256）");
  }
  // jose can import PEM via crypto.subtle under Node.
  // Use runtime import to avoid pulling it into client bundle.
  const key = pem;
  // We import dynamically in verifySsoToken.
  return { alg, key: key as any };
}

export async function verifySsoToken(token: string): Promise<PrivnodeSsoPayload> {
  const { alg, key } = getSsoKey();
  const verifyKey =
    alg === "RS256"
      ? await (async () => {
          const { importSPKI } = await import("jose");
          return importSPKI(key as any, alg);
        })()
      : (key as Uint8Array);

  const { payload } = await jwtVerify(token, verifyKey, { algorithms: [alg] });
  return validatePayload(payload);
}

function validatePayload(payload: JWTPayload): PrivnodeSsoPayload {
  const uid = (payload as any).uid;
  const username = (payload as any).username;
  const authtk = (payload as any).authtk;

  if (typeof uid !== "number" || !Number.isFinite(uid)) {
    throw new Error("SSO token payload.uid 无效");
  }
  if (typeof username !== "string" || username.length < 1) {
    throw new Error("SSO token payload.username 无效");
  }
  if (typeof authtk !== "string" || authtk.length < 1) {
    throw new Error("SSO token payload.authtk 无效");
  }

  return { uid, username, authtk };
}

// For local dev only: sign a mock SSO JWT that matches Privnode payload schema.
export async function signMockSsoToken(payload: PrivnodeSsoPayload): Promise<string> {
  if (!env.mockSsoEnabled) {
    throw new Error("Mock SSO 未启用（设置 MOCK_SSO=true）");
  }
  const secret = new TextEncoder().encode(env.mockSsoJwtSecret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secret);
}
