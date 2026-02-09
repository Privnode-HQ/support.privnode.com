import type { Route } from "./+types/admin.tickets.$ticketId";
import type { Route as AdminTicketsRoute } from "./+types/admin.tickets";
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
import {
  Form,
  Link,
  data,
  redirect,
  useNavigation,
  useOutletContext,
} from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useMemo } from "react";
import { requireAdmin } from "../server/admin";
import {
  addAdminReply,
  assignTicket,
  closeTicketAsAdmin,
  getTicketById,
  purgeTicketAsAdmin,
  purgeTicketMessageAsAdmin,
  restoreTicketAsAdmin,
  restoreTicketMessageAsAdmin,
  softDeleteTicketAsAdmin,
  softDeleteTicketMessageAsAdmin,
} from "../server/models/admin.server";
import { listMessages, listParticipantsForTicket } from "../server/models/tickets.server";
import { ticketStatusLabel } from "../shared/tickets";
import { getSupabaseAdminDb } from "../server/supabase.server";
import {
  listAttachmentsForTicket,
  uploadAttachments,
} from "../server/models/attachments.server";

const MARKDOWN_PLUGINS = [remarkGfm];

type AdminTicketDetailLoaderData = Route.ComponentProps["loaderData"];
type TicketMessage = AdminTicketDetailLoaderData["messages"][number];
type TicketAttachment = AdminTicketDetailLoaderData["attachments"][number];

type AdminTicketsOutletContext = Pick<
  AdminTicketsRoute.ComponentProps["loaderData"],
  "categories" | "users"
>;

