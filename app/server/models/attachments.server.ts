import { randomUUID } from "node:crypto";
import { getSupabaseAdminDb } from "../supabase.server";

const BUCKET = "ticket-attachments";
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export type TicketAttachment = {
  id: string;
  ticket_id: string;
  message_id: string | null;
  uploader_uid: number;
  object_path: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  created_at: string;
};

export async function uploadAttachments(params: {
  ticketId: string;
  messageId: string;
  uploaderUid: number;
  files: File[];
}) {
  if (params.files.length === 0) return;
  const supabase = getSupabaseAdminDb();

  for (const f of params.files) {
    if (f.size <= 0) continue;
    if (f.size > MAX_FILE_BYTES) {
      throw new Error(`附件 ${f.name} 超过 2MB 限制。`);
    }

    const safeName = (f.name || "file").replaceAll("/", "_");
    const objectPath = `${params.uploaderUid}/${params.ticketId}/${randomUUID()}-${safeName}`;
    const contentType = f.type || "application/octet-stream";

    const buf = Buffer.from(await f.arrayBuffer());

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(objectPath, buf, {
        contentType,
        upsert: false,
      });
    if (upErr) {
      throw new Error(`上传附件失败：${upErr.message}`);
    }

    const { error: insertErr } = await supabase.from("ticket_attachments").insert({
      ticket_id: params.ticketId,
      message_id: params.messageId,
      uploader_uid: params.uploaderUid,
      object_path: objectPath,
      filename: f.name || safeName,
      content_type: contentType,
      size_bytes: f.size,
    });

    if (insertErr) {
      // If quota check fails, remove storage object to avoid orphaned blobs.
      await supabase.storage.from(BUCKET).remove([objectPath]);
      throw new Error(`写入附件记录失败：${insertErr.message}`);
    }
  }
}

export async function listAttachmentsForTicket(ticketId: string): Promise<TicketAttachment[]> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_attachments")
    .select(
      "id,ticket_id,message_id,uploader_uid,object_path,filename,content_type,size_bytes,created_at"
    )
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`读取附件失败：${error.message}`);
  return (data ?? []) as any;
}

export async function getAttachmentById(id: string): Promise<TicketAttachment | null> {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase
    .from("ticket_attachments")
    .select(
      "id,ticket_id,message_id,uploader_uid,object_path,filename,content_type,size_bytes,created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`读取附件失败：${error.message}`);
  return (data as any) ?? null;
}

export async function createAttachmentDownloadUrl(params: {
  objectPath: string;
}) {
  const supabase = getSupabaseAdminDb();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(params.objectPath, 60);
  if (error) throw new Error(`生成下载链接失败：${error.message}`);
  return data.signedUrl;
}
