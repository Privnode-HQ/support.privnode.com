import { getSupabaseAdminDb } from "./supabase.server";

const SHORT_ID_PATTERN = /#([a-f0-9]{8})\b/gi;
const POSTGREST_IN_CHUNK_SIZE = 80;

function chunkArray<T>(list: T[], chunkSize: number): T[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

function replaceShortIdsWithLinks(
  markdown: string,
  basePath: string,
  shortIdToTicketId: Map<string, string>,
): string {
  if (shortIdToTicketId.size === 0) return markdown;
  return markdown.replace(SHORT_ID_PATTERN, (full, rawShortId) => {
    const shortId = String(rawShortId ?? "").toLowerCase();
    const ticketId = shortIdToTicketId.get(shortId);
    if (!ticketId) return full;
    return `[#${rawShortId}](${basePath}/${ticketId})`;
  });
}

async function resolveAccessibleTicketIdsByShortId(params: {
  shortIds: string[];
  viewerUid: number | null;
  isAdmin: boolean;
}): Promise<Map<string, string>> {
  const supabase = getSupabaseAdminDb();

  const uniqueShortIds = Array.from(
    new Set((params.shortIds ?? []).map((s) => String(s ?? "").toLowerCase()).filter(Boolean)),
  );
  const map = new Map<string, string>();
  if (uniqueShortIds.length === 0) return map;

  const ticketRows: any[] = [];
  for (const shortIdChunk of chunkArray(uniqueShortIds, POSTGREST_IN_CHUNK_SIZE)) {
    const baseQuery = supabase
      .from("tickets")
      .select("id,short_id,is_global,creator_uid,deleted_at,purged_at")
      .in("short_id", shortIdChunk);

    const { data, error } = params.isAdmin
      ? await baseQuery.is("purged_at", null)
      : await baseQuery.is("deleted_at", null).is("purged_at", null);

    if (error) {
      throw new Error(`读取工单失败：${error.message}`);
    }

    ticketRows.push(...(data ?? []));
  }

  if (params.isAdmin) {
    for (const row of ticketRows) {
      const shortId = String((row as any).short_id ?? "").toLowerCase();
      const ticketId = String((row as any).id ?? "");
      if (shortId && ticketId) map.set(shortId, ticketId);
    }
    return map;
  }

  // Non-admin: only link to tickets the viewer can access.
  const viewerUid = params.viewerUid;
  if (viewerUid == null) return map;

  const remainingTicketIds: string[] = [];
  const shortIdByTicketId = new Map<string, string>();

  for (const row of ticketRows) {
    const ticketId = String((row as any).id ?? "");
    const shortId = String((row as any).short_id ?? "").toLowerCase();
    if (!ticketId || !shortId) continue;

    const isGlobal = Boolean((row as any).is_global);
    const creatorUid = Number((row as any).creator_uid);
    if (isGlobal || (Number.isFinite(creatorUid) && creatorUid === viewerUid)) {
      map.set(shortId, ticketId);
      continue;
    }

    remainingTicketIds.push(ticketId);
    shortIdByTicketId.set(ticketId, shortId);
  }

  if (remainingTicketIds.length === 0) return map;

  const participantRows: any[] = [];
  for (const ids of chunkArray(remainingTicketIds, POSTGREST_IN_CHUNK_SIZE)) {
    const res = await supabase
      .from("ticket_participants")
      .select("ticket_id")
      .eq("uid", viewerUid)
      .in("ticket_id", ids);
    if (res.error) {
      throw new Error(`校验权限失败：${res.error.message}`);
    }
    participantRows.push(...(res.data ?? []));
  }

  for (const row of participantRows) {
    const ticketId = String((row as any).ticket_id ?? "");
    const shortId = shortIdByTicketId.get(ticketId);
    if (shortId && ticketId) {
      map.set(shortId, ticketId);
    }
  }

  return map;
}

/**
 * 批量处理 markdown：将 #short_id 替换为指向工单的链接。
 * - 管理员：允许链接到全部未 purged 的工单
 * - 普通用户：仅链接到自己可访问的工单（创建者 / 参与者 / 全体工单）
 */
export async function processTicketLinksInManyMarkdowns(
  markdowns: string[],
  viewerUid: number | null,
  isAdmin: boolean = false,
): Promise<string[]> {
  const list = Array.isArray(markdowns) ? markdowns : [];
  if (list.length === 0) return [];

  const basePath = isAdmin ? "/admin/tickets" : "/tickets";

  const shortIds = new Set<string>();
  for (const md of list) {
    const text = String(md ?? "");
    for (const m of text.matchAll(SHORT_ID_PATTERN)) {
      const shortId = String(m[1] ?? "").toLowerCase();
      if (shortId) shortIds.add(shortId);
    }
  }

  if (shortIds.size === 0) return list;

  const shortIdToTicketId = await resolveAccessibleTicketIdsByShortId({
    shortIds: Array.from(shortIds),
    viewerUid,
    isAdmin,
  });

  if (shortIdToTicketId.size === 0) return list;

  return list.map((md) =>
    replaceShortIdsWithLinks(String(md ?? ""), basePath, shortIdToTicketId),
  );
}

/**
 * Process markdown content to replace #shortid patterns with links to tickets.
 */
export async function processTicketLinks(
  markdown: string,
  viewerUid: number | null,
  isAdmin: boolean = false,
): Promise<string> {
  const [processed] = await processTicketLinksInManyMarkdowns(
    [markdown],
    viewerUid,
    isAdmin,
  );
  return processed ?? markdown;
}
