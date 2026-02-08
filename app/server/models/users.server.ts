import { getSupabaseAdminDb, getSupabaseAdminDbOptional } from "../supabase.server";

const IS_ADMIN_CACHE_TTL_MS = 30 * 1000;

type CacheEntry = {
  value: boolean;
  expiresAtMs: number;
};

const isAdminCache = new Map<number, CacheEntry>();
const isAdminInFlight = new Map<number, Promise<boolean>>();

export async function getIsAdminForUid(uid: number): Promise<boolean> {
  const safeUid = Number(uid);
  if (!Number.isFinite(safeUid)) return false;

  const now = Date.now();
  const cached = isAdminCache.get(safeUid);
  if (cached && cached.expiresAtMs > now) return cached.value;

  const pending = isAdminInFlight.get(safeUid);
  if (pending) return pending;

  const p = (async () => {
    const supabase = getSupabaseAdminDb();
    const { data, error } = await supabase
      .from("users")
      .select("is_admin")
      .eq("uid", safeUid)
      .maybeSingle();
    if (error) {
      throw new Error(`读取权限失败：${error.message}`);
    }

    const isAdmin = Boolean((data as any)?.is_admin);
    isAdminCache.set(safeUid, {
      value: isAdmin,
      expiresAtMs: Date.now() + IS_ADMIN_CACHE_TTL_MS,
    });
    return isAdmin;
  })();

  isAdminInFlight.set(safeUid, p);
  try {
    return await p;
  } finally {
    isAdminInFlight.delete(safeUid);
  }
}

export async function ensureUserFromSso(params: {
  uid: number;
  username: string;
}): Promise<void> {
  const supabase = getSupabaseAdminDbOptional();
  if (!supabase) return;

  const uid = Number(params.uid);
  const username = String(params.username ?? "").trim();
  if (!Number.isFinite(uid) || !username) return;

  const { error } = await supabase.from("users").upsert(
    {
      uid,
      username,
      last_login_at: new Date().toISOString(),
    },
    {
      onConflict: "uid",
    },
  );

  if (error) {
    throw new Error(`同步用户失败：${error.message}`);
  }
}
