import type { Route } from "./+types/attachments.$attachmentId";
import { redirect } from "react-router";
import { requireUser } from "../server/auth";
import { getSupabaseAdminDb } from "../server/supabase.server";
import {
  createAttachmentDownloadUrl,
  getAttachmentById,
} from "../server/models/attachments.server";
import { canUserAccessTicket } from "../server/models/tickets.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const attachmentId = params.attachmentId;

  const attachment = await getAttachmentById(attachmentId);
  if (!attachment) {
    throw new Response("Not Found", { status: 404 });
  }

  const supabase = getSupabaseAdminDb();
  const { data: u, error: uErr } = await supabase
    .from("users")
    .select("is_admin")
    .eq("uid", user.uid)
    .maybeSingle();
  if (uErr) throw new Error(`读取权限失败：${uErr.message}`);
  const isAdmin = Boolean((u as any)?.is_admin);

  if (!isAdmin) {
    const ok = await canUserAccessTicket(user.uid, attachment.ticket_id);
    if (!ok) throw new Response("Forbidden", { status: 403 });

    if (attachment.message_id) {
      const { data: msg, error: mErr } = await supabase
        .from("ticket_messages")
        .select("id,ticket_id,deleted_at,purged_at")
        .eq("id", attachment.message_id)
        .maybeSingle();
      if (mErr) throw new Error(`读取消息失败：${mErr.message}`);
      if (!msg) throw new Response("Forbidden", { status: 403 });
      if (String((msg as any).ticket_id ?? "") !== attachment.ticket_id) {
        throw new Response("Forbidden", { status: 403 });
      }
      if ((msg as any).deleted_at || (msg as any).purged_at) {
        throw new Response("Forbidden", { status: 403 });
      }
    }
  }

  const signedUrl = await createAttachmentDownloadUrl({
    objectPath: attachment.object_path,
  });

  return redirect(signedUrl);
}

export default function AttachmentDownload() {
  return null;
}
