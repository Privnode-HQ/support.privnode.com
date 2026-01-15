import { redirect } from "react-router";
import { requireUser } from "./auth";
import { getSupabaseAdminDb } from "./supabase.server";

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  const supabase = getSupabaseAdminDb();

  const { data, error } = await supabase
    .from("users")
    .select("is_admin")
    .eq("uid", user.uid)
    .maybeSingle();

  if (error) {
    throw new Error(`读取权限失败：${error.message}`);
  }

  if (!data?.is_admin) {
    // Keep it simple: redirect to home.
    throw redirect("/");
  }

  return user;
}