export async function loader({ request, params }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  const ticketId = params.ticketId;
  const { processTicketLinksInManyMarkdowns } = await import(
    "../server/markdown.server"
  );

  const [ticket, messages, attachments, participants] = await Promise.all([
    getTicketById(ticketId),
    listMessages(ticketId, { includeDeleted: true }),
    listAttachmentsForTicket(ticketId),
    listParticipantsForTicket(ticketId),
  ]);
  if (!ticket) throw new Response("Not Found", { status: 404 });

  // Process ticket links in message markdown (admin can access all tickets)
  const processedBodies = await processTicketLinksInManyMarkdowns(
    messages.map((m) => m.body_markdown),
    admin.uid,
    true,
  );
  const processedMessages = messages.map((msg, i) => ({
    ...msg,
    body_markdown: processedBodies[i] ?? msg.body_markdown,
  }));

  return data({
    admin: { uid: admin.uid },
    ticket,
    messages: processedMessages,
    attachments,
    participants,
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

  if (intent === "deleteTicket") {
    try {
      const res = await softDeleteTicketAsAdmin({
        ticketId,
        deletedByUid: admin.uid,
      });
      if (!res.deleted) {
        return data(
          { ok: false as const, error: "工单已删除。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "删除失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "restoreTicket") {
    try {
      const res = await restoreTicketAsAdmin({ ticketId });
      if (!res.restored) {
        return data(
          { ok: false as const, error: "工单未处于已删除状态，或已彻底删除。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "恢复失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "purgeTicket") {
    try {
      const reason = String(form.get("reason") ?? "").trim();
      const res = await purgeTicketAsAdmin({
        ticketId,
        purgedByUid: admin.uid,
        reason,
      });
      if (!res.purged) {
        return data(
          { ok: false as const, error: "工单未处于已删除状态，或已彻底删除。" },
          { status: 400 },
        );
      }
      return redirect(`/admin/tickets${url.search}`);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "彻底删除失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "deleteMessage") {
    const messageId = String(form.get("messageId") ?? "").trim();
    if (!messageId) {
      return data(
        { ok: false as const, error: "缺少 messageId。" },
        { status: 400 },
      );
    }
    try {
      const res = await softDeleteTicketMessageAsAdmin({
        ticketId,
        messageId,
        deletedByUid: admin.uid,
      });
      if (!res.deleted) {
        return data(
          { ok: false as const, error: "消息已删除或不存在。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "删除消息失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "restoreMessage") {
    const messageId = String(form.get("messageId") ?? "").trim();
    if (!messageId) {
      return data(
        { ok: false as const, error: "缺少 messageId。" },
        { status: 400 },
      );
    }
    try {
      const res = await restoreTicketMessageAsAdmin({ ticketId, messageId });
      if (!res.restored) {
        return data(
          { ok: false as const, error: "消息未处于已删除状态，或不存在。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "恢复消息失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "purgeMessage") {
    const messageId = String(form.get("messageId") ?? "").trim();
    if (!messageId) {
      return data(
        { ok: false as const, error: "缺少 messageId。" },
        { status: 400 },
      );
    }
    try {
      const res = await purgeTicketMessageAsAdmin({
        ticketId,
        messageId,
        purgedByUid: admin.uid,
      });
      if (!res.purged) {
        return data(
          { ok: false as const, error: "消息未处于已删除状态，或已彻底删除/不存在。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "彻底删除消息失败。" },
        { status: 500 },
      );
    }
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

const MessageCard = memo(function MessageCard(props: {
  message: TicketMessage;
  deletedByLabel: string | null;
  attachments: TicketAttachment[];
  pendingIntent: string;
  pendingMessageId: string;
}) {
  const m = props.message;
  const isMsgDeleted = Boolean(m.deleted_at);
  const isRestoring =
    props.pendingIntent === "restoreMessage" && props.pendingMessageId === m.id;
  const isPurging =
    props.pendingIntent === "purgeMessage" && props.pendingMessageId === m.id;
  const isDeleting =
    props.pendingIntent === "deleteMessage" && props.pendingMessageId === m.id;
  const isMutating = isRestoring || isPurging || isDeleting;

  return (
    <Card
      className={[
        "shadow-none border border-default-200",
        isMsgDeleted ? "opacity-60" : "",
      ].join(" ")}
    >
      <CardBody className="space-y-2 px-3 py-2">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">
                {ActorLabel(m.actor, m.author_display_name)}
              </div>
              {isMsgDeleted ? (
                <Chip color="danger" variant="flat" size="sm">
                  已删除
                </Chip>
              ) : null}
            </div>
            <div className="text-xs text-default-500">
              {new Date(m.created_at).toLocaleString("zh-CN")}
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {isMsgDeleted ? (
              <>
                <Form method="post">
                  <input type="hidden" name="_intent" value="restoreMessage" />
                  <input type="hidden" name="messageId" value={m.id} />
                  <Button
                    size="sm"
                    variant="flat"
                    color="primary"
                    type="submit"
                    isLoading={isRestoring}
                    isDisabled={isMutating}
                  >
                    恢复
                  </Button>
                </Form>
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (
                      !window.confirm(
                        "确认彻底删除该条消息？彻底删除后管理员端也不显示，但数据库仍保留记录。",
                      )
                    ) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="_intent" value="purgeMessage" />
                  <input type="hidden" name="messageId" value={m.id} />
                  <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    type="submit"
                    isLoading={isPurging}
                    isDisabled={isMutating}
                  >
                    彻底删除
                  </Button>
                </Form>
              </>
            ) : (
              <Form
                method="post"
                onSubmit={(e) => {
                  if (!window.confirm("确认删除该条消息？")) {
                    e.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="_intent" value="deleteMessage" />
                <input type="hidden" name="messageId" value={m.id} />
                <Button
                  size="sm"
                  variant="light"
                  color="danger"
                  type="submit"
                  isLoading={isDeleting}
                  isDisabled={isMutating}
                >
                  删除
                </Button>
              </Form>
            )}
          </div>
        </div>

        {isMsgDeleted ? (
          <div className="text-xs text-danger">
            已删除：
            {m.deleted_at ? new Date(m.deleted_at).toLocaleString("zh-CN") : "-"}
            {props.deletedByLabel ? ` · 操作人：${props.deletedByLabel}` : ""}
          </div>
        ) : null}

        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
            {m.body_markdown}
          </ReactMarkdown>
        </div>

        {props.attachments.length ? (
          <div className="text-sm text-default-600">
            附件：
            {props.attachments.map((a) => (
              <span key={a.id} className="ml-2">
                <a
                  className="text-primary underline"
                  href={`/attachments/${a.id}`}
                >
                  {a.filename}
                </a>
                <span className="text-xs text-default-500">
                  {" "}
                  ({Math.ceil(a.size_bytes / 1024)} KB)
                </span>
              </span>
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
});

export default function AdminTicketDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { categories, users } = useOutletContext<AdminTicketsOutletContext>();
  const { ticket, messages, attachments, participants } = loaderData;
  const navigation = useNavigation();
  const pendingIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("_intent") ?? "")
      : "";
  const pendingMessageId =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("messageId") ?? "")
      : "";
  const isReplying = pendingIntent === "reply";
  const isAssigningToMe = pendingIntent === "assignToMe";
  const isClosing = pendingIntent === "close";
  const isDeletingTicket = pendingIntent === "deleteTicket";
  const isRestoringTicket = pendingIntent === "restoreTicket";
  const isPurgingTicket = pendingIntent === "purgeTicket";
  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );
  const userMap = useMemo(
    () =>
      new Map(users.map((u) => [u.uid, u.display_name ?? u.username])),
    [users],
  );
  const { isOpen, onOpen, onClose } = useDisclosure();
  const deleteModal = useDisclosure();
  const purgeModal = useDisclosure();
  const isDeleted = Boolean(ticket.deleted_at);

  // Reverse messages to show newest first
  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);

  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, TicketAttachment[]>();
    for (const a of attachments) {
      const messageId = String((a as any).message_id ?? "");
      if (!messageId) continue;
      const list = map.get(messageId) ?? [];
      list.push(a);
      map.set(messageId, list);
    }
    return map;
  }, [attachments]);

  const participantsWithCreator = useMemo(() => {
    if (ticket.is_global) return [];
    const uidSet = new Set(participants.map((p) => p.uid));
    const list = [...participants];
    if (!uidSet.has(ticket.creator_uid)) {
      const creator = users.find((u) => u.uid === ticket.creator_uid);
      if (creator) {
        list.unshift({
          uid: creator.uid,
          username: creator.username,
          display_name: creator.display_name ?? null,
          is_admin: Boolean(creator.is_admin),
        });
      }
    }
    return list;
  }, [participants, ticket.creator_uid, ticket.is_global, users]);

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

          <Select
            name="actor"
            label="回复身份"
            defaultSelectedKeys={["staff"]}
            isDisabled={isReplying}
          >
            <SelectItem key="staff">操作员</SelectItem>
            <SelectItem key="anonymous">匿名</SelectItem>
            <SelectItem key="system">系统</SelectItem>
          </Select>

          <Textarea
            name="bodyMarkdown"
            label="回复内容（Markdown）"
            minRows={4}
            isRequired
            isDisabled={isReplying}
          />

          <div className="space-y-1">
            <div className="text-sm font-medium">附件（可选）</div>
            <input
              type="file"
              name="attachments"
              multiple
              className="block w-full text-sm"
              disabled={isReplying}
            />
            <div className="text-xs text-default-500">单文件不超过 2MB。</div>
          </div>
          <Button
            color="primary"
            type="submit"
            className="h-9"
            isLoading={isReplying}
            isDisabled={isReplying}
          >
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
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-default-500">
                #{ticket.short_id}
              </span>
              <h1 className="text-base font-semibold truncate">{ticket.subject}</h1>
            </div>
            <div className="mt-0.5 text-xs text-default-500 truncate">
              创建者：{userMap.get(ticket.creator_uid) ?? `uid:${ticket.creator_uid}`} (uid:{ticket.creator_uid}) ·
              类别：{categoryMap.get(ticket.category_id) ?? ticket.category_id} ·
              范围：
              {ticket.is_global
                ? "所有用户"
                : participantsWithCreator.length > 0
                  ? `${participantsWithCreator.length} 位用户`
                  : "仅创建者"}
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
            {isDeleted ? (
              <div className="mt-0.5 text-xs text-danger truncate">
                已删除：
                {ticket.deleted_at
                  ? new Date(ticket.deleted_at).toLocaleString("zh-CN")
                  : "-"}
                {ticket.deleted_by_uid
                  ? ` · 操作人：${userMap.get(ticket.deleted_by_uid) ?? `uid:${ticket.deleted_by_uid}`} (uid:${ticket.deleted_by_uid})`
                  : ""}
              </div>
            ) : null}
            {ticket.merged_into_ticket_id ? (
              <div className="mt-0.5 text-xs text-warning truncate">
                该工单已合并到主工单：{" "}
                <Link
                  className="text-primary underline"
                  to={`/admin/tickets/${ticket.merged_into_ticket_id}`}
                >
                  查看主工单
                </Link>
              </div>
            ) : null}
          </div>

          <div className="shrink-0 flex items-center gap-2">
            {isDeleted ? (
              <Chip color="danger" variant="flat" size="sm">
                已删除
              </Chip>
            ) : null}
            <Chip color={statusColor as any} variant="flat" size="sm">
              {ticketStatusLabel(ticket.status as any)}
            </Chip>
            {isDeleted ? (
              <Form method="post">
                <input type="hidden" name="_intent" value="restoreTicket" />
                <Button
                  color="primary"
                  variant="flat"
                  type="submit"
                  className="h-8 px-3 text-sm"
                  isLoading={isRestoringTicket}
                  isDisabled={isRestoringTicket}
                >
                  恢复
                </Button>
              </Form>
            ) : null}
            {isDeleted ? (
              <Button
                color="danger"
                variant="flat"
                onPress={purgeModal.onOpen}
                className="h-8 px-3 text-sm"
              >
                彻底删除
              </Button>
            ) : null}
            {ticket.status !== "closed" &&
            !isDeleted &&
            ticket.assigned_to_uid !== loaderData.admin.uid ? (
              <Form method="post">
                <input type="hidden" name="_intent" value="assignToMe" />
                <Button
                  color="primary"
                  variant="flat"
                  type="submit"
                  className="h-8 px-3 text-sm"
                  isLoading={isAssigningToMe}
                  isDisabled={isAssigningToMe}
                >
                  分配给我
                </Button>
              </Form>
            ) : null}
            {ticket.status !== "closed" && !isDeleted ? (
              <Button
                color="danger"
                variant="flat"
                onPress={onOpen}
                className="h-8 px-3 text-sm"
              >
                关闭
              </Button>
            ) : null}
            {!isDeleted ? (
              <Button
                color="danger"
                variant="light"
                onPress={deleteModal.onOpen}
                className="h-8 px-3 text-sm"
              >
                删除
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {actionData?.ok === false ? (
        <p className="text-danger text-sm">{actionData.error}</p>
      ) : null}

      <details className="rounded-medium border border-default-200">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
          涉及用户
        </summary>
        <div className="px-3 pb-3">
          {ticket.is_global ? (
            <div className="text-sm text-default-600">所有用户</div>
          ) : participantsWithCreator.length === 0 ? (
            <div className="text-sm text-default-600">仅创建者</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {participantsWithCreator.map((u) => (
                <Chip key={u.uid} size="sm" variant="flat">
                  {u.display_name ?? u.username} (uid:{u.uid})
                </Chip>
              ))}
            </div>
          )}
        </div>
      </details>

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
            {reversedMessages.map((m) => {
              const deletedByLabel =
                m.deleted_by_uid != null
                  ? userMap.get(m.deleted_by_uid) ?? `uid:${m.deleted_by_uid}`
                  : null;
              const msgAttachments = attachmentsByMessage.get(m.id) ?? [];
              return (
                <MessageCard
                  key={m.id}
                  message={m}
                  deletedByLabel={deletedByLabel}
                  attachments={msgAttachments}
                  pendingIntent={pendingIntent}
                  pendingMessageId={pendingMessageId}
                />
              );
            })}
          </div>
        )}
      </div>

      {ticket.status !== "closed" && !isDeleted && <ReplyForm />}

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
                isDisabled={isClosing}
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={onClose} isDisabled={isClosing}>
                取消
              </Button>
              <Button
                color="danger"
                type="submit"
                isLoading={isClosing}
                isDisabled={isClosing}
              >
                确认关闭
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal isOpen={deleteModal.isOpen} onClose={deleteModal.onClose}>
        <ModalContent>
          <Form method="post" onSubmit={deleteModal.onClose}>
            <input type="hidden" name="_intent" value="deleteTicket" />
            <ModalHeader>删除工单</ModalHeader>
            <ModalBody>
              <div className="text-sm text-default-600">
                删除后客户侧不可见（软删除），管理员仍可查看。
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={deleteModal.onClose}
                isDisabled={isDeletingTicket}
              >
                取消
              </Button>
              <Button
                color="danger"
                type="submit"
                isLoading={isDeletingTicket}
                isDisabled={isDeletingTicket}
              >
                确认删除
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal isOpen={purgeModal.isOpen} onClose={purgeModal.onClose}>
        <ModalContent>
          <Form method="post" onSubmit={purgeModal.onClose}>
            <input type="hidden" name="_intent" value="purgeTicket" />
            <ModalHeader>彻底删除工单</ModalHeader>
            <ModalBody className="space-y-2">
              <div className="text-sm text-default-600">
                彻底删除后，管理员端也不再显示该工单，但数据库仍保留记录。
              </div>
              <Input
                name="reason"
                label="删除原因（可选）"
                placeholder="例如：误报 / 垃圾内容 / 重复导入"
                isDisabled={isPurgingTicket}
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={purgeModal.onClose}
                isDisabled={isPurgingTicket}
              >
                取消
              </Button>
              <Button
                color="danger"
                type="submit"
                isLoading={isPurgingTicket}
                isDisabled={isPurgingTicket}
              >
                确认彻底删除
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>
    </div>
  );
}
