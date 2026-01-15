import type { Route } from "./+types/tickets.$ticketId";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  useDisclosure,
} from "@heroui/react";
import { Form, data, redirect } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ticketStatusLabel } from "../shared/tickets";

export async function loader({ request, params }: Route.LoaderArgs) {
  const { requireUser } = await import("../server/auth");
  const { getTicketForUser, listMessages } = await import(
    "../server/models/tickets.server"
  );
  const { listAttachmentsForTicket } = await import(
    "../server/models/attachments.server"
  );
  const { processTicketLinks } = await import("../server/markdown.server");

  const user = await requireUser(request);
  const ticketId = params.ticketId;

  const ticket = await getTicketForUser({ uid: user.uid, ticketId });
  if (!ticket) {
    throw new Response("Not Found", { status: 404 });
  }
  const [messages, attachments] = await Promise.all([
    listMessages(ticketId),
    listAttachmentsForTicket(ticketId),
  ]);

  // Process ticket links in message markdown
  const processedMessages = await Promise.all(
    messages.map(async (msg) => ({
      ...msg,
      body_markdown: await processTicketLinks(msg.body_markdown, user.uid, false),
    }))
  );

  return data({ ticket, messages: processedMessages, attachments });
}

export async function action({ request, params }: Route.ActionArgs) {
  const { requireUser } = await import("../server/auth");
  const { addCustomerReply, closeTicket } = await import(
    "../server/models/tickets.server"
  );
  const { uploadAttachments } = await import(
    "../server/models/attachments.server"
  );

  const user = await requireUser(request);
  const ticketId = params.ticketId;
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  const files = form
    .getAll("attachments")
    .filter((v): v is File => v instanceof File && v.size > 0);

  if (intent === "reply") {
    const bodyMarkdown = String(form.get("bodyMarkdown") ?? "").trim();
    if (!bodyMarkdown) {
      return data(
        { ok: false as const, error: "回复内容不能为空。" },
        { status: 400 }
      );
    }
    const { messageId } = await addCustomerReply({
      uid: user.uid,
      displayName: user.username,
      ticketId,
      bodyMarkdown,
    });

    try {
      await uploadAttachments({
        ticketId,
        messageId,
        uploaderUid: user.uid,
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
    return redirect(`/tickets/${ticketId}`);
  }

  if (intent === "close") {
    const reason = String(form.get("reason") ?? "").trim() || "已完成";
    await closeTicket({ uid: user.uid, ticketId, reason });
    return redirect(`/tickets/${ticketId}`);
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

export default function TicketDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { ticket, messages, attachments } = loaderData;
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
    <Card>
      <CardHeader className="font-medium">回复工单</CardHeader>
      <CardBody>
        <Form method="post" className="space-y-3" encType="multipart/form-data">
          <input type="hidden" name="_intent" value="reply" />
          <Textarea
            name="bodyMarkdown"
            label="回复内容（Markdown）"
            placeholder="请输入回复内容"
            minRows={6}
            isRequired
          />

          <div className="space-y-2">
            <div className="text-sm font-medium">附件（可选）</div>
            <input
              type="file"
              name="attachments"
              multiple
              className="block w-full text-sm"
            />
            <div className="text-xs text-default-500">单文件不超过 2MB。</div>
          </div>

          <Button color="primary" type="submit">
            发送回复
          </Button>
        </Form>
      </CardBody>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-default-500">
                #{ticket.short_id}
              </span>
              <h1 className="text-2xl font-semibold">{ticket.subject}</h1>
            </div>
            <div className="text-sm text-default-600">
              类别：{ticket.category_name ?? ticket.category_id}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Chip color={statusColor as any} variant="flat">
              {ticketStatusLabel(ticket.status as any)}
            </Chip>
            {ticket.status !== "closed" && (
              <Button color="danger" variant="flat" onPress={onOpen}>
                关闭工单
              </Button>
            )}
          </div>
        </div>

        <div className="text-sm text-default-500">
          创建时间：{new Date(ticket.created_at).toLocaleString("zh-CN")} · 更新时间：
          {new Date(ticket.updated_at).toLocaleString("zh-CN")}
        </div>

        {ticket.status === "closed" ? (
          <div className="text-sm text-default-600">
            关闭原因：{ticket.closed_reason ?? "-"}
          </div>
        ) : null}
      </div>

      {actionData?.ok === false ? (
        <p className="text-danger">{actionData.error}</p>
      ) : null}

      {ticket.status !== "closed" && <ReplyForm />}

      <div className="space-y-4">
        <h2 className="text-lg font-medium">对话记录</h2>
        {reversedMessages.length === 0 ? (
          <p className="text-default-600">暂无消息。</p>
        ) : (
          reversedMessages.map((m) => (
            <Card key={m.id}>
              <CardBody className="space-y-3">
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
                        <a className="text-primary underline" href={`/attachments/${a.id}`}>
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
          ))
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
