import { getSupabaseAdminDb } from "../supabase.server";

export type TicketCategory = {
  id: string;
  name: string;
  description: string | null;
  form_schema: unknown;
};

export async function listEnabledCategories(): Promise<TicketCategory[]> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_categories")
    .select("id,name,description,form_schema")
    .eq("enabled", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`读取工单分类失败：${error.message}`);
  }

  return (data ?? []) as TicketCategory[];
}

export async function getCategoryById(id: string): Promise<TicketCategory | null> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_categories")
    .select("id,name,description,form_schema")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`读取工单分类失败：${error.message}`);
  }
  return (data as any) ?? null;
}
