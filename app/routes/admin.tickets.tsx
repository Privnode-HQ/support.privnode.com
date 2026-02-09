import type { Route } from "./+types/admin.tickets";
import {
  Button,
  Checkbox,
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  NavLink,
  Outlet,
  data,
  redirect,
  useLocation,
  useNavigation,
  useParams,
  useRevalidator,
  useSubmit,
} from "react-router";
import { requireAdmin } from "../server/admin";
import { recomputeTicketSmartScores } from "../server/models/smart-sort.server";
import {
  addAdminReplyBatch,
  type AdminTicketSort,
  type AdminTicketSortDirection,
  closeTicketsAsAdminBatch,
  createTicketAsAdmin,
  listAllCategoriesBasic,
  listAllTickets,
  listAllUsersBasic,
  mergeTicketsAsAdmin,
  softDeleteTicketsAsAdminBatch,
} from "../server/models/admin.server";
import { getSupabaseAdminDb } from "../server/supabase.server";
import { type TicketStatus, ticketStatusLabel } from "../shared/tickets";
import { uploadAttachments } from "../server/models/attachments.server";

const ALL_TICKET_STATUSES: TicketStatus[] = [
  "pending_assign",
  "assigned",
  "replied_by_staff",
  "replied_by_customer",
  "closed",
];

type AdminTicketsLoaderData = Route.ComponentProps["loaderData"];
type TicketListItem = AdminTicketsLoaderData["tickets"][number];

type TicketRowView = {
  ticket: TicketListItem;
  creator: string;
  category: string;
  assignee: string;
  updatedAtText: string;
  nudgeTitle: string | null;
  isDeleted: boolean;
  showSmartScore: boolean;
  smartScoreText: string;
  smartScoreTitle: string;
};

function asTicketStatus(value: string | null): TicketStatus | null {
  if (!value) return null;
  if (ALL_TICKET_STATUSES.includes(value as TicketStatus)) return value as any;
  return null;
}

function parseTicketStatuses(values: string[]): TicketStatus[] {
  const set = new Set<TicketStatus>();
  for (const v of values) {
    const parsed = asTicketStatus(v);
    if (parsed) set.add(parsed);
  }
  return Array.from(set);
}

function parseAssignedFilters(
  values: string[],
  myUid: number,
): {
  selected: string[];
  unassigned: boolean;
  assignedToUids: number[];
} {
  const selected: string[] = [];
  let unassigned = false;
  const assignedToUids: number[] = [];

  for (const raw of values) {
    if (!raw || raw === "all") continue;
    if (raw === "unassigned") {
      selected.push(raw);
      unassigned = true;
      continue;
    }
    if (raw === "me") {
      selected.push(raw);
      assignedToUids.push(myUid);
      continue;
    }
    if (raw.startsWith("uid:")) {
      const uid = Number(raw.slice("uid:".length));
      if (Number.isFinite(uid)) {
        const normalized = `uid:${uid}`;
        selected.push(normalized);
        assignedToUids.push(uid);
      }
    }
  }

  return {
    selected: Array.from(new Set(selected)),
    unassigned,
    assignedToUids: Array.from(new Set(assignedToUids)),
  };
}

