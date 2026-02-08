import { getSupabaseAdminDb } from "../supabase.server";
import type { TicketStatus } from "../../shared/tickets";
import { ensureSmartSortCronStarted, getTicketSmartScores } from "./smart-sort.server";

function chunkArray<T>(list: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

const POSTGREST_IN_CHUNK_SIZE = 80;

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
  is_global: boolean;
  merged_into_ticket_id: string | null;
  category_id: string;
  assigned_to_uid: number | null;
  deleted_at: string | null;
  deleted_by_uid: number | null;
  nudge_last_at: string | null;
  nudge_pending: boolean;
  smart_urgency_score: number | null;
  smart_time_score: number | null;
  smart_computed_at: string | null;
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
  ensureSmartSortCronStarted();
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
      "id,short_id,subject,status,creator_uid,is_global,merged_into_ticket_id,category_id,assigned_to_uid,deleted_at,deleted_by_uid,updated_at,created_at"
    )
    .is("purged_at", null);

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

  const list = (data ?? []) as Omit<
    AdminTicketListItem,
    "nudge_last_at" | "nudge_pending"
  >[];
  if (list.length === 0) return [];

  const ticketIds = list.map((t) => t.id);

  const nudgeRows: any[] = [];
  for (const ids of chunkArray(ticketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const res = await supabase
      .from("ticket_nudges")
      .select("ticket_id,created_at")
      .in("ticket_id", ids);
    if (res.error) {
      throw new Error(`读取催单记录失败：${res.error.message}`);
    }
    nudgeRows.push(...(res.data ?? []));
  }

  const lastNudgeAtMsByTicket = new Map<string, number>();
  const nudgeCountByTicket = new Map<string, number>();
  const lastNudgeAtRawByTicket = new Map<string, string>();
  for (const row of nudgeRows) {
    const ticketId = (row as any).ticket_id as string;
    const createdAt = (row as any).created_at as string;
    if (!ticketId || !createdAt) continue;

    nudgeCountByTicket.set(ticketId, (nudgeCountByTicket.get(ticketId) ?? 0) + 1);

    const ts = new Date(createdAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const prev = lastNudgeAtMsByTicket.get(ticketId);
    if (!prev || ts > prev) {
      lastNudgeAtMsByTicket.set(ticketId, ts);
      lastNudgeAtRawByTicket.set(ticketId, createdAt);
    }
  }

  const messageTicketIds = Array.from(
    new Set(nudgeRows.map((r) => (r as any).ticket_id).filter(Boolean))
  );
  const messageRows: any[] = [];
  for (const ids of chunkArray(messageTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const res = await supabase
      .from("ticket_messages")
      .select("ticket_id,actor,created_at")
      .in("ticket_id", ids)
      .in("actor", ["staff", "anonymous"])
      .is("deleted_at", null)
      .is("purged_at", null);
    if (res.error) {
      throw new Error(`读取消息统计失败：${res.error.message}`);
    }
    messageRows.push(...(res.data ?? []));
  }

  const lastStaffReplyAtMsByTicket = new Map<string, number>();
  for (const row of messageRows) {
    const ticketId = (row as any).ticket_id as string;
    const createdAt = (row as any).created_at as string;
    if (!ticketId || !createdAt) continue;

    const ts = new Date(createdAt).getTime();
    if (!Number.isFinite(ts)) continue;
    const prev = lastStaffReplyAtMsByTicket.get(ticketId);
    if (!prev || ts > prev) lastStaffReplyAtMsByTicket.set(ticketId, ts);
  }

  const scoreMap = await getTicketSmartScores(ticketIds);

  const withNudgeInfo = list.map((t) => {
    const lastNudgeAtMs = lastNudgeAtMsByTicket.get(t.id) ?? null;
    const lastStaffReplyAtMs = lastStaffReplyAtMsByTicket.get(t.id) ?? null;
    const nudgePending =
      t.status !== "closed" &&
      !!lastNudgeAtMs &&
      (!lastStaffReplyAtMs || lastNudgeAtMs > lastStaffReplyAtMs);

    const score = scoreMap.get(t.id);

    const smartUrgencyScore =
      t.status === "closed" ? null : score?.urgency_score ?? null;
    const smartTimeScore = t.status === "closed" ? null : score?.time_score ?? null;
    const smartComputedAt =
      t.status === "closed" ? null : score?.computed_at ?? null;

    return {
      ...(t as any),
      nudge_last_at: lastNudgeAtRawByTicket.get(t.id) ?? null,
      nudge_pending: nudgePending,
      smart_urgency_score: smartUrgencyScore,
      smart_time_score: smartTimeScore,
      smart_computed_at: smartComputedAt,
    } as AdminTicketListItem;
  });

  if (sort !== "smart") return withNudgeInfo;

  const scored = withNudgeInfo.map((t) => {
    const urgencyScore = t.smart_urgency_score ?? 0;
    const updatedMs = new Date(t.updated_at).getTime();
    const createdMs = new Date(t.created_at).getTime();
    const fallbackTimeScore =
      (Number.isFinite(updatedMs) ? updatedMs : 0) * 0.7 +
      (Number.isFinite(createdMs) ? createdMs : 0) * 0.3;
    const timeScore = t.smart_time_score ?? fallbackTimeScore;
    return { t, urgencyScore, timeScore };
  });

  scored.sort((a, b) => {
    if (a.urgencyScore !== b.urgencyScore) {
      return ascending
        ? a.urgencyScore - b.urgencyScore
        : b.urgencyScore - a.urgencyScore;
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
      "id,short_id,subject,status,creator_uid,is_global,merged_into_ticket_id,merged_at,merged_by_uid,merged_reason,category_id,form_data,assigned_to_uid,closed_reason,deleted_at,deleted_by_uid,deleted_reason,purged_at,purged_by_uid,purged_reason,created_at,updated_at,closed_at"
    )
    .eq("id", ticketId)
    .is("purged_at", null)
    .maybeSingle();
  if (error) throw new Error(`读取工单失败：${error.message}`);
  return data as any;
}

export async function createTicketAsAdmin(params: {
  creatorUid: number;
  creatorDisplayName: string;
  categoryId: string;
  subject: string;
  formData: any;
  bodyMarkdown: string;
  participantUids: number[];
  isGlobal: boolean;
}): Promise<{ id: string; messageId: string }> {
  const supabase = getSupabaseAdminDb();

  const participantUids = Array.from(
    new Set(
      (params.participantUids ?? [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v)),
    ),
  );

  if (!params.isGlobal && participantUids.length === 0) {
    throw new Error("请选择至少一个用户，或勾选“所有用户”。");
  }

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      creator_uid: params.creatorUid,
      category_id: params.categoryId,
      subject: params.subject,
      form_data: params.formData ?? {},
      status: "replied_by_staff",
      is_global: Boolean(params.isGlobal),
    })
    .select("id")
    .single();

  if (error) throw new Error(`创建工单失败：${error.message}`);
  const ticketId = (ticket as any).id as string;

  if (!params.isGlobal) {
    for (const uids of chunkArray(participantUids, POSTGREST_IN_CHUNK_SIZE)) {
      const { error: pErr } = await supabase
        .from("ticket_participants")
        .upsert(
          uids.map((uid) => ({ ticket_id: ticketId, uid })),
          { onConflict: "ticket_id,uid", ignoreDuplicates: true },
        );
      if (pErr) throw new Error(`写入参与用户失败：${pErr.message}`);
    }
  }

  const { data: msg, error: msgErr } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticketId,
      actor: "staff",
      author_uid: params.creatorUid,
      author_display_name: params.creatorDisplayName,
      body_markdown: params.bodyMarkdown,
    })
    .select("id")
    .single();
  if (msgErr) throw new Error(`创建工单首条消息失败：${msgErr.message}`);

  return { id: ticketId, messageId: (msg as any).id as string };
}

