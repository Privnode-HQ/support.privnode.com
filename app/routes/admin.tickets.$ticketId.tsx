import type { Route } from "./+types/admin.tickets.$ticketId";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Textarea,
  useDisclosure,
} from "@heroui/react";
import { Form, data, redirect } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { requireAdmin } from "../server/admin";
import {
  addAdminReply,
  assignTicket,
  closeTicketAsAdmin,
  getTicketById,
  listAllCategories,
  listAllUsers,
} from "../server/models/admin.server";
import { listMessages } from "../server/models/tickets.server";
import { ticketStatusLabel } from "../shared/tickets";
import { getSupabaseAdminDb } from "../server/supabase.server";
import {
  listAttachmentsForTicket,
  uploadAttachments,
} from "../server/models/attachments.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  const ticketId = params.ticketId;

  const [ticket, messages, attachments, categories, users] = await Promise.all([
    getTicketById(ticketId),
    listMessages(ticketId),
    listAttachmentsForTicket(ticketId),
    listAllCategories(),
    listAllUsers(),
  ]);
  if (!ticket) throw new Response("Not Found", { status: 404 });

  return data({
    admin: { uid: admin.uid },
    ticket,
    messages,
    attachments,
    categories,
    users,
  });
}

export async function action({ request, params }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const ticketId = params.ticketId;
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  const files = form
    .getAll("attachments")
    .filter((v): v is File => v instanceof File && v.size > 0);

  if (intent === "assignToMe") {
    await assignTicket({ ticketId, uid: admin.uid });
    return redirect(returnTo);
  }

  if (intent === "reply") {
    const actor = String(form.get("actor") ?? "staff") as
      | "staff"
      | "anonymous"
      | "system";
    const bodyMarkdown = String(form.get("bodyMarkdown") ?? "").trim();
    if (!bodyMarkdown) {
      return data(
        { ok: false as const, error: "回复内容不能为空。" },
        { status: 400 }
      );
    }

    // Prefer display_name in DB if present.
    const supabase = getSupabaseAdminDb();
    const { data: me, error } = await supabase
      .from("users")
      .select("display_name,username")
      .eq("uid", admin.uid)
      .maybeSingle();
    if (error) throw new Error(`读取管理员信息失败：${error.message}`);
    const display = (me as any)?.display_name ?? (me as any)?.username ?? "管理员";

    const { messageId } = await addAdminReply({
      ticketId,
      actor,
      authorUid: admin.uid,
      authorDisplayName: display,
      bodyMarkdown,
    });

    try {
      await uploadAttachments({
        ticketId,
        messageId,
        uploaderUid: admin.uid,
        files,
      });
    } catch (e: any) {
      return data(
        {
          ok: false as const,
          error:
            e instanceof Error
              ? e.message
              : "附件上传失败（回复已发送）。",
        },
        { status: 400 }
      );
    }
    return redirect(returnTo);
  }

  if (intent === "close") {
    const reason = String(form.get("reason") ?? "").trim() || "已完成";
    await closeTicketAsAdmin({ ticketId, reason });
    return redirect(returnTo);
  }

  return data(
    { ok: false as const, error: "未知操作。" },
    { status: 400 }
  );
}

function ActorLabel(actor: string, name: string | null) {
  if (actor === "customer") return name ? `客户：${name}` : "客户";
  if (actor === "staff") return name ? `工作人员：${name}` : "工作人员";
  if (actor === "system") return "系统";
  if (actor === "anonymous") return "匿名";
  return actor;
}

