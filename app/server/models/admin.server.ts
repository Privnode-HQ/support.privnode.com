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
  nudge_last_at: string | null;
  nudge_pending: boolean;
  updated_at: string;
  created_at: string;
};

export type AdminTicketSort = "updated_at" | "created_at" | "smart";
export type AdminTicketSortDirection = "asc" | "desc";

export type AdminTicketListFilters = {
  statuses?: TicketStatus[];
  status?: TicketStatus;
  assignedToUids?: number[];
  assignedToUid?: number;
  unassigned?: boolean;
  query?: string;
  sort?: AdminTicketSort;
  sortDirection?: AdminTicketSortDirection;
};

export async function listAllTickets(
  filters: AdminTicketListFilters = {}
): Promise<AdminTicketListItem[]> {
  const supabase = getSupabaseAdminDb();

  const sort: AdminTicketSort =
    filters.sort === "created_at" ||
    filters.sort === "updated_at" ||
    filters.sort === "smart"
      ? filters.sort
      : "updated_at";
  const sortDirection: AdminTicketSortDirection =
    filters.sortDirection === "asc" || filters.sortDirection === "desc"
      ? filters.sortDirection
      : "desc";
  const ascending = sortDirection === "asc";

  let query = supabase
    .from("tickets")
    .select(
      "id,short_id,subject,status,creator_uid,category_id,assigned_to_uid,updated_at,created_at"
    );

  const statuses =
    filters.statuses && filters.statuses.length > 0
      ? filters.statuses
      : filters.status
        ? [filters.status]
        : [];
  if (statuses.length > 0) {
    query = query.in("status", statuses);
  }

  const assignedToUids = Array.from(
    new Set(
      [
        ...(filters.assignedToUids ?? []),
        ...(typeof filters.assignedToUid === "number" ? [filters.assignedToUid] : []),
      ].filter((uid): uid is number => Number.isFinite(uid))
    )
  );

  if (filters.unassigned && assignedToUids.length > 0) {
    query = query.or(
      `assigned_to_uid.is.null,assigned_to_uid.in.(${assignedToUids.join(",")})`
    );
  } else if (filters.unassigned) {
    query = query.is("assigned_to_uid", null);
  } else if (assignedToUids.length > 0) {
    query = query.in("assigned_to_uid", assignedToUids);
  }

  if (filters.query) {
    query = query.ilike("subject", `%${filters.query}%`);
  }

  if (sort === "created_at") {
    query = query.order("created_at", { ascending });
  } else {
    query = query.order("updated_at", { ascending: sort === "smart" ? false : ascending });
  }
  query = query.order("id", { ascending: true });

  const { data, error } = await query;
  if (error) throw new Error(`读取工单失败：${error.message}`);

  const list = (data ?? []) as Omit<AdminTicketListItem, "nudge_last_at" | "nudge_pending">[];
  if (list.length === 0) return [];

  const ticketIds = list.map((t) => t.id);

  const [nudgesRes, messagesRes] = await Promise.all([
    supabase
      .from("ticket_nudges")
      .select("ticket_id,created_at")
      .in("ticket_id", ticketIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("ticket_messages")
      .select("ticket_id,actor,created_at")
      .in("ticket_id", ticketIds)
      .in("actor", ["customer", "staff", "anonymous"]),
  ]);
  if (nudgesRes.error)
    throw new Error(`读取催单记录失败：${nudgesRes.error.message}`);
  if (messagesRes.error)
    throw new Error(`读取消息统计失败：${messagesRes.error.message}`);

  const lastNudgeAtMsByTicket = new Map<string, number>();
  const nudgeCountByTicket = new Map<string, number>();
  const lastNudgeAtRawByTicket = new Map<string, string>();
  for (const row of nudgesRes.data ?? []) {
    const ticketId = (row as any).ticket_id as string;
    const createdAt = (row as any).created_at as string;
    if (!ticketId || !createdAt) continue;

    nudgeCountByTicket.set(ticketId, (nudgeCountByTicket.get(ticketId) ?? 0) + 1);

    if (!lastNudgeAtMsByTicket.has(ticketId)) {
      const ts = new Date(createdAt).getTime();
      if (Number.isFinite(ts)) {
        lastNudgeAtMsByTicket.set(ticketId, ts);
        lastNudgeAtRawByTicket.set(ticketId, createdAt);
      }
    }
  }

  const customerMessageCountByTicket = new Map<string, number>();
  const hasStaffReplyByTicket = new Map<string, boolean>();
  const lastStaffReplyAtMsByTicket = new Map<string, number>();
  for (const row of messagesRes.data ?? []) {
    const ticketId = (row as any).ticket_id as string;
    const actor = (row as any).actor as string;
    const createdAt = (row as any).created_at as string;
    if (!ticketId || !actor || !createdAt) continue;

    if (actor === "customer") {
      customerMessageCountByTicket.set(
        ticketId,
        (customerMessageCountByTicket.get(ticketId) ?? 0) + 1
      );
      continue;
    }

    if (actor === "staff" || actor === "anonymous") {
      hasStaffReplyByTicket.set(ticketId, true);
      const ts = new Date(createdAt).getTime();
      if (!Number.isFinite(ts)) continue;
      const prev = lastStaffReplyAtMsByTicket.get(ticketId);
      if (!prev || ts > prev) lastStaffReplyAtMsByTicket.set(ticketId, ts);
    }
  }

  const withNudgeInfo = list.map((t) => {
    const lastNudgeAtMs = lastNudgeAtMsByTicket.get(t.id) ?? null;
    const lastStaffReplyAtMs = lastStaffReplyAtMsByTicket.get(t.id) ?? null;
    const nudgePending =
      t.status !== "closed" &&
      !!lastNudgeAtMs &&
      (!lastStaffReplyAtMs || lastNudgeAtMs > lastStaffReplyAtMs);

    return {
      ...(t as any),
      nudge_last_at: lastNudgeAtRawByTicket.get(t.id) ?? null,
      nudge_pending: nudgePending,
    } as AdminTicketListItem;
  });

  if (sort !== "smart") return withNudgeInfo;

  const creatorUids = Array.from(new Set(withNudgeInfo.map((t) => t.creator_uid)));
  const { data: openTickets, error: openErr } = await supabase
    .from("tickets")
    .select("creator_uid")
    .in("creator_uid", creatorUids)
    .neq("status", "closed");
  if (openErr) throw new Error(`读取用户未关闭工单数失败：${openErr.message}`);

  const openTicketCountByCreator = new Map<number, number>();
  for (const row of openTickets ?? []) {
    const uid = Number((row as any).creator_uid);
    if (!Number.isFinite(uid)) continue;
    openTicketCountByCreator.set(uid, (openTicketCountByCreator.get(uid) ?? 0) + 1);
  }

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const scored = withNudgeInfo.map((t) => {
    const customerMsgCount = customerMessageCountByTicket.get(t.id) ?? 0;
    const userReplyCount = Math.max(0, customerMsgCount - 1);
    const neverHandled = hasStaffReplyByTicket.get(t.id) ? 0 : 1;

    const totalNudges = nudgeCountByTicket.get(t.id) ?? 0;
    const everNudged = totalNudges > 0 ? 1 : 0;
    const lastNudgeAtMs = lastNudgeAtMsByTicket.get(t.id) ?? null;
    const nudgeFreshness = lastNudgeAtMs
      ? Math.max(0, 1 - (nowMs - lastNudgeAtMs) / dayMs)
      : 0;

    const rawUrgencyScore =
      1 * Math.log(1 + userReplyCount) +
      3 * neverHandled +
      2 * everNudged +
      4 * nudgeFreshness +
      1.5 * Math.log(1 + totalNudges);

    const openCount = Math.max(1, openTicketCountByCreator.get(t.creator_uid) ?? 1);
    const userPenaltyFactor = 1 / (1 + 0.6 * (openCount - 1));
    const urgencyScore = rawUrgencyScore * userPenaltyFactor;

    const updatedMs = new Date(t.updated_at).getTime();
    const createdMs = new Date(t.created_at).getTime();
    const timeScore =
      (Number.isFinite(updatedMs) ? updatedMs : 0) * 0.7 +
      (Number.isFinite(createdMs) ? createdMs : 0) * 0.3;

    return { t, urgencyScore, timeScore };
  });

  scored.sort((a, b) => {
    if (a.urgencyScore !== b.urgencyScore) {
      return ascending ? a.urgencyScore - b.urgencyScore : b.urgencyScore - a.urgencyScore;
    }
    if (a.timeScore !== b.timeScore) {
      return ascending ? a.timeScore - b.timeScore : b.timeScore - a.timeScore;
    }
    return a.t.id.localeCompare(b.t.id);
  });

  return scored.map((s) => s.t);
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