export async function mergeTicketsAsAdmin(params: {
  targetTicketId: string;
  sourceTicketIds: string[];
  mergedByUid: number;
  mergedReason: string;
  mergeMessages?: boolean;
}): Promise<{
  merged_source_ticket_ids: string[];
  skipped_missing_ticket_ids: string[];
  skipped_deleted_ticket_ids: string[];
  skipped_already_merged_ticket_ids: string[];
}> {
  const supabase = getSupabaseAdminDb();

  const mergeMessages = params.mergeMessages !== false;

  const targetTicketId = String(params.targetTicketId ?? "").trim();
  const sourceTicketIds = Array.from(
    new Set(
      (params.sourceTicketIds ?? [])
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .filter((id) => id !== targetTicketId),
    ),
  );

  if (!targetTicketId) throw new Error("缺少目标工单。");
  if (sourceTicketIds.length === 0) {
    return {
      merged_source_ticket_ids: [],
      skipped_missing_ticket_ids: [],
      skipped_deleted_ticket_ids: [],
      skipped_already_merged_ticket_ids: [],
    };
  }

  const { data: target, error: tErr } = await supabase
    .from("tickets")
    .select(
      "id,short_id,status,is_global,merged_into_ticket_id,deleted_at,purged_at"
    )
    .eq("id", targetTicketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取目标工单失败：${tErr.message}`);
  if (!target) throw new Error("目标工单不存在。");
  if ((target as any).deleted_at) {
    throw new Error("目标工单已删除，无法作为主工单。");
  }
  if ((target as any).purged_at) {
    throw new Error("目标工单已彻底删除，无法作为主工单。");
  }
  if ((target as any).status === "closed") {
    throw new Error("目标工单已关闭，无法作为主工单。");
  }
  if ((target as any).merged_into_ticket_id) {
    throw new Error("目标工单已被合并到其它工单，无法作为主工单。");
  }

  const sources: any[] = [];
  for (const ids of chunkArray(sourceTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .select(
        "id,short_id,status,creator_uid,is_global,merged_into_ticket_id,deleted_at,purged_at"
      )
      .in("id", ids);
    if (error) throw new Error(`读取待合并工单失败：${error.message}`);
    sources.push(...(data ?? []));
  }

  const sourceById = new Map<string, any>();
  for (const s of sources) {
    const id = String((s as any).id ?? "");
    if (!id) continue;
    sourceById.set(id, s);
  }

  const skippedMissing = sourceTicketIds.filter((id) => !sourceById.has(id));
  const skippedDeleted = sourceTicketIds.filter((id) => {
    const row = sourceById.get(id);
    return row && (Boolean((row as any).deleted_at) || Boolean((row as any).purged_at));
  });
  const skippedAlreadyMerged = sourceTicketIds.filter((id) => {
    const row = sourceById.get(id);
    return row && (row as any).merged_into_ticket_id;
  });

  const mergeableSourceIds = sourceTicketIds.filter((id) => {
    const row = sourceById.get(id);
    return (
      row &&
      !(row as any).deleted_at &&
      !(row as any).purged_at &&
      !(row as any).merged_into_ticket_id
    );
  });

  if (mergeableSourceIds.length === 0) {
    return {
      merged_source_ticket_ids: [],
      skipped_missing_ticket_ids: skippedMissing,
      skipped_deleted_ticket_ids: skippedDeleted,
      skipped_already_merged_ticket_ids: skippedAlreadyMerged,
    };
  }

  // Collect participant uids from sources: creator_uid + ticket_participants.
  const participantUidSet = new Set<number>();
  for (const id of mergeableSourceIds) {
    const s = sourceById.get(id);
    const creatorUid = Number((s as any)?.creator_uid);
    if (Number.isFinite(creatorUid)) participantUidSet.add(creatorUid);
  }

  for (const ids of chunkArray(mergeableSourceIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("ticket_participants")
      .select("uid")
      .in("ticket_id", ids);
    if (error) throw new Error(`读取参与用户失败：${error.message}`);
    for (const row of data ?? []) {
      const uid = Number((row as any).uid);
      if (Number.isFinite(uid)) participantUidSet.add(uid);
    }
  }

  const participantUids = Array.from(participantUidSet);
  if (participantUids.length > 0) {
    for (const uids of chunkArray(participantUids, POSTGREST_IN_CHUNK_SIZE)) {
      const { error } = await supabase
        .from("ticket_participants")
        .upsert(
          uids.map((uid) => ({ ticket_id: targetTicketId, uid })),
          { onConflict: "ticket_id,uid", ignoreDuplicates: true },
        );
      if (error) throw new Error(`写入参与用户失败：${error.message}`);
    }
  }

  if (mergeMessages) {
    // Move messages + attachments to target.
    for (const ids of chunkArray(mergeableSourceIds, POSTGREST_IN_CHUNK_SIZE)) {
      const { error } = await supabase
        .from("ticket_messages")
        .update({ ticket_id: targetTicketId })
        .in("ticket_id", ids);
      if (error) throw new Error(`合并消息失败：${error.message}`);
    }
    for (const ids of chunkArray(mergeableSourceIds, POSTGREST_IN_CHUNK_SIZE)) {
      const { error } = await supabase
        .from("ticket_attachments")
        .update({ ticket_id: targetTicketId })
        .in("ticket_id", ids);
      if (error) throw new Error(`合并附件失败：${error.message}`);
    }
  }

  const shouldBeGlobal =
    Boolean((target as any).is_global) ||
    mergeableSourceIds.some((id) => Boolean((sourceById.get(id) as any)?.is_global));

  // Bump target updated_at (+ optionally global flag).
  {
    const { error } = await supabase
      .from("tickets")
      .update({
        is_global: shouldBeGlobal,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetTicketId);
    if (error) throw new Error(`更新目标工单失败：${error.message}`);
  }

  const nowIso = new Date().toISOString();
  const targetShortId = String((target as any).short_id ?? "").trim();
  const reason = params.mergedReason.trim();
  const closeReason =
    reason || (targetShortId ? `已合并到 #${targetShortId}` : "已合并到其它工单");

  // Close and mark merged for sources.
  for (const ids of chunkArray(mergeableSourceIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("tickets")
      .update({
        status: "closed",
        closed_reason: closeReason,
        closed_at: nowIso,
        merged_into_ticket_id: targetTicketId,
        merged_at: nowIso,
        merged_by_uid: params.mergedByUid,
        merged_reason: reason || null,
      })
      .in("id", ids);
    if (error) throw new Error(`更新被合并工单失败：${error.message}`);
  }

  // System messages: keep sources with a redirect note; add a summary to target.
  const mergedShortIds = mergeableSourceIds
    .map((id) => String((sourceById.get(id) as any)?.short_id ?? "").trim())
    .filter(Boolean);

  const messageHintForTarget = mergeMessages
    ? "消息与附件已迁移到本工单。"
    : "消息与附件保留在原工单，未迁移。";
  const targetMsg =
    `已合并 ${mergeableSourceIds.length} 个工单` +
    (mergedShortIds.length > 0 ? `：${mergedShortIds.map((v) => `#${v}`).join("、")}` : "。") +
    (reason ? `\n\n合并原因：${reason}` : "") +
    `\n\n${messageHintForTarget}`;

  const { error: targetMsgErr } = await supabase.from("ticket_messages").insert({
    ticket_id: targetTicketId,
    actor: "system",
    body_markdown: targetMsg,
  });
  if (targetMsgErr) throw new Error(`创建系统消息失败：${targetMsgErr.message}`);

  const sourceMsg =
    (targetShortId ? `该工单已合并到 #${targetShortId}。` : "该工单已合并到其它工单。") +
    (reason ? `\n\n合并原因：${reason}` : "") +
    (mergeMessages
      ? "\n\n历史消息与附件已迁移到主工单。"
      : "\n\n历史消息与附件保留在本工单，未迁移。");

  for (const ids of chunkArray(mergeableSourceIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { error } = await supabase.from("ticket_messages").insert(
      ids.map((ticketId) => ({
        ticket_id: ticketId,
        actor: "system",
        body_markdown: sourceMsg,
      })),
    );
    if (error) throw new Error(`创建系统消息失败：${error.message}`);
  }

  return {
    merged_source_ticket_ids: mergeableSourceIds,
    skipped_missing_ticket_ids: skippedMissing,
    skipped_deleted_ticket_ids: skippedDeleted,
    skipped_already_merged_ticket_ids: skippedAlreadyMerged,
  };
}

export async function assignTicket(params: { ticketId: string; uid: number }) {
  const supabase = getSupabaseAdminDb();
  const { data: updated, error } = await supabase
    .from("tickets")
    .update({ assigned_to_uid: params.uid, status: "assigned" })
    .eq("id", params.ticketId)
    .is("deleted_at", null)
    .is("purged_at", null)
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
    .select("status,deleted_at,purged_at")
    .eq("id", params.ticketId)
    .maybeSingle();
  if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
  if (!t) throw new Error("工单不存在。");
  if ((t as any).deleted_at) throw new Error("工单已删除，无法回复。");
  if ((t as any).purged_at) throw new Error("工单已彻底删除，无法回复。");
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
    .eq("id", params.ticketId)
    .is("deleted_at", null)
    .is("purged_at", null);
  if (upErr) throw new Error(`更新工单状态失败：${upErr.message}`);

  return { messageId: (msg as any).id };
}

export async function addAdminReplyBatch(params: {
  ticketIds: string[];
  actor: "staff" | "anonymous" | "system";
  authorUid: number;
  authorDisplayName: string;
  bodyMarkdown: string;
}): Promise<{
  replied_ticket_ids: string[];
  skipped_closed_ticket_ids: string[];
  skipped_deleted_ticket_ids: string[];
  skipped_missing_ticket_ids: string[];
}> {
  const supabase = getSupabaseAdminDb();

  const ticketIds = Array.from(
    new Set(params.ticketIds.map((v) => String(v ?? "").trim()).filter(Boolean)),
  );
  if (ticketIds.length === 0) {
    return {
      replied_ticket_ids: [],
      skipped_closed_ticket_ids: [],
      skipped_deleted_ticket_ids: [],
      skipped_missing_ticket_ids: [],
    };
  }

  const statusById = new Map<string, TicketStatus>();
  const deletedAtById = new Map<string, string | null>();
  const purgedAtById = new Map<string, string | null>();
  for (const ids of chunkArray(ticketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id,status,deleted_at,purged_at")
      .in("id", ids);
    if (error) throw new Error(`读取工单失败：${error.message}`);
    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      const status = (row as any).status as TicketStatus | undefined;
      if (id && status) statusById.set(id, status);
      if (id) deletedAtById.set(id, (row as any).deleted_at ?? null);
      if (id) purgedAtById.set(id, (row as any).purged_at ?? null);
    }
  }

  const skippedMissing = ticketIds.filter((id) => !statusById.has(id));
  const skippedClosed = ticketIds.filter((id) => statusById.get(id) === "closed");
  const skippedDeleted = ticketIds.filter(
    (id) => Boolean(deletedAtById.get(id)) || Boolean(purgedAtById.get(id)),
  );
  const openTicketIds = ticketIds.filter((id) => {
    const status = statusById.get(id);
    return status && status !== "closed" && !deletedAtById.get(id) && !purgedAtById.get(id);
  });

  if (openTicketIds.length === 0) {
    return {
      replied_ticket_ids: [],
      skipped_closed_ticket_ids: skippedClosed,
      skipped_deleted_ticket_ids: skippedDeleted,
      skipped_missing_ticket_ids: skippedMissing,
    };
  }

  const authorDisplayName =
    params.actor === "anonymous" ? null : params.authorDisplayName;
  const authorUid = params.actor === "system" ? null : params.authorUid;

  for (const ids of chunkArray(openTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { error } = await supabase.from("ticket_messages").insert(
      ids.map((ticketId) => ({
        ticket_id: ticketId,
        actor: params.actor,
        author_uid: authorUid,
        author_display_name: authorDisplayName,
        body_markdown: params.bodyMarkdown,
      })),
    );
    if (error) throw new Error(`发送回复失败：${error.message}`);
  }

  for (const ids of chunkArray(openTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("tickets")
      .update({ status: "replied_by_staff" })
      .in("id", ids)
      .is("deleted_at", null)
      .is("purged_at", null)
      .neq("status", "closed");
    if (error) throw new Error(`更新工单状态失败：${error.message}`);
  }

  return {
    replied_ticket_ids: openTicketIds,
    skipped_closed_ticket_ids: skippedClosed,
    skipped_deleted_ticket_ids: skippedDeleted,
    skipped_missing_ticket_ids: skippedMissing,
  };
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
    .is("deleted_at", null)
    .is("purged_at", null)
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

export async function closeTicketsAsAdminBatch(params: {
  ticketIds: string[];
  reason: string;
}): Promise<{
  closed_ticket_ids: string[];
  skipped_closed_ticket_ids: string[];
  skipped_deleted_ticket_ids: string[];
  skipped_missing_ticket_ids: string[];
}> {
  const supabase = getSupabaseAdminDb();

  const ticketIds = Array.from(
    new Set(params.ticketIds.map((v) => String(v ?? "").trim()).filter(Boolean)),
  );
  if (ticketIds.length === 0) {
    return {
      closed_ticket_ids: [],
      skipped_closed_ticket_ids: [],
      skipped_deleted_ticket_ids: [],
      skipped_missing_ticket_ids: [],
    };
  }

  const statusById = new Map<string, TicketStatus>();
  const deletedAtById = new Map<string, string | null>();
  const purgedAtById = new Map<string, string | null>();
  for (const ids of chunkArray(ticketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id,status,deleted_at,purged_at")
      .in("id", ids);
    if (error) throw new Error(`读取工单失败：${error.message}`);
    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      const status = (row as any).status as TicketStatus | undefined;
      if (id && status) statusById.set(id, status);
      if (id) deletedAtById.set(id, (row as any).deleted_at ?? null);
      if (id) purgedAtById.set(id, (row as any).purged_at ?? null);
    }
  }

  const skippedMissing = ticketIds.filter((id) => !statusById.has(id));
  const skippedClosed = ticketIds.filter((id) => statusById.get(id) === "closed");
  const skippedDeleted = ticketIds.filter(
    (id) => Boolean(deletedAtById.get(id)) || Boolean(purgedAtById.get(id)),
  );
  const openTicketIds = ticketIds.filter((id) => {
    const status = statusById.get(id);
    return status && status !== "closed" && !deletedAtById.get(id) && !purgedAtById.get(id);
  });

  if (openTicketIds.length === 0) {
    return {
      closed_ticket_ids: [],
      skipped_closed_ticket_ids: skippedClosed,
      skipped_deleted_ticket_ids: skippedDeleted,
      skipped_missing_ticket_ids: skippedMissing,
    };
  }

  const reason = params.reason.trim() || "已完成";
  const nowIso = new Date().toISOString();

  const closedTicketIds: string[] = [];
  for (const ids of chunkArray(openTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .update({
        status: "closed",
        closed_reason: reason,
        closed_at: nowIso,
      })
      .in("id", ids)
      .is("deleted_at", null)
      .is("purged_at", null)
      .neq("status", "closed")
      .select("id");
    if (error) throw new Error(`关闭工单失败：${error.message}`);

    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      if (id) closedTicketIds.push(id);
    }
  }

  if (closedTicketIds.length > 0) {
    for (const ids of chunkArray(closedTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
      const { error } = await supabase.from("ticket_messages").insert(
        ids.map((ticketId) => ({
          ticket_id: ticketId,
          actor: "system",
          body_markdown: `工作人员关闭了工单（原因：${reason}）。`,
        })),
      );
      if (error) throw new Error(`创建系统消息失败：${error.message}`);
    }
  }

  return {
    closed_ticket_ids: closedTicketIds,
    skipped_closed_ticket_ids: skippedClosed,
    skipped_deleted_ticket_ids: skippedDeleted,
    skipped_missing_ticket_ids: skippedMissing,
  };
}

export async function softDeleteTicketsAsAdminBatch(params: {
  ticketIds: string[];
  deletedByUid: number;
  reason?: string;
}): Promise<{
  deleted_ticket_ids: string[];
  skipped_already_deleted_ticket_ids: string[];
  skipped_missing_ticket_ids: string[];
}> {
  const supabase = getSupabaseAdminDb();

  const ticketIds = Array.from(
    new Set(params.ticketIds.map((v) => String(v ?? "").trim()).filter(Boolean)),
  );
  if (ticketIds.length === 0) {
    return {
      deleted_ticket_ids: [],
      skipped_already_deleted_ticket_ids: [],
      skipped_missing_ticket_ids: [],
    };
  }

  const deletedAtById = new Map<string, string | null>();
  for (const ids of chunkArray(ticketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .select("id,deleted_at")
      .in("id", ids);
    if (error) throw new Error(`读取工单失败：${error.message}`);
    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      if (!id) continue;
      deletedAtById.set(id, (row as any).deleted_at ?? null);
    }
  }

  const skippedMissing = ticketIds.filter((id) => !deletedAtById.has(id));
  const skippedAlreadyDeleted = ticketIds.filter((id) =>
    Boolean(deletedAtById.get(id)),
  );
  const deletableTicketIds = ticketIds.filter((id) => {
    const deletedAt = deletedAtById.get(id);
    return deletedAtById.has(id) && !deletedAt;
  });

  if (deletableTicketIds.length === 0) {
    return {
      deleted_ticket_ids: [],
      skipped_already_deleted_ticket_ids: skippedAlreadyDeleted,
      skipped_missing_ticket_ids: skippedMissing,
    };
  }

  const nowIso = new Date().toISOString();
  const deletedTicketIds: string[] = [];
  for (const ids of chunkArray(deletableTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("tickets")
      .update({
        deleted_at: nowIso,
        deleted_by_uid: params.deletedByUid,
        deleted_reason: params.reason?.trim() || null,
      })
      .in("id", ids)
      .is("deleted_at", null)
      .is("purged_at", null)
      .select("id");
    if (error) throw new Error(`删除工单失败：${error.message}`);
    for (const row of data ?? []) {
      const id = String((row as any).id ?? "");
      if (id) deletedTicketIds.push(id);
    }
  }

  return {
    deleted_ticket_ids: deletedTicketIds,
    skipped_already_deleted_ticket_ids: skippedAlreadyDeleted,
    skipped_missing_ticket_ids: skippedMissing,
  };
}

export async function softDeleteTicketAsAdmin(params: {
  ticketId: string;
  deletedByUid: number;
  reason?: string;
}): Promise<{ deleted: boolean }> {
  const ticketId = String(params.ticketId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");

  const res = await softDeleteTicketsAsAdminBatch({
    ticketIds: [ticketId],
    deletedByUid: params.deletedByUid,
    reason: params.reason,
  });

  return { deleted: res.deleted_ticket_ids.includes(ticketId) };
}

export async function restoreTicketAsAdmin(params: {
  ticketId: string;
}): Promise<{ restored: boolean }> {
  const supabase = getSupabaseAdminDb();
  const ticketId = String(params.ticketId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");

  const { data, error } = await supabase
    .from("tickets")
    .update({
      deleted_at: null,
      deleted_by_uid: null,
      deleted_reason: null,
    })
    .eq("id", ticketId)
    .is("purged_at", null)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`恢复工单失败：${error.message}`);

  return { restored: Boolean(data) };
}

export async function purgeTicketAsAdmin(params: {
  ticketId: string;
  purgedByUid: number;
  reason?: string;
}): Promise<{ purged: boolean }> {
  const supabase = getSupabaseAdminDb();
  const ticketId = String(params.ticketId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("tickets")
    .update({
      purged_at: nowIso,
      purged_by_uid: params.purgedByUid,
      purged_reason: params.reason?.trim() || null,
    })
    .eq("id", ticketId)
    .is("purged_at", null)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`彻底删除工单失败：${error.message}`);

  return { purged: Boolean(data) };
}

export async function softDeleteTicketMessageAsAdmin(params: {
  ticketId: string;
  messageId: string;
  deletedByUid: number;
  reason?: string;
}): Promise<{ deleted: boolean }> {
  const supabase = getSupabaseAdminDb();
  const ticketId = String(params.ticketId ?? "").trim();
  const messageId = String(params.messageId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");
  if (!messageId) throw new Error("缺少消息 ID。");

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("ticket_messages")
    .update({
      deleted_at: nowIso,
      deleted_by_uid: params.deletedByUid,
      deleted_reason: params.reason?.trim() || null,
    })
    .eq("id", messageId)
    .eq("ticket_id", ticketId)
    .is("purged_at", null)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`删除消息失败：${error.message}`);

  return { deleted: Boolean(data) };
}

export async function restoreTicketMessageAsAdmin(params: {
  ticketId: string;
  messageId: string;
}): Promise<{ restored: boolean }> {
  const supabase = getSupabaseAdminDb();
  const ticketId = String(params.ticketId ?? "").trim();
  const messageId = String(params.messageId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");
  if (!messageId) throw new Error("缺少消息 ID。");

  const { data, error } = await supabase
    .from("ticket_messages")
    .update({
      deleted_at: null,
      deleted_by_uid: null,
      deleted_reason: null,
    })
    .eq("id", messageId)
    .eq("ticket_id", ticketId)
    .is("purged_at", null)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`恢复消息失败：${error.message}`);

  return { restored: Boolean(data) };
}

export async function purgeTicketMessageAsAdmin(params: {
  ticketId: string;
  messageId: string;
  purgedByUid: number;
  reason?: string;
}): Promise<{ purged: boolean }> {
  const supabase = getSupabaseAdminDb();
  const ticketId = String(params.ticketId ?? "").trim();
  const messageId = String(params.messageId ?? "").trim();
  if (!ticketId) throw new Error("缺少工单 ID。");
  if (!messageId) throw new Error("缺少消息 ID。");

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("ticket_messages")
    .update({
      purged_at: nowIso,
      purged_by_uid: params.purgedByUid,
      purged_reason: params.reason?.trim() || null,
    })
    .eq("id", messageId)
    .eq("ticket_id", ticketId)
    .is("purged_at", null)
    .not("deleted_at", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`彻底删除消息失败：${error.message}`);

  return { purged: Boolean(data) };
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
