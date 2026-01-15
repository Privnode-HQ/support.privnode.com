function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`缺少环境变量：${name}`);
  }
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? "development";

export const env = {
  nodeEnv,
  sessionSecret: () => required("SESSION_SECRET"),

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseDbSchema: process.env.SUPABASE_DB_SCHEMA ?? "app",

  // If enabled, /login will go through local mock SSO flow.
  // Never enable mock in production.
  mockSsoEnabled: process.env.MOCK_SSO === "true" && nodeEnv !== "production",
  mockSsoJwtSecret: process.env.MOCK_SSO_JWT_SECRET ?? "dev-mock-sso-secret",

  // Privnode SSO JWT verification.
  // - HS256: set SSO_JWT_SECRET
  // - RS256: set SSO_JWT_PUBLIC_KEY_PEM
  ssoJwtAlg: (process.env.SSO_JWT_ALG ?? "HS256") as "HS256" | "RS256",
  ssoJwtSecret: process.env.SSO_JWT_SECRET,
  ssoJwtPublicKeyPem: process.env.SSO_JWT_PUBLIC_KEY_PEM,
};