export default function AdminTicketDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { ticket, messages, attachments, categories, users } = loaderData;
  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
  const userMap = new Map(users.map((u) => [u.uid, u.display_name ?? u.username]));
  const { isOpen, onOpen, onClose } = useDisclosure();

  // Reverse messages to show newest first
  const reversedMessages = [...messages].reverse();

  const attachmentsByMessage = new Map<string, typeof attachments>();
  for (const a of attachments) {
    if (!a.message_id) continue;
    const list = attachmentsByMessage.get(a.message_id) ?? [];
    list.push(a);
    attachmentsByMessage.set(a.message_id, list);
  }

  const statusColor =
    ticket.status === "closed"
      ? "default"
      : ticket.status === "replied_by_staff"
        ? "success"
        : ticket.status === "replied_by_customer"
          ? "warning"
          : ticket.status === "assigned"
            ? "primary"
            : "default";

  // Reply form component
  const ReplyForm = () => (
    <Card className="shadow-none border border-default-200">
      <CardHeader className="font-medium text-sm px-3 py-2">回复</CardHeader>
      <CardBody className="px-3 py-3">
        <Form method="post" className="space-y-2" encType="multipart/form-data">
          <input type="hidden" name="_intent" value="reply" />

          <Select name="actor" label="回复身份" defaultSelectedKeys={["staff"]}>
            <SelectItem key="staff">操作员</SelectItem>
            <SelectItem key="anonymous">匿名</SelectItem>
            <SelectItem key="system">系统</SelectItem>
          </Select>

          <Textarea
            name="bodyMarkdown"
            label="回复内容（Markdown）"
            minRows={4}
            isRequired
          />

          <div className="space-y-1">
            <div className="text-sm font-medium">附件（可选）</div>
            <input
              type="file"
              name="attachments"
              multiple
              className="block w-full text-sm"
            />
            <div className="text-xs text-default-500">单文件不超过 2MB。</div>
          </div>
          <Button color="primary" type="submit" className="h-9">
            发送回复
          </Button>
        </Form>
      </CardBody>
    </Card>
  );

  return (
    <div className="p-2 space-y-3">
      <div className="sticky top-0 z-10 -mx-2 px-2 py-2 bg-background/90 backdrop-blur border-b border-default-200">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{ticket.subject}</h1>
            <div className="mt-0.5 text-xs text-default-500 truncate">
              客户：{userMap.get(ticket.creator_uid) ?? `uid:${ticket.creator_uid}`} ·
              类别：{categoryMap.get(ticket.category_id) ?? ticket.category_id}
            </div>
            <div className="mt-0.5 text-xs text-default-500 truncate">
              创建：{new Date(ticket.created_at).toLocaleString("zh-CN")} · 更新：
              {new Date(ticket.updated_at).toLocaleString("zh-CN")}
              {ticket.assigned_to_uid ? (
                <>
                  {" "}· 分配给：
                  {userMap.get(ticket.assigned_to_uid) ?? `uid:${ticket.assigned_to_uid}`}
                </>
              ) : (
                " · 未分配"
              )}
            </div>
            {ticket.status === "closed" ? (
              <div className="mt-0.5 text-xs text-default-600 truncate">
                关闭原因：{ticket.closed_reason ?? "-"}
              </div>
            ) : null}
          </div>

          <div className="shrink-0 flex items-center gap-2">
            <Chip color={statusColor as any} variant="flat" size="sm">
              {ticketStatusLabel(ticket.status as any)}
            </Chip>
            {ticket.status !== "closed" && ticket.assigned_to_uid !== loaderData.admin.uid ? (
              <Form method="post">
                <input type="hidden" name="_intent" value="assignToMe" />
                <Button
                  color="primary"
                  variant="flat"
                  type="submit"
                  className="h-8 px-3 text-sm"
                >
                  分配给我
                </Button>
              </Form>
            ) : null}
            {ticket.status !== "closed" && (
              <Button
                color="danger"
                variant="flat"
                onPress={onOpen}
                className="h-8 px-3 text-sm"
              >
                关闭
              </Button>
            )}
          </div>
        </div>
      </div>

      {actionData?.ok === false ? (
        <p className="text-danger text-sm">{actionData.error}</p>
      ) : null}

      <details className="rounded-medium border border-default-200">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
          表单数据
        </summary>
        <div className="px-3 pb-3">
          <pre className="text-xs bg-default-100 p-3 rounded-medium overflow-auto">
            {JSON.stringify(ticket.form_data ?? {}, null, 2)}
          </pre>
        </div>
      </details>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">对话</h2>
          <div className="text-xs text-default-500">
            {reversedMessages.length} 条
          </div>
        </div>

        {reversedMessages.length === 0 ? (
          <p className="text-sm text-default-600">暂无消息。</p>
        ) : (
          <div className="space-y-2">
            {reversedMessages.map((m) => (
              <Card key={m.id} className="shadow-none border border-default-200">
                <CardBody className="space-y-2 px-3 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm font-medium">
                      {ActorLabel(m.actor, m.author_display_name)}
                    </div>
                    <div className="text-xs text-default-500">
                      {new Date(m.created_at).toLocaleString("zh-CN")}
                    </div>
                  </div>
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.body_markdown}
                    </ReactMarkdown>
                  </div>

                  {attachmentsByMessage.get(m.id)?.length ? (
                    <div className="text-sm text-default-600">
                      附件：
                      {attachmentsByMessage.get(m.id)!.map((a) => (
                        <span key={a.id} className="ml-2">
                          <a
                            className="text-primary underline"
                            href={`/attachments/${a.id}`}
                          >
                            {a.filename}
                          </a>
                          <span className="text-xs text-default-500">
                            {" "}({Math.ceil(a.size_bytes / 1024)} KB)
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </div>

      {ticket.status !== "closed" && <ReplyForm />}

      {/* Close ticket confirmation modal */}
      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalContent>
          <Form method="post" onSubmit={onClose}>
            <input type="hidden" name="_intent" value="close" />
            <ModalHeader>关闭工单</ModalHeader>
            <ModalBody>
              <Input
                name="reason"
                label="关闭原因（可选）"
                placeholder="例如：已完成 / 其它（可自填写）"
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose}>
                取消
              </Button>
              <Button color="danger" type="submit">
                确认关闭
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>
    </div>
  );
}
