import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

function getJwtRole(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json) as { role?: string };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function assertServiceRoleKey(key: string) {
  const role = getJwtRole(key);
  if (role && role !== "service_role") {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY 不是 service_role key（role=${role}）。请在 Supabase Dashboard → Settings → API 中复制 service_role secret key。`
    );
  }
}

export function getSupabaseAdmin() {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error(
      "缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（请先配置 Supabase）"
    );
  }

  assertServiceRoleKey(env.supabaseServiceRoleKey);

  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: env.supabaseDbSchema,
    },
  });
}

export function getSupabaseAdminDb() {
  // Alias for getSupabaseAdmin(): the client is already configured with db.schema.
  return getSupabaseAdmin();
}

export function getSupabaseAdminOptional() {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
  assertServiceRoleKey(env.supabaseServiceRoleKey);
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: env.supabaseDbSchema,
    },
  });
}

export function getSupabaseAdminDbOptional() {
  return getSupabaseAdminOptional();
}