const COMPACT_DATETIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatCompactDateTime(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return COMPACT_DATETIME_FORMATTER.format(d);
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  const url = new URL(request.url);

  const statusParams = url.searchParams.getAll("status");
  const assignedParams = url.searchParams.getAll("assigned");
  const sortParam = String(url.searchParams.get("sort") ?? "");
  const dirParam = String(url.searchParams.get("dir") ?? "");
  const q = String(url.searchParams.get("q") ?? "").trim();

  const statuses = parseTicketStatuses(statusParams);
  const assigned = parseAssignedFilters(assignedParams, admin.uid);
  const sort: AdminTicketSort =
    sortParam === "created_at" ||
    sortParam === "updated_at" ||
    sortParam === "smart"
      ? sortParam
      : "updated_at";
  const dir: AdminTicketSortDirection =
    dirParam === "asc" || dirParam === "desc" ? dirParam : "desc";

  const [tickets, categories, users] = await Promise.all([
    listAllTickets({
      statuses: statuses.length > 0 ? statuses : undefined,
      unassigned: assigned.unassigned,
      assignedToUids:
        assigned.assignedToUids.length > 0
          ? assigned.assignedToUids
          : undefined,
      query: q || undefined,
      sort,
      sortDirection: dir,
    }),
    listAllCategoriesBasic(),
    listAllUsersBasic(),
  ]);

  return data({
    admin: { uid: admin.uid },
    tickets,
    categories,
    users,
    filters: {
      statuses,
      assigned: assigned.selected,
      q,
      sort,
      dir,
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "recomputeSmartScores") {
    try {
      await recomputeTicketSmartScores();
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        {
          ok: false as const,
          error: e instanceof Error ? e.message : "计算失败。",
        },
        { status: 500 }
      );
    }
  }

  if (intent === "batchReply") {
    const ticketIds = form
      .getAll("ticketIds")
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (ticketIds.length === 0) {
      return data(
        { ok: false as const, error: "请先选择至少一个未关闭的工单。" },
        { status: 400 },
      );
    }

    const actorRaw = String(form.get("actor") ?? "staff");
    const actor: "staff" | "anonymous" | "system" =
      actorRaw === "staff" || actorRaw === "anonymous" || actorRaw === "system"
        ? (actorRaw as "staff" | "anonymous" | "system")
        : "staff";
    const bodyMarkdown = String(form.get("bodyMarkdown") ?? "").trim();
    if (!bodyMarkdown) {
      return data(
        { ok: false as const, error: "回复内容不能为空。" },
        { status: 400 },
      );
    }

    try {
      // Prefer display_name in DB if present.
      const supabase = getSupabaseAdminDb();
      const { data: me, error } = await supabase
        .from("users")
        .select("display_name,username")
        .eq("uid", admin.uid)
        .maybeSingle();
      if (error) throw new Error(`读取管理员信息失败：${error.message}`);
      const display =
        (me as any)?.display_name ?? (me as any)?.username ?? "管理员";

      const result = await addAdminReplyBatch({
        ticketIds,
        actor,
        authorUid: admin.uid,
        authorDisplayName: display,
        bodyMarkdown,
      });

      if (result.replied_ticket_ids.length === 0) {
        return data(
          { ok: false as const, error: "所选工单均已关闭，无法回复。" },
          { status: 400 },
        );
      }

      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "操作失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "batchClose") {
    const ticketIds = form
      .getAll("ticketIds")
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (ticketIds.length === 0) {
      return data(
        { ok: false as const, error: "请先选择至少一个未关闭的工单。" },
        { status: 400 },
      );
    }

    const reason = String(form.get("reason") ?? "").trim() || "已完成";

    try {
      const result = await closeTicketsAsAdminBatch({ ticketIds, reason });
      if (result.closed_ticket_ids.length === 0) {
        return data(
          { ok: false as const, error: "所选工单均已关闭。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "操作失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "batchDelete") {
    const ticketIds = form
      .getAll("ticketIds")
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    if (ticketIds.length === 0) {
      return data(
        { ok: false as const, error: "请先选择至少一个工单。" },
        { status: 400 },
      );
    }

    try {
      const result = await softDeleteTicketsAsAdminBatch({
        ticketIds,
        deletedByUid: admin.uid,
      });
      if (result.deleted_ticket_ids.length === 0) {
        return data(
          { ok: false as const, error: "所选工单均已删除。" },
          { status: 400 },
        );
      }
      return redirect(returnTo);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "操作失败。" },
        { status: 500 },
      );
    }
  }

  if (intent === "createTicket") {
    const categoryId = String(form.get("categoryId") ?? "");
    const subject = String(form.get("subject") ?? "").trim();
    const bodyMarkdown = String(form.get("bodyMarkdown") ?? "").trim();
    const isGlobal = String(form.get("isGlobal") ?? "0") === "1";

    const participantUids = form
      .getAll("participantUids")
      .map((v) => Number(String(v ?? "").trim()))
      .filter((v) => Number.isFinite(v));

    if (!categoryId) {
      return data(
        { ok: false as const, error: "请先选择工单类别。" },
        { status: 400 },
      );
    }
    if (!subject) {
      return data(
        { ok: false as const, error: "请填写标题。" },
        { status: 400 },
      );
    }
    if (!bodyMarkdown) {
      return data(
        { ok: false as const, error: "请填写工单内容（支持 Markdown）。" },
        { status: 400 },
      );
    }

    const files = form
      .getAll("attachments")
      .filter((v): v is File => v instanceof File && v.size > 0);

    let created: { id: string; messageId: string } | null = null;
    try {
      // Prefer display_name in DB if present.
      const supabase = getSupabaseAdminDb();
      const { data: me, error } = await supabase
        .from("users")
        .select("display_name,username")
        .eq("uid", admin.uid)
        .maybeSingle();
      if (error) throw new Error(`读取管理员信息失败：${error.message}`);
      const display =
        (me as any)?.display_name ?? (me as any)?.username ?? "管理员";

      created = await createTicketAsAdmin({
        creatorUid: admin.uid,
        creatorDisplayName: display,
        categoryId,
        subject,
        formData: {},
        bodyMarkdown,
        participantUids,
        isGlobal,
      });

      await uploadAttachments({
        ticketId: created.id,
        messageId: created.messageId,
        uploaderUid: admin.uid,
        files,
      });
    } catch (e: any) {
      return data(
        {
          ok: false as const,
          error: e instanceof Error ? e.message : "创建工单失败。",
          createdTicketId: created?.id ?? null,
        },
        { status: 400 },
      );
    }

    return redirect(`/admin/tickets/${created.id}${url.search}`);
  }

  if (intent === "mergeTickets") {
    const targetTicketId = String(form.get("targetTicketId") ?? "").trim();
    const sourceTicketIds = form
      .getAll("sourceTicketIds")
      .map((v) => String(v ?? "").trim())
      .filter(Boolean);
    const reason = String(form.get("reason") ?? "").trim();
    const mergeMessages = String(form.get("mergeMessages") ?? "1") === "1";

    if (!targetTicketId) {
      return data(
        { ok: false as const, error: "请先选择一个目标工单。" },
        { status: 400 },
      );
    }
    if (sourceTicketIds.length === 0) {
      return data(
        { ok: false as const, error: "请先选择至少一个待合并的工单。" },
        { status: 400 },
      );
    }

    try {
      const result = await mergeTicketsAsAdmin({
        targetTicketId,
        sourceTicketIds,
        mergedByUid: admin.uid,
        mergedReason: reason,
        mergeMessages,
      });
      if (result.merged_source_ticket_ids.length === 0) {
        return data(
          { ok: false as const, error: "没有可合并的工单（可能已被合并）。" },
          { status: 400 },
        );
      }
      return redirect(`/admin/tickets/${targetTicketId}${url.search}`);
    } catch (e: any) {
      return data(
        { ok: false as const, error: e instanceof Error ? e.message : "合并失败。" },
        { status: 500 },
      );
    }
  }

  return data(
    { ok: false as const, error: "未知操作。" },
    { status: 400 }
  );
}

function StatusChip({ status }: { status: string }) {
  const label = ticketStatusLabel(status as any);
  const color =
    status === "closed"
      ? "default"
      : status === "replied_by_staff"
        ? "success"
        : status === "replied_by_customer"
          ? "warning"
          : status === "assigned"
            ? "primary"
            : "default";
  return (
    <Chip color={color as any} variant="flat" size="sm">
      {label}
    </Chip>
  );
}

function FilterChipCheckbox(props: {
  name: string;
  value: string;
  label: string;
  defaultChecked: boolean;
  onChange: (form: HTMLFormElement | null) => void;
}) {
  return (
    <label className="inline-flex items-center cursor-pointer select-none">
      <input
        type="checkbox"
        name={props.name}
        value={props.value}
        defaultChecked={props.defaultChecked}
        onChange={(e) => props.onChange(e.currentTarget.form)}
        className="sr-only peer"
      />
      <span className="inline-flex items-center rounded-medium border border-default-200 px-2 py-1 text-xs bg-background text-default-700 peer-checked:bg-default-100 peer-checked:border-default-400 peer-checked:text-foreground">
        {props.label}
      </span>
    </label>
  );
}

const TicketListRow = memo(function TicketListRow(props: {
  row: TicketRowView;
  search: string;
  isActive: boolean;
  isSelected: boolean;
  onToggleSelected: (ticketId: string, checked: boolean) => void;
}) {
  const t = props.row.ticket;
  return (
    <div
      className={[
        "border-b border-default-200 px-2 py-2 hover:bg-default-100",
        props.isActive ? "bg-default-100" : "",
        props.row.isDeleted ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <div className="pt-0.5">
          <Checkbox
            aria-label={`选择工单 #${t.short_id}`}
            isSelected={props.isSelected}
            isDisabled={props.row.isDeleted}
            onValueChange={(checked) => props.onToggleSelected(t.id, checked)}
          />
        </div>

        <NavLink
          to={{ pathname: t.id, search: props.search }}
          className="flex-1 min-w-0"
          aria-current={props.isActive ? "page" : undefined}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs text-default-500">
                  #{t.short_id}
                </span>
                {t.nudge_pending && !props.row.isDeleted ? (
                  <span
                    title={props.row.nudgeTitle ?? "客户催单"}
                    className="text-warning text-xs"
                  >
                    ★
                  </span>
                ) : null}
                <div className="text-sm font-medium truncate">{t.subject}</div>
              </div>
              <div className="mt-0.5 text-xs text-default-500 truncate">
                {props.row.creator} · {props.row.category} ·{" "}
                {props.row.updatedAtText}
              </div>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1">
              {props.row.isDeleted ? (
                <Chip color="danger" variant="flat" size="sm">
                  已删除
                </Chip>
              ) : null}
              <StatusChip status={t.status} />
              <div className="text-[11px] text-default-500 max-w-[10rem] truncate">
                {props.row.assignee}
              </div>
              {props.row.showSmartScore ? (
                <div
                  className="text-[11px] text-default-500"
                  title={props.row.smartScoreTitle}
                >
                  分: {props.row.smartScoreText}
                </div>
              ) : null}
            </div>
          </div>
        </NavLink>
      </div>
    </div>
  );
});

export default function AdminTickets({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const categoryMap = useMemo(
    () => new Map(loaderData.categories.map((c) => [c.id, c.name])),
    [loaderData.categories],
  );
  const userMap = useMemo(
    () =>
      new Map(
        loaderData.users.map((u) => [u.uid, u.display_name ?? u.username]),
      ),
    [loaderData.users],
  );
  const adminUsers = useMemo(
    () => loaderData.users.filter((u) => u.is_admin),
    [loaderData.users],
  );

  const submit = useSubmit();
  const location = useLocation();
  const params = useParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const pendingIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("_intent") ?? "")
      : "";
  const isRecomputingSmartScores = pendingIntent === "recomputeSmartScores";
  const isBatchReplying = pendingIntent === "batchReply";
  const isBatchClosing = pendingIntent === "batchClose";
  const isBatchDeleting = pendingIntent === "batchDelete";
  const isCreatingTicket = pendingIntent === "createTicket";
  const isMergingTickets = pendingIntent === "mergeTickets";
  const isFiltering =
    navigation.state !== "idle" && navigation.formMethod === "GET";

  const selectedTicketId = params.ticketId;
  const detailScrollRef = useRef<HTMLDivElement | null>(null);

  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<string>>(
    () => new Set(),
  );
  const onToggleSelected = useCallback((ticketId: string, checked: boolean) => {
    setSelectedTicketIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(ticketId);
      else next.delete(ticketId);
      return next;
    });
  }, []);

  const selectableTicketIds = useMemo(
    () => loaderData.tickets.filter((t) => !t.deleted_at).map((t) => t.id),
    [loaderData.tickets],
  );
  const selectedDeletableTicketIds = useMemo(
    () =>
      loaderData.tickets
        .filter((t) => !t.deleted_at && selectedTicketIds.has(t.id))
        .map((t) => t.id),
    [loaderData.tickets, selectedTicketIds],
  );
  const selectedOpenTicketIds = useMemo(
    () =>
      loaderData.tickets
        .filter(
          (t) =>
            !t.deleted_at &&
            t.status !== "closed" &&
            selectedTicketIds.has(t.id),
        )
        .map((t) => t.id),
    [loaderData.tickets, selectedTicketIds],
  );
  const mergeableSourceTicketIds = useMemo(
    () =>
      selectedTicketId
        ? selectedOpenTicketIds.filter((id) => id !== selectedTicketId)
        : [],
    [selectedOpenTicketIds, selectedTicketId],
  );
  const targetTicket = useMemo(
    () =>
      selectedTicketId
        ? loaderData.tickets.find((t) => t.id === selectedTicketId) ?? null
        : null,
    [loaderData.tickets, selectedTicketId],
  );
  const allSelectableSelected = useMemo(
    () =>
      selectableTicketIds.length > 0 &&
      selectableTicketIds.every((id) => selectedTicketIds.has(id)),
    [selectableTicketIds, selectedTicketIds],
  );
  const someSelectableSelected = useMemo(
    () =>
      selectableTicketIds.some((id) => selectedTicketIds.has(id)) &&
      !allSelectableSelected,
    [allSelectableSelected, selectableTicketIds, selectedTicketIds],
  );

  const ticketRows = useMemo<TicketRowView[]>(() => {
    return loaderData.tickets.map((t) => {
      const creatorName =
        userMap.get(t.creator_uid) ?? `uid:${t.creator_uid}`;
      const creator = `${creatorName} (uid:${t.creator_uid})`;
      const category = categoryMap.get(t.category_id) ?? t.category_id;
      const assignee = t.assigned_to_uid
        ? (userMap.get(t.assigned_to_uid) ?? `uid:${t.assigned_to_uid}`)
        : "未分配";
      const isDeleted = Boolean(t.deleted_at);
      const showSmartScore = t.status !== "closed" && !isDeleted;
      const smartScoreText =
        typeof t.smart_urgency_score === "number"
          ? t.smart_urgency_score.toFixed(2)
          : "未计算";

      return {
        ticket: t,
        creator,
        category,
        assignee,
        updatedAtText: formatCompactDateTime(t.updated_at),
        nudgeTitle: t.nudge_last_at
          ? `客户催单：${formatCompactDateTime(t.nudge_last_at)}`
          : null,
        isDeleted,
        showSmartScore,
        smartScoreText,
        smartScoreTitle: t.smart_computed_at
          ? `智能分数计算时间：${formatCompactDateTime(t.smart_computed_at)}`
          : "智能分数尚未计算",
      };
    });
  }, [categoryMap, loaderData.tickets, userMap]);

  const batchReplyModal = useDisclosure();
  const batchCloseModal = useDisclosure();
  const batchDeleteModal = useDisclosure();
  const createTicketModal = useDisclosure();
  const mergeTicketsModal = useDisclosure();

  const [createIsGlobal, setCreateIsGlobal] = useState(false);
  const [createParticipantKeys, setCreateParticipantKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [mergeMoveMessages, setMergeMoveMessages] = useState(true);

  const submitTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (submitTimerRef.current) {
        window.clearTimeout(submitTimerRef.current);
        submitTimerRef.current = null;
      }
    };
  }, []);

  const submitFilters = (form: HTMLFormElement | null) => {
    if (!form) return;
    if (submitTimerRef.current) window.clearTimeout(submitTimerRef.current);
    submitTimerRef.current = window.setTimeout(() => {
      submit(form, { replace: true });
    }, 250);
  };

  useEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedTicketId]);

  useEffect(() => {
    const selectable = new Set(selectableTicketIds);
    setSelectedTicketIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (selectable.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [selectableTicketIds]);

  const selectedStatuses = loaderData.filters.statuses ?? [];
  const selectedAssigned = loaderData.filters.assigned ?? [];
  const qValue = String(loaderData.filters.q ?? "");
  const sortValue = String(loaderData.filters.sort ?? "updated_at");
  const dirValue = String(loaderData.filters.dir ?? "desc");
  const createdTicketId = (actionData as any)?.createdTicketId as
    | string
    | null
    | undefined;

  return (
    <>
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_7fr] gap-2 overflow-hidden">
        <section className="min-h-0 flex flex-col rounded-medium border border-default-200 overflow-hidden">
          <div className="p-2 border-b border-default-200">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">
                工单列表
                <span className="ml-2 text-xs text-default-500">
                  {loaderData.tickets.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  color="primary"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  onPress={createTicketModal.onOpen}
                >
                  新建共同工单
                </Button>
                <Button
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  isLoading={revalidator.state === "loading"}
                  isDisabled={revalidator.state === "loading"}
                  onPress={() => revalidator.revalidate()}
                >
                  刷新
                </Button>
                <Form method="post">
                  <input
                    type="hidden"
                    name="_intent"
                    value="recomputeSmartScores"
                  />
                  <Button
                    type="submit"
                    variant="flat"
                    className="h-8 px-3 text-sm"
                    isLoading={isRecomputingSmartScores}
                    isDisabled={isRecomputingSmartScores}
                  >
                    立刻计算
                  </Button>
                </Form>
              </div>
            </div>

            {actionData?.ok === false ? (
              <div className="mt-2 space-y-1 text-xs">
                <div className="text-danger">{actionData.error}</div>
                {createdTicketId ? (
                  <NavLink
                    className="text-primary underline"
                    to={{ pathname: createdTicketId, search: location.search }}
                  >
                    查看已创建工单
                  </NavLink>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  isSelected={allSelectableSelected}
                  isIndeterminate={someSelectableSelected}
                  isDisabled={selectableTicketIds.length === 0}
                  onValueChange={(checked) => {
                    setSelectedTicketIds((prev) => {
                      const next = new Set(prev);
                      if (checked) {
                        for (const id of selectableTicketIds) next.add(id);
                      } else {
                        for (const id of selectableTicketIds) next.delete(id);
                      }
                      return next;
                    });
                  }}
                >
                  全选
                </Checkbox>
                <div className="text-xs text-default-500">
                  已选择 {selectedDeletableTicketIds.length}
                </div>
                {selectedDeletableTicketIds.length > 0 ? (
                  <Button
                    variant="light"
                    className="h-8 px-2 text-sm"
                    onPress={() => setSelectedTicketIds(new Set())}
                  >
                    清空
                  </Button>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  color="primary"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  isDisabled={selectedOpenTicketIds.length === 0}
                  onPress={batchReplyModal.onOpen}
                >
                  批量回复
                </Button>
                <Button
                  color="secondary"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  isDisabled={
                    !selectedTicketId ||
                    !targetTicket ||
                    Boolean(targetTicket.deleted_at) ||
                    targetTicket.status === "closed" ||
                    mergeableSourceTicketIds.length === 0
                  }
                  onPress={() => {
                    setMergeMoveMessages(true);
                    mergeTicketsModal.onOpen();
                  }}
                >
                  合并到当前
                </Button>
                <Button
                  color="danger"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  isDisabled={selectedOpenTicketIds.length === 0}
                  onPress={batchCloseModal.onOpen}
                >
                  批量关闭
                </Button>
                <Button
                  color="danger"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                  isDisabled={selectedDeletableTicketIds.length === 0}
                  onPress={batchDeleteModal.onOpen}
                >
                  批量删除
                </Button>
              </div>
            </div>

            <Form
              key={location.search}
              method="get"
              replace
              className="mt-2 grid grid-cols-2 gap-2"
            >
            <label className="text-xs text-default-600">
              状态
              <div className="mt-1 flex flex-wrap gap-1">
                {ALL_TICKET_STATUSES.map((s) => (
                  <FilterChipCheckbox
                    key={s}
                    name="status"
                    value={s}
                    label={ticketStatusLabel(s)}
                    defaultChecked={selectedStatuses.includes(s)}
                    onChange={submitFilters}
                  />
                ))}
              </div>
              <div className="mt-1 text-[11px] text-default-500">
                不选择 = 全部
              </div>
            </label>

            <label className="text-xs text-default-600">
              分配
              <div className="mt-1 flex flex-wrap gap-1">
                <FilterChipCheckbox
                  name="assigned"
                  value="unassigned"
                  label="未分配"
                  defaultChecked={selectedAssigned.includes("unassigned")}
                  onChange={submitFilters}
                />
                <FilterChipCheckbox
                  name="assigned"
                  value="me"
                  label="分配给我"
                  defaultChecked={selectedAssigned.includes("me")}
                  onChange={submitFilters}
                />
                {adminUsers.map((u) => {
                  const val = `uid:${u.uid}`;
                  return (
                    <FilterChipCheckbox
                      key={val}
                      name="assigned"
                      value={val}
                      label={u.display_name ?? u.username}
                      defaultChecked={selectedAssigned.includes(val)}
                      onChange={submitFilters}
                    />
                  );
                })}
              </div>
              <div className="mt-1 text-[11px] text-default-500">
                不选择 = 全部
              </div>
            </label>

            <div className="col-span-2 flex gap-2">
              <label className="flex-1">
                <span className="sr-only">搜索</span>
                <input
                  name="q"
                  defaultValue={qValue}
                  placeholder="搜索标题…"
                  className="block w-full h-8 rounded-medium border border-default-200 bg-background px-2 text-sm"
                />
              </label>
            </div>
            <div className="col-span-2 flex gap-2">
              <label className="w-[8.5rem]">
                <span className="sr-only">排序方式</span>
                <select
                  name="sort"
                  defaultValue={sortValue}
                  onChange={(e) => submitFilters(e.currentTarget.form)}
                  className="block w-full h-8 rounded-medium border border-default-200 bg-background px-2 text-sm"
                >
                  <option value="updated_at">按更新时间</option>
                  <option value="created_at">按创建时间</option>
                  <option value="smart">智能排序</option>
                </select>
              </label>
              <label className="w-[6rem]">
                <span className="sr-only">排序方向</span>
                <select
                  name="dir"
                  defaultValue={dirValue}
                  onChange={(e) => submitFilters(e.currentTarget.form)}
                  className="block w-full h-8 rounded-medium border border-default-200 bg-background px-2 text-sm"
                >
                  <option value="desc">倒序</option>
                  <option value="asc">正序</option>
                </select>
              </label>

              <Button
                type="submit"
                variant="flat"
                className="h-8 px-3 text-sm"
                isLoading={isFiltering}
                isDisabled={isFiltering}
              >
                筛选
              </Button>
              <Button
                as={NavLink}
                to={{ pathname: location.pathname }}
                variant="light"
                className="h-8 px-3 text-sm"
              >
                清除
              </Button>
            </div>
          </Form>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {loaderData.tickets.length === 0 ? (
            <div className="p-3 text-sm text-default-500">暂无工单。</div>
          ) : (
            <div>
              {ticketRows.map((row) => {
                const t = row.ticket;
                const isActive = selectedTicketId === t.id;
                const isSelected = selectedTicketIds.has(t.id);
                return (
                  <TicketListRow
                    key={t.id}
                    row={row}
                    search={location.search}
                    isActive={isActive}
                    isSelected={isSelected}
                    onToggleSelected={onToggleSelected}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>

        <section className="min-h-0 rounded-medium border border-default-200 overflow-hidden flex flex-col">
          <div ref={detailScrollRef} className="flex-1 min-h-0 overflow-auto">
            {selectedTicketId ? (
              <Outlet
                context={{
                  categories: loaderData.categories,
                  users: loaderData.users,
                }}
              />
            ) : (
              <div className="h-full flex items-center justify-center p-6 text-sm text-default-500">
                从左侧选择一个工单以查看详情与回复。
              </div>
            )}
          </div>
        </section>
      </div>

      <Modal isOpen={batchReplyModal.isOpen} onClose={batchReplyModal.onClose}>
        <ModalContent>
          <Form method="post" onSubmit={batchReplyModal.onClose}>
            <input type="hidden" name="_intent" value="batchReply" />
            {selectedOpenTicketIds.map((id) => (
              <input key={id} type="hidden" name="ticketIds" value={id} />
            ))}
            <ModalHeader>批量回复</ModalHeader>
            <ModalBody>
              <div className="text-sm text-default-600">
                将向 {selectedOpenTicketIds.length} 个工单发送同一条回复。
              </div>

              <Select
                name="actor"
                label="回复身份"
                defaultSelectedKeys={["staff"]}
                isDisabled={isBatchReplying}
              >
                <SelectItem key="staff">操作员</SelectItem>
                <SelectItem key="anonymous">匿名</SelectItem>
                <SelectItem key="system">系统</SelectItem>
              </Select>
              <Textarea
                name="bodyMarkdown"
                label="回复内容（Markdown）"
                minRows={6}
                isRequired
                isDisabled={isBatchReplying}
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={batchReplyModal.onClose}
                isDisabled={isBatchReplying}
              >
                取消
              </Button>
              <Button
                color="primary"
                type="submit"
                isLoading={isBatchReplying}
                isDisabled={isBatchReplying}
              >
                确认发送
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal isOpen={batchCloseModal.isOpen} onClose={batchCloseModal.onClose}>
        <ModalContent>
          <Form method="post" onSubmit={batchCloseModal.onClose}>
            <input type="hidden" name="_intent" value="batchClose" />
            {selectedOpenTicketIds.map((id) => (
              <input key={id} type="hidden" name="ticketIds" value={id} />
            ))}
            <ModalHeader>批量关闭工单</ModalHeader>
            <ModalBody>
              <div className="text-sm text-default-600">
                将关闭 {selectedOpenTicketIds.length} 个工单。
              </div>
              <Input
                name="reason"
                label="关闭原因（可选）"
                placeholder="例如：已完成 / 其它（可自填写）"
                isDisabled={isBatchClosing}
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={batchCloseModal.onClose}
                isDisabled={isBatchClosing}
              >
                取消
              </Button>
              <Button
                color="danger"
                type="submit"
                isLoading={isBatchClosing}
                isDisabled={isBatchClosing}
              >
                确认关闭
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal
        isOpen={batchDeleteModal.isOpen}
        onClose={batchDeleteModal.onClose}
      >
        <ModalContent>
          <Form method="post" onSubmit={batchDeleteModal.onClose}>
            <input type="hidden" name="_intent" value="batchDelete" />
            {selectedDeletableTicketIds.map((id) => (
              <input key={id} type="hidden" name="ticketIds" value={id} />
            ))}
            <ModalHeader>批量删除工单</ModalHeader>
            <ModalBody>
              <div className="text-sm text-default-600">
                将删除 {selectedDeletableTicketIds.length} 个工单（软删除，客户侧不可见，管理员仍可查看）。
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={batchDeleteModal.onClose}
                isDisabled={isBatchDeleting}
              >
                取消
              </Button>
              <Button
                color="danger"
                type="submit"
                isLoading={isBatchDeleting}
                isDisabled={isBatchDeleting}
              >
                确认删除
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal isOpen={createTicketModal.isOpen} onClose={createTicketModal.onClose}>
        <ModalContent>
          <Form
            method="post"
            onSubmit={createTicketModal.onClose}
            encType="multipart/form-data"
            className="space-y-2"
          >
            <input type="hidden" name="_intent" value="createTicket" />
            <input
              type="hidden"
              name="isGlobal"
              value={createIsGlobal ? "1" : "0"}
            />
            <ModalHeader>新建共同工单</ModalHeader>
            <ModalBody className="space-y-3">
              <Select
                name="categoryId"
                label="工单类别"
                isRequired
                placeholder="选择类别"
                isDisabled={isCreatingTicket}
              >
                {loaderData.categories.map((c) => (
                  <SelectItem key={c.id}>{c.name}</SelectItem>
                ))}
              </Select>

              <Input name="subject" label="标题" isRequired isDisabled={isCreatingTicket} />

              <Textarea
                name="bodyMarkdown"
                label="工单内容（Markdown）"
                minRows={6}
                isRequired
                isDisabled={isCreatingTicket}
              />

              <Checkbox
                isSelected={createIsGlobal}
                isDisabled={isCreatingTicket}
                onValueChange={(checked) => {
                  setCreateIsGlobal(checked);
                  if (checked) setCreateParticipantKeys(new Set());
                }}
              >
                所有用户（全体共同工单）
              </Checkbox>

              <Select
                name="participantUids"
                label="涉及用户"
                selectionMode="multiple"
                placeholder={createIsGlobal ? "已选择所有用户" : "选择一个或多个用户"}
                isDisabled={createIsGlobal || isCreatingTicket}
                selectedKeys={createParticipantKeys}
                onSelectionChange={(keys: any) => {
                  if (keys === "all") return;
                  setCreateParticipantKeys(
                    new Set(Array.from(keys).map((k) => String(k))),
                  );
                }}
              >
                {loaderData.users
                  .filter((u) => !u.is_admin)
                  .map((u) => (
                    <SelectItem key={String(u.uid)}>
                      {u.display_name ?? u.username} (uid:{u.uid})
                    </SelectItem>
                  ))}
              </Select>

              <div className="space-y-1">
                <div className="text-sm font-medium">附件（可选）</div>
                <input
                  type="file"
                  name="attachments"
                  multiple
                  className="block w-full text-sm"
                  disabled={isCreatingTicket}
                />
                <div className="text-xs text-default-500">单文件不超过 2MB。</div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={createTicketModal.onClose}
                isDisabled={isCreatingTicket}
              >
                取消
              </Button>
              <Button
                color="primary"
                type="submit"
                isLoading={isCreatingTicket}
                isDisabled={
                  isCreatingTicket ||
                  (!createIsGlobal && createParticipantKeys.size === 0)
                }
              >
                创建
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>

      <Modal isOpen={mergeTicketsModal.isOpen} onClose={mergeTicketsModal.onClose}>
        <ModalContent>
          <Form method="post" onSubmit={mergeTicketsModal.onClose}>
            <input type="hidden" name="_intent" value="mergeTickets" />
            <input
              type="hidden"
              name="targetTicketId"
              value={selectedTicketId ?? ""}
            />
            <input
              type="hidden"
              name="mergeMessages"
              value={mergeMoveMessages ? "1" : "0"}
            />
            {mergeableSourceTicketIds.map((id) => (
              <input key={id} type="hidden" name="sourceTicketIds" value={id} />
            ))}
            <ModalHeader>合并工单</ModalHeader>
            <ModalBody className="space-y-2">
              <div className="text-sm text-default-600">
                {targetTicket ? (
                  <>
                    目标工单：<span className="font-mono">#{targetTicket.short_id}</span>{" "}
                    {targetTicket.subject}
                  </>
                ) : (
                  "请先打开一个工单作为目标。"
                )}
              </div>
              <div className="text-sm text-default-600">
                将合并 {mergeableSourceTicketIds.length} 个工单到目标工单。
              </div>
              <Checkbox
                isSelected={mergeMoveMessages}
                onValueChange={setMergeMoveMessages}
                isDisabled={isMergingTickets}
              >
                合并消息与附件（迁移到目标工单）
              </Checkbox>
              <Textarea
                name="reason"
                label="合并原因（可选）"
                placeholder="例如：重复工单 / 同一问题集中处理"
                minRows={3}
                isDisabled={isMergingTickets}
              />
            </ModalBody>
            <ModalFooter>
              <Button
                variant="light"
                onPress={mergeTicketsModal.onClose}
                isDisabled={isMergingTickets}
              >
                取消
              </Button>
              <Button
                color="secondary"
                type="submit"
                isLoading={isMergingTickets}
                isDisabled={
                  isMergingTickets ||
                  !targetTicket ||
                  mergeableSourceTicketIds.length === 0
                }
              >
                确认合并
              </Button>
            </ModalFooter>
          </Form>
        </ModalContent>
      </Modal>
    </>
  );
}
