import { getSupabaseAdminDb } from "../supabase.server";
import type { TicketStatus } from "../../shared/tickets";
import { ensureSmartSortCronStarted, getTicketSmartScores } from "./smart-sort.server";

export const TICKET_NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

ensureSmartSortCronStarted();

const OPEN_TICKET_STATUSES: TicketStatus[] = [
  "pending_assign",
  "assigned",
  "replied_by_staff",
  "replied_by_customer",
];

function chunkArray<T>(list: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

const POSTGREST_IN_CHUNK_SIZE = 80;

export type TicketListItem = {
  id: string;
  short_id: string;
  subject: string;
  status: TicketStatus;
  category_id: string;
  category_name: string | null;
  creator_uid: number;
  is_global: boolean;
  created_at: string;
  updated_at: string;
};

export type TicketDetails = {
  id: string;
  short_id: string;
  subject: string;
  status: TicketStatus;
  category_id: string;
  category_name: string | null;
  form_data: any;
  creator_uid: number;
  is_global: boolean;
  merged_into_ticket_id: string | null;
  merged_at: string | null;
  merged_reason: string | null;
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
  deleted_at: string | null;
  deleted_by_uid: number | null;
  deleted_reason: string | null;
};

export async function getLatestTicketNudgeAt(ticketId: string): Promise<string | null> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_nudges")
    .select("created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`读取催单记录失败：${error.message}`);
  return ((data ?? [])[0] as any)?.created_at ?? null;
}

export async function createTicketNudge(params: {
  uid: number;
  ticketId: string;
}): Promise<{ nudgeId: string }> {
  const supabase = getSupabaseAdminDb();

  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("id,creator_uid,status,created_at,deleted_at,purged_at")
    .eq("id", params.ticketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (
    !t ||
    (t as any).creator_uid !== params.uid ||
    (t as any).deleted_at ||
    (t as any).purged_at
  ) {
    throw new Error("工单不存在或无权限。");
  }
  if ((t as any).status === "closed") {
    throw new Error("工单已关闭，无法催单。");
  }

  const ticketCreatedAt = new Date((t as any).created_at).getTime();
  if (!Number.isFinite(ticketCreatedAt)) throw new Error("工单创建时间无效。");

  const { data: nudges, error: nErr } = await supabase
    .from("ticket_nudges")
    .select("id,created_at")
    .eq("ticket_id", params.ticketId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (nErr) throw new Error(`读取催单记录失败：${nErr.message}`);
  const lastNudgeAtRaw = ((nudges ?? [])[0] as any)?.created_at as string | undefined;
  const lastNudgeAt = lastNudgeAtRaw ? new Date(lastNudgeAtRaw).getTime() : null;

  const baseMs = Math.max(ticketCreatedAt, lastNudgeAt ?? 0);
  const nextAllowedAtMs = baseMs + TICKET_NUDGE_COOLDOWN_MS;
  const nowMs = Date.now();

  if (nowMs < nextAllowedAtMs) {
    if (!lastNudgeAtRaw) {
      throw new Error("工单刚创建，暂时无法催单（创建后 6 小时可催单）。");
    }
    throw new Error("距离上次催单不足 6 小时，请稍后再试。");
  }

  const { data: nudge, error: insErr } = await supabase
    .from("ticket_nudges")
    .insert({
      ticket_id: params.ticketId,
      requester_uid: params.uid,
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`催单失败：${insErr.message}`);
  const nudgeId = (nudge as any).id as string;

  const { error: msgErr } = await supabase.from("ticket_messages").insert({
    ticket_id: params.ticketId,
    actor: "system",
    body_markdown: "客户发起了催单，请尽快处理。",
  });

  if (msgErr) {
    try {
      await supabase.from("ticket_nudges").delete().eq("id", nudgeId);
    } catch {
      // best-effort rollback
    }
    throw new Error(`创建系统消息失败：${msgErr.message}`);
  }

  return { nudgeId };
}

export async function getSmartQueuePositionForTicket(ticketId: string): Promise<{
  position: number;
  total: number;
} | null> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("tickets")
    .select("id,created_at,updated_at")
    .in("status", OPEN_TICKET_STATUSES)
    .is("deleted_at", null)
    .is("purged_at", null);
  if (error) throw new Error(`读取智能队列失败：${error.message}`);

  const list = (data ?? []) as any[];
  if (list.length === 0) return null;

  const ids = list.map((t) => String(t.id)).filter(Boolean);
  const scoreMap = await getTicketSmartScores(ids);

  const scored = list.map((t) => {
    const id = String(t.id);
    const score = scoreMap.get(id);
    const urgencyScore = score?.urgency_score ?? 0;
    const updatedMs = new Date(String(t.updated_at)).getTime();
    const createdMs = new Date(String(t.created_at)).getTime();
    const fallbackTimeScore =
      (Number.isFinite(updatedMs) ? updatedMs : 0) * 0.7 +
      (Number.isFinite(createdMs) ? createdMs : 0) * 0.3;
    const timeScore = score?.time_score ?? fallbackTimeScore;
    return { id, urgencyScore, timeScore };
  });

  scored.sort((a, b) => {
    if (a.urgencyScore !== b.urgencyScore) return b.urgencyScore - a.urgencyScore;
    if (a.timeScore !== b.timeScore) return b.timeScore - a.timeScore;
    return a.id.localeCompare(b.id);
  });

  const index = scored.findIndex((t) => t.id === ticketId);
  if (index < 0) return null;
  return { position: index + 1, total: scored.length };
}

export async function listTicketsForUser(uid: number): Promise<TicketListItem[]> {
  const supabase = getSupabaseAdminDb();

  const { data: createdTickets, error: cErr } = await supabase
    .from("tickets")
    .select(
      "id,short_id,subject,status,category_id,creator_uid,is_global,created_at,updated_at"
    )
    .eq("creator_uid", uid)
    .is("deleted_at", null)
    .is("purged_at", null);
  if (cErr) throw new Error(`读取工单失败：${cErr.message}`);

  const { data: globalTickets, error: gErr } = await supabase
    .from("tickets")
    .select(
      "id,short_id,subject,status,category_id,creator_uid,is_global,created_at,updated_at"
    )
    .eq("is_global", true)
    .is("deleted_at", null)
    .is("purged_at", null);
  if (gErr) throw new Error(`读取工单失败：${gErr.message}`);

  const { data: participantRows, error: pErr } = await supabase
    .from("ticket_participants")
    .select("ticket_id")
    .eq("uid", uid);
  if (pErr) throw new Error(`读取参与工单失败：${pErr.message}`);

  const participantTicketIds = Array.from(
    new Set((participantRows ?? []).map((r) => String((r as any).ticket_id ?? "")).filter(Boolean))
  );

  const participantTickets: any[] = [];
  for (const ids of chunkArray(participantTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .select(
        "id,short_id,subject,status,category_id,creator_uid,is_global,created_at,updated_at"
      )
      .in("id", ids)
      .is("deleted_at", null)
      .is("purged_at", null);
    if (error) throw new Error(`读取参与工单失败：${error.message}`);
    participantTickets.push(...(data ?? []));
  }

  const byId = new Map<string, any>();
  for (const t of [...(createdTickets ?? []), ...participantTickets, ...(globalTickets ?? [])]) {
    const id = String((t as any).id ?? "");
    if (!id) continue;
    byId.set(id, t);
  }

  const list = Array.from(byId.values()) as Omit<TicketListItem, "category_name">[];
  list.sort((a, b) => {
    const aMs = new Date(String((a as any).updated_at ?? "")).getTime();
    const bMs = new Date(String((b as any).updated_at ?? "")).getTime();
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return bMs - aMs;
    return String((b as any).id ?? "").localeCompare(String((a as any).id ?? ""));
  });

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

  try {
    const { error: pErr } = await supabase.from("ticket_participants").insert({
      ticket_id: ticketId,
      uid: params.creatorUid,
    });
    if (pErr) throw pErr;
  } catch (e) {
    // best-effort: creator_uid already grants access; do not fail ticket creation.
    console.error("Failed to insert ticket participant row:", e);
  }

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
      "id,short_id,subject,status,category_id,form_data,creator_uid,is_global,merged_into_ticket_id,merged_at,merged_reason,assigned_to_uid,closed_reason,deleted_at,purged_at,created_at,updated_at,closed_at"
    )
    .eq("id", params.ticketId)
    .maybeSingle();
  if (error) throw new Error(`读取工单失败：${error.message}`);
  if (!t) return null;
  if ((t as any).deleted_at || (t as any).purged_at) return null;

  const creatorUid = Number((t as any).creator_uid);
  const isGlobal = Boolean((t as any).is_global);
  const isCreator = Number.isFinite(creatorUid) && creatorUid === params.uid;

  if (!isGlobal && !isCreator) {
    const { data: p, error: pErr } = await supabase
      .from("ticket_participants")
      .select("ticket_id")
      .eq("ticket_id", params.ticketId)
      .eq("uid", params.uid)
      .maybeSingle();
    if (pErr) throw new Error(`校验权限失败：${pErr.message}`);
    if (!p) return null;
  }

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

export async function listMessages(
  ticketId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<TicketMessage[]> {
  const supabase = getSupabaseAdminDb();
  let query = supabase
    .from("ticket_messages")
    .select(
      "id,actor,author_uid,author_display_name,body_markdown,created_at,deleted_at,deleted_by_uid,deleted_reason"
    )
    .eq("ticket_id", ticketId)
    .is("purged_at", null)
    .order("created_at", { ascending: true });
  if (!options.includeDeleted) {
    query = query.is("deleted_at", null);
  }
  const { data: msgs, error } = await query;
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

  // Ensure user can access ticket and isn't closed.
  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("id,status,creator_uid,is_global,deleted_at,purged_at")
    .eq("id", params.ticketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (!t || (t as any).deleted_at || (t as any).purged_at) {
    throw new Error("工单不存在或无权限。");
  }

  const creatorUid = Number((t as any).creator_uid);
  const isGlobal = Boolean((t as any).is_global);
  const isCreator = Number.isFinite(creatorUid) && creatorUid === params.uid;
  if (!isGlobal && !isCreator) {
    const { data: p, error: pErr } = await supabase
      .from("ticket_participants")
      .select("ticket_id")
      .eq("ticket_id", params.ticketId)
      .eq("uid", params.uid)
      .maybeSingle();
    if (pErr) throw new Error(`校验权限失败：${pErr.message}`);
    if (!p) throw new Error("工单不存在或无权限。");
  }

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

  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("creator_uid,status,deleted_at,purged_at")
    .eq("id", params.ticketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (!t || (t as any).deleted_at || (t as any).purged_at) {
    throw new Error("工单不存在或无权限。");
  }
  if ((t as any).status === "closed") return;
  if (Number((t as any).creator_uid) !== params.uid) {
    throw new Error("仅工单创建者可以关闭工单。");
  }

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
    body_markdown: `客户关闭了工单（原因：${reason}）。`,
  });
  if (msgErr) throw new Error(`创建系统消息失败：${msgErr.message}`);
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

export async function getTicketIdByShortId(
  shortId: string
): Promise<string | null> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("tickets")
    .select("id,creator_uid")
    .eq("short_id", shortId)
    .is("purged_at", null)
    .maybeSingle();
  if (error) throw new Error(`通过 short_id 查找工单失败：${error.message}`);
  if (!data) return null;
  return (data as any).id;
}

export async function canUserAccessTicket(
  uid: number,
  ticketId: string
): Promise<boolean> {
  const supabase = getSupabaseAdminDb();
  const { data: t, error: tErr } = await supabase
    .from("tickets")
    .select("id,creator_uid,is_global,deleted_at,purged_at")
    .eq("id", ticketId)
    .maybeSingle();
  if (tErr || !t) return false;
  if ((t as any).deleted_at || (t as any).purged_at) return false;
  if (Boolean((t as any).is_global)) return true;
  if (Number((t as any).creator_uid) === uid) return true;

  const { data: p, error: pErr } = await supabase
    .from("ticket_participants")
    .select("ticket_id")
    .eq("ticket_id", ticketId)
    .eq("uid", uid)
    .maybeSingle();
  if (pErr) return false;
  return !!p;
}

export type TicketParticipantUser = {
  uid: number;
  username: string;
  display_name: string | null;
  is_admin: boolean;
};

export async function listParticipantsForTicket(
  ticketId: string
): Promise<TicketParticipantUser[]> {
  const supabase = getSupabaseAdminDb();
  const { data: rows, error } = await supabase
    .from("ticket_participants")
    .select("uid,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`读取工单参与者失败：${error.message}`);

  const uids = Array.from(
    new Set((rows ?? []).map((r) => Number((r as any).uid)).filter((v) => Number.isFinite(v)))
  );
  if (uids.length === 0) return [];

  const users: any[] = [];
  for (const ids of chunkArray(uids, POSTGREST_IN_CHUNK_SIZE)) {
    const res = await supabase
      .from("users")
      .select("uid,username,display_name,is_admin")
      .in("uid", ids);
    if (res.error) throw new Error(`读取工单参与者失败：${res.error.message}`);
    users.push(...(res.data ?? []));
  }

  const byUid = new Map<number, TicketParticipantUser>();
  for (const u of users) {
    const uid = Number((u as any).uid);
    if (!Number.isFinite(uid)) continue;
    byUid.set(uid, {
      uid,
      username: String((u as any).username ?? ""),
      display_name: (u as any).display_name ?? null,
      is_admin: Boolean((u as any).is_admin),
    });
  }

  // Preserve insertion order by ticket_participants.created_at.
  const ordered: TicketParticipantUser[] = [];
  for (const row of rows ?? []) {
    const uid = Number((row as any).uid);
    const u = byUid.get(uid);
    if (u) ordered.push(u);
  }
  return ordered;
}
