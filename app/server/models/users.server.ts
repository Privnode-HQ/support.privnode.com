import { getSupabaseAdminDbOptional } from "../supabase.server";
import { env } from "../env";

export async function ensureUserFromSso(params: { uid: number; username: string }) {
  const supabase = getSupabaseAdminDbOptional();
  if (!supabase) {
    // Allow the app to run without Supabase during early development.
    return;
  }

  const now = new Date().toISOString();
  const { data: existing, error: selectError } = await supabase
    .from("users")
    .select("uid, display_name")
    .eq("uid", params.uid)
    .maybeSingle();

  if (selectError) {
    if (selectError.message.startsWith("Invalid schema:")) {
      throw new Error(
        `读取用户失败：${selectError.message}。请在 Supabase Dashboard → Settings → API → Schemas 中将 \`${env.supabaseDbSchema}\` 加入 Exposed schemas，然后在 SQL Editor 执行：notify pgrst, 'reload schema';`
      );
    }
    if (selectError.message.includes("permission denied for schema")) {
      throw new Error(
        `读取用户失败：${selectError.message}。请在 Supabase SQL Editor 执行：grant usage on schema ${env.supabaseDbSchema} to service_role; grant all privileges on all tables in schema ${env.supabaseDbSchema} to service_role;`
      );
    }
    throw new Error(`读取用户失败：${selectError.message}`);
  }

  if (!existing) {
    const { error } = await supabase.from("users").insert({
      uid: params.uid,
      username: params.username,
      display_name: params.username,
      last_login_at: now,
    });
    if (error) throw new Error(`创建用户失败：${error.message}`);
    return;
  }

  const { error } = await supabase
    .from("users")
    .update({ username: params.username, last_login_at: now })
    .eq("uid", params.uid);
  if (error) throw new Error(`更新用户失败：${error.message}`);
}
