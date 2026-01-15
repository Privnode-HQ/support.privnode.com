import type { Route } from "./+types/attachments.$attachmentId";
import { redirect } from "react-router";
import { requireUser } from "../server/auth";
import { getSupabaseAdminDb } from "../server/supabase.server";
import {
  createAttachmentDownloadUrl,
  getAttachmentById,
} from "../server/models/attachments.server";

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
    // Customer can only download attachments from their own tickets.
    const { data: t, error: tErr } = await supabase
      .from("tickets")
      .select("id")
      .eq("id", attachment.ticket_id)
      .eq("creator_uid", user.uid)
      .maybeSingle();
    if (tErr) throw new Error(`校验权限失败：${tErr.message}`);
    if (!t) throw new Response("Forbidden", { status: 403 });
  }

  const signedUrl = await createAttachmentDownloadUrl({
    objectPath: attachment.object_path,
  });

  return redirect(signedUrl);
}

export default function AttachmentDownload() {
  return null;
}
