import { getSupabaseAdminDb, getSupabaseAdminDbOptional } from "../supabase.server";
import type { TicketStatus } from "../../shared/tickets";

export const SMART_SORT_RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;
export const SMART_SORT_NUDGE_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SMART_SORT_POSTGREST_IN_CHUNK_SIZE = 80;
export const SMART_SORT_UPSERT_CHUNK_SIZE = 200;

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

let recomputeInFlight: Promise<SmartSortRecomputeResult> | null = null;

export type SmartSortRecomputeResult = {
  computedAt: string;
  openTickets: number;
  upsertedRows: number;
};

export type TicketSmartScoreRow = {
  ticket_id: string;
  urgency_score: number;
  time_score: number;
  computed_at: string;
};

export async function getTicketSmartScores(
  ticketIds: string[]
): Promise<Map<string, TicketSmartScoreRow>> {
  const supabase = getSupabaseAdminDb();
  const ids = Array.from(new Set(ticketIds.filter(Boolean)));
  const map = new Map<string, TicketSmartScoreRow>();
  if (ids.length === 0) return map;

  for (const chunk of chunkArray(ids, SMART_SORT_POSTGREST_IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("ticket_smart_scores")
      .select("ticket_id,urgency_score,time_score,computed_at")
      .in("ticket_id", chunk);
    if (error) throw new Error(`读取智能排序分数失败：${error.message}`);
    for (const row of data ?? []) {
      const ticketId = String((row as any).ticket_id ?? "");
      if (!ticketId) continue;
      map.set(ticketId, row as any);
    }
  }

  return map;
}

export async function recomputeTicketSmartScores(): Promise<SmartSortRecomputeResult> {
  if (recomputeInFlight) return recomputeInFlight;
  recomputeInFlight = (async () => {
    const supabase = getSupabaseAdminDb();
    const computedAt = new Date().toISOString();

    const { data: tickets, error: tErr } = await supabase
      .from("tickets")
      .select("id,creator_uid,status,created_at,updated_at")
      .in("status", OPEN_TICKET_STATUSES);

    if (tErr) throw new Error(`读取工单失败：${tErr.message}`);
    const openTickets = (tickets ?? []) as any[];
    if (openTickets.length === 0) {
      return { computedAt, openTickets: 0, upsertedRows: 0 };
    }

    const ticketIds = openTickets.map((t) => String(t.id)).filter(Boolean);

    const openCountByCreator = new Map<number, number>();
    for (const t of openTickets) {
      const uid = Number(t.creator_uid);
      if (!Number.isFinite(uid)) continue;
      openCountByCreator.set(uid, (openCountByCreator.get(uid) ?? 0) + 1);
    }

    const nudgeCountByTicket = new Map<string, number>();
    const lastNudgeAtMsByTicket = new Map<string, number>();

    for (const ids of chunkArray(ticketIds, SMART_SORT_POSTGREST_IN_CHUNK_SIZE)) {
      const { data: nudges, error: nErr } = await supabase
        .from("ticket_nudges")
        .select("ticket_id,created_at")
        .in("ticket_id", ids);
      if (nErr) throw new Error(`读取催单记录失败：${nErr.message}`);
      for (const row of nudges ?? []) {
        const ticketId = String((row as any).ticket_id ?? "");
        const createdAt = String((row as any).created_at ?? "");
        if (!ticketId || !createdAt) continue;
        nudgeCountByTicket.set(ticketId, (nudgeCountByTicket.get(ticketId) ?? 0) + 1);
        const ts = new Date(createdAt).getTime();
        if (!Number.isFinite(ts)) continue;
        const prev = lastNudgeAtMsByTicket.get(ticketId);
        if (!prev || ts > prev) lastNudgeAtMsByTicket.set(ticketId, ts);
      }
    }

    const customerMessageCountByTicket = new Map<string, number>();
    const hasStaffReplyByTicket = new Map<string, boolean>();

    for (const ids of chunkArray(ticketIds, SMART_SORT_POSTGREST_IN_CHUNK_SIZE)) {
      const { data: msgs, error: mErr } = await supabase
        .from("ticket_messages")
        .select("ticket_id,actor")
        .in("ticket_id", ids)
        .in("actor", ["customer", "staff", "anonymous"]);
      if (mErr) throw new Error(`读取消息统计失败：${mErr.message}`);

      for (const row of msgs ?? []) {
        const ticketId = String((row as any).ticket_id ?? "");
        const actor = String((row as any).actor ?? "");
        if (!ticketId || !actor) continue;
        if (actor === "customer") {
          customerMessageCountByTicket.set(
            ticketId,
            (customerMessageCountByTicket.get(ticketId) ?? 0) + 1
          );
          continue;
        }
        if (actor === "staff" || actor === "anonymous") {
          hasStaffReplyByTicket.set(ticketId, true);
        }
      }
    }

    const nowMs = Date.now();

    const scoreRows = openTickets.map((t) => {
      const ticketId = String(t.id);
      const creatorUid = Number(t.creator_uid);

      const customerMsgCount = customerMessageCountByTicket.get(ticketId) ?? 0;
      const userReplyCount = Math.max(0, customerMsgCount - 1);
      const neverHandled = hasStaffReplyByTicket.get(ticketId) ? 0 : 1;

      const totalNudges = nudgeCountByTicket.get(ticketId) ?? 0;
      const everNudged = totalNudges > 0 ? 1 : 0;
      const lastNudgeAtMs = lastNudgeAtMsByTicket.get(ticketId) ?? null;
      const nudgeFreshness = lastNudgeAtMs
        ? Math.max(
            0,
            1 - (nowMs - lastNudgeAtMs) / SMART_SORT_NUDGE_FRESHNESS_WINDOW_MS
          )
        : 0;

      const rawUrgencyScore =
        1 * Math.log(1 + userReplyCount) +
        3 * neverHandled +
        2 * everNudged +
        4 * nudgeFreshness +
        1.5 * Math.log(1 + totalNudges);

      const openCount = Math.max(1, openCountByCreator.get(creatorUid) ?? 1);
      const userPenaltyFactor = 1 / (1 + 0.6 * (openCount - 1));
      const urgencyScore = rawUrgencyScore * userPenaltyFactor;

      const updatedMs = new Date(String(t.updated_at)).getTime();
      const createdMs = new Date(String(t.created_at)).getTime();
      const timeScore =
        (Number.isFinite(updatedMs) ? updatedMs : 0) * 0.7 +
        (Number.isFinite(createdMs) ? createdMs : 0) * 0.3;

      return {
        ticket_id: ticketId,
        urgency_score: urgencyScore,
        time_score: timeScore,
        computed_at: computedAt,
      };
    });

    let upsertedRows = 0;
    for (const rows of chunkArray(scoreRows, SMART_SORT_UPSERT_CHUNK_SIZE)) {
      const { error: upErr } = await supabase
        .from("ticket_smart_scores")
        .upsert(rows, { onConflict: "ticket_id" });
      if (upErr) throw new Error(`写入智能排序分数失败：${upErr.message}`);
      upsertedRows += rows.length;
    }

    return {
      computedAt,
      openTickets: openTickets.length,
      upsertedRows,
    };
  })();

  try {
    return await recomputeInFlight;
  } finally {
    recomputeInFlight = null;
  }
}

export function ensureSmartSortCronStarted() {
  const supabase = getSupabaseAdminDbOptional();
  if (!supabase) return;

  const g = globalThis as any;
  if (g.__privnodeSmartSortCronStarted) return;
  g.__privnodeSmartSortCronStarted = true;

  if (process.env.SMART_SORT_CRON_ENABLED === "false") return;

  const tick = async () => {
    try {
      await recomputeTicketSmartScores();
    } catch (e) {
      console.error(e);
    }
  };

  // Fire once after boot, then every 5 minutes.
  void tick();
  setInterval(tick, SMART_SORT_RECOMPUTE_INTERVAL_MS);
}
