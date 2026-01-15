import { getSupabaseAdminDb } from "../supabase.server";
import type { TicketStatus } from "../../shared/tickets";

export type TicketListItem = {
  id: string;
  subject: string;
  status: TicketStatus;
  category_id: string;
  category_name: string | null;
  created_at: string;
  updated_at: string;
};

export type TicketDetails = {
  id: string;
  subject: string;
  status: TicketStatus;
  category_id: string;
  category_name: string | null;
  form_data: any;
  assigned_to_uid: number | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type TicketMessage = {
  id: string;
  actor: "customer" | "staff" | "system" | "anonymous";
  author_uid: number | null;
  author_display_name: string | null;
  body_markdown: string;
  created_at: string;
};

export async function listTicketsForUser(uid: number): Promise<TicketListItem[]> {
  const supabase = getSupabaseAdminDb();

  const { data: tickets, error } = await supabase
    .from("tickets")
    .select("id,subject,status,category_id,created_at,updated_at")
    .eq("creator_uid", uid)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(`读取工单失败：${error.message}`);
  const list = (tickets ?? []) as Omit<TicketListItem, "category_name">[];

  const categoryIds = Array.from(new Set(list.map((t) => t.category_id)));
  const categoryMap = new Map<string, string>();
  if (categoryIds.length > 0) {
    const { data: categories, error: catErr } = await supabase
      .from("ticket_categories")
      .select("id,name")
      .in("id", categoryIds);
    if (catErr) throw new Error(`读取分类失败：${catErr.message}`);
    for (const c of categories ?? []) {
      categoryMap.set((c as any).id, (c as any).name);
    }
  }

  return list.map((t) => ({
    ...(t as any),
    category_name: categoryMap.get(t.category_id) ?? null,
  }));
}

export async function createTicket(params: {
  creatorUid: number;
  creatorDisplayName: string;
  categoryId: string;
  subject: string;
  formData: any;
  bodyMarkdown: string;
}): Promise<{ id: string; messageId: string }> {
  const supabase = getSupabaseAdminDb();

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      creator_uid: params.creatorUid,
      category_id: params.categoryId,
      subject: params.subject,
      form_data: params.formData ?? {},
      status: "pending_assign",
    })
    .select("id")
    .single();

  if (error) throw new Error(`创建工单失败：${error.message}`);

  const ticketId = (ticket as any).id as string;
  const { data: msg, error: msgErr } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticketId,
      actor: "customer",
      author_uid: params.creatorUid,
      author_display_name: params.creatorDisplayName,
      body_markdown: params.bodyMarkdown,
    })
    .select("id")
    .single();
  if (msgErr) throw new Error(`创建工单首条消息失败：${msgErr.message}`);

  return { id: ticketId, messageId: (msg as any).id };
}

export async function getTicketForUser(params: {
  uid: number;
  ticketId: string;
}): Promise<TicketDetails | null> {
  const supabase = getSupabaseAdminDb();
  const { data: t, error } = await supabase
    .from("tickets")
    .select(
      "id,subject,status,category_id,form_data,assigned_to_uid,closed_reason,created_at,updated_at,closed_at"
    )
    .eq("id", params.ticketId)
    .eq("creator_uid", params.uid)
    .maybeSingle();
  if (error) throw new Error(`读取工单失败：${error.message}`);
  if (!t) return null;

  const categoryId = (t as any).category_id as string;
  let categoryName: string | null = null;
  const { data: cat, error: catErr } = await supabase
    .from("ticket_categories")
    .select("name")
    .eq("id", categoryId)
    .maybeSingle();
  if (catErr) throw new Error(`读取分类失败：${catErr.message}`);
  categoryName = (cat as any)?.name ?? null;

  return {
    ...(t as any),
    category_name: categoryName,
  } as any;
}

export async function listMessages(ticketId: string): Promise<TicketMessage[]> {
  const supabase = getSupabaseAdminDb();
  const { data: msgs, error } = await supabase
    .from("ticket_messages")
    .select("id,actor,author_uid,author_display_name,body_markdown,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`读取消息失败：${error.message}`);
  return (msgs ?? []) as any;
}

export async function addCustomerReply(params: {
  uid: number;
  displayName: string;
  ticketId: string;
  bodyMarkdown: string;
}): Promise<{ messageId: string }> {
  const supabase = getSupabaseAdminDb();

  // Ensure ticket belongs to user and isn't closed.
  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("id,status")
    .eq("id", params.ticketId)
    .eq("creator_uid", params.uid)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (!t) throw new Error("工单不存在或无权限。");
  if ((t as any).status === "closed") throw new Error("工单已关闭，无法回复。");

  const { data: msg, error: msgErr } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: params.ticketId,
      actor: "customer",
      author_uid: params.uid,
      author_display_name: params.displayName,
      body_markdown: params.bodyMarkdown,
    })
    .select("id")
    .single();
  if (msgErr) throw new Error(`发送回复失败：${msgErr.message}`);

  const { error: upErr } = await supabase
    .from("tickets")
    .update({ status: "replied_by_customer" })
    .eq("id", params.ticketId);
  if (upErr) throw new Error(`更新工单状态失败：${upErr.message}`);

  return { messageId: (msg as any).id };
}

export async function closeTicket(params: {
  uid: number;
  ticketId: string;
  reason: string;
}) {
  const supabase = getSupabaseAdminDb();
  const { error } = await supabase
    .from("tickets")
    .update({
      status: "closed",
      closed_reason: params.reason,
      closed_at: new Date().toISOString(),
    })
    .eq("id", params.ticketId)
    .eq("creator_uid", params.uid)
    .neq("status", "closed");
  if (error) throw new Error(`关闭工单失败：${error.message}`);
}

export function ticketStatusLabel(s: TicketStatus): string {
  switch (s) {
    case "pending_assign":
      return "待分配";
    case "assigned":
      return "已分配";
    case "replied_by_staff":
      return "已被工作人员回复";
    case "replied_by_customer":
      return "已被客户回复";
    case "closed":
      return "被关闭";
    default:
      return s;
  }
}
