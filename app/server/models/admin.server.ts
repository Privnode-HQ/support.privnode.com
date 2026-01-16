import { getSupabaseAdminDb } from "../supabase.server";
import type { TicketStatus } from "../../shared/tickets";

export type AdminUserRow = {
  uid: number;
  username: string;
  display_name: string | null;
  is_admin: boolean;
  last_login_at: string | null;
  created_at: string;
};

export async function listAllUsers(): Promise<AdminUserRow[]> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("users")
    .select("uid,username,display_name,is_admin,last_login_at,created_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`读取用户失败：${error.message}`);
  return (data ?? []) as any;
}

export async function updateMyDisplayName(params: {
  uid: number;
  displayName: string;
}) {
  const supabase = getSupabaseAdminDb();
  const { error } = await supabase
    .from("users")
    .update({ display_name: params.displayName })
    .eq("uid", params.uid);
  if (error) throw new Error(`更新显示名称失败：${error.message}`);
}

export type AdminTicketListItem = {
  id: string;
  short_id: string;
  subject: string;
  status: TicketStatus;
  creator_uid: number;
  category_id: string;
  assigned_to_uid: number | null;
  updated_at: string;
  created_at: string;
};

export type AdminTicketListFilters = {
  status?: TicketStatus;
  assignedToUid?: number;
  unassigned?: boolean;
  query?: string;
};

export async function listAllTickets(
  filters: AdminTicketListFilters = {}
): Promise<AdminTicketListItem[]> {
  const supabase = getSupabaseAdminDb();
  let query = supabase
    .from("tickets")
    .select(
      "id,short_id,subject,status,creator_uid,category_id,assigned_to_uid,updated_at,created_at"
    )
    .order("updated_at", { ascending: false });

  if (filters.status) {
    query = query.eq("status", filters.status);
  }
  if (filters.unassigned) {
    query = query.is("assigned_to_uid", null);
  }
  if (typeof filters.assignedToUid === "number") {
    query = query.eq("assigned_to_uid", filters.assignedToUid);
  }
  if (filters.query) {
    query = query.ilike("subject", `%${filters.query}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`读取工单失败：${error.message}`);
  return (data ?? []) as any;
}

export async function getTicketById(ticketId: string) {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("tickets")
    .select(
      "id,short_id,subject,status,creator_uid,category_id,form_data,assigned_to_uid,closed_reason,created_at,updated_at,closed_at"
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw new Error(`读取工单失败：${error.message}`);
  return data as any;
}

export async function assignTicket(params: { ticketId: string; uid: number }) {
  const supabase = getSupabaseAdminDb();
  const { data: updated, error } = await supabase
    .from("tickets")
    .update({ assigned_to_uid: params.uid, status: "assigned" })
    .eq("id", params.ticketId)
    .neq("status", "closed")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`分配工单失败：${error.message}`);

  if (!updated) return;

  const { error: msgErr } = await supabase.from("ticket_messages").insert({
    ticket_id: params.ticketId,
    actor: "system",
    body_markdown: "工单已分配给工作人员。",
  });
  if (msgErr) throw new Error(`创建系统消息失败：${msgErr.message}`);
}

export async function addAdminReply(params: {
  ticketId: string;
  actor: "staff" | "anonymous" | "system";
  authorUid: number;
  authorDisplayName: string;
  bodyMarkdown: string;
}): Promise<{ messageId: string }> {
  const supabase = getSupabaseAdminDb();
  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("status")
    .eq("id", params.ticketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (!t) throw new Error("工单不存在。");
  if ((t as any).status === "closed") throw new Error("工单已关闭，无法回复。");

  const authorDisplayName =
    params.actor === "anonymous" ? null : params.authorDisplayName;
  const authorUid = params.actor === "system" ? null : params.authorUid;

  const { data: msg, error: msgErr } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: params.ticketId,
      actor: params.actor,
      author_uid: authorUid,
      author_display_name: authorDisplayName,
      body_markdown: params.bodyMarkdown,
    })
    .select("id")
    .single();
  if (msgErr) throw new Error(`发送回复失败：${msgErr.message}`);

  const { error: upErr } = await supabase
    .from("tickets")
    .update({ status: "replied_by_staff" })
    .eq("id", params.ticketId);
  if (upErr) throw new Error(`更新工单状态失败：${upErr.message}`);

  return { messageId: (msg as any).id };
}

export async function closeTicketAsAdmin(params: {
  ticketId: string;
  reason: string;
}) {
  const supabase = getSupabaseAdminDb();

  const reason = params.reason.trim() || "已完成";
  const { data: updated, error } = await supabase
    .from("tickets")
    .update({
      status: "closed",
      closed_reason: reason,
      closed_at: new Date().toISOString(),
    })
    .eq("id", params.ticketId)
    .neq("status", "closed")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`关闭工单失败：${error.message}`);

  if (!updated) return;

  const { error: msgErr } = await supabase.from("ticket_messages").insert({
    ticket_id: params.ticketId,
    actor: "system",
    body_markdown: `工作人员关闭了工单（原因：${reason}）。`,
  });
  if (msgErr) throw new Error(`创建系统消息失败：${msgErr.message}`);
}

export type AdminCategoryRow = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sort_order: number;
  form_schema: any;
  created_at: string;
  updated_at: string;
};

export async function listAllCategories(): Promise<AdminCategoryRow[]> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_categories")
    .select(
      "id,name,description,enabled,sort_order,form_schema,created_at,updated_at"
    )
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`读取分类失败：${error.message}`);
  return (data ?? []) as any;
}

export async function createCategory(params: {
  name: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
  formSchema: any;
}) {
  const supabase = getSupabaseAdminDb();
  const { error } = await supabase.from("ticket_categories").insert({
    name: params.name,
    description: params.description,
    sort_order: params.sortOrder,
    enabled: params.enabled,
    form_schema: params.formSchema ?? [],
  });
  if (error) throw new Error(`创建分类失败：${error.message}`);
}

export async function updateCategory(params: {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  enabled: boolean;
  formSchema: any;
}) {
  const supabase = getSupabaseAdminDb();
  const { error } = await supabase
    .from("ticket_categories")
    .update({
      name: params.name,
      description: params.description,
      sort_order: params.sortOrder,
      enabled: params.enabled,
      form_schema: params.formSchema ?? [],
    })
    .eq("id", params.id);
  if (error) throw new Error(`更新分类失败：${error.message}`);
}
