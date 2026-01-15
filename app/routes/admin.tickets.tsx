import type { Route } from "./+types/admin.tickets";
import {
  Chip,
  Button,
} from "@heroui/react";
import { useEffect, useRef } from "react";
import {
  Form,
  NavLink,
  Outlet,
  data,
  useLocation,
  useParams,
  useRevalidator,
  useSubmit,
} from "react-router";
import { requireAdmin } from "../server/admin";
import {
  listAllCategories,
  listAllTickets,
  listAllUsers,
} from "../server/models/admin.server";
import {
  type TicketStatus,
  ticketStatusLabel,
} from "../shared/tickets";

const ALL_TICKET_STATUSES: TicketStatus[] = [
  "pending_assign",
  "assigned",
  "replied_by_staff",
  "replied_by_customer",
  "closed",
];

function asTicketStatus(value: string | null): TicketStatus | null {
  if (!value) return null;
  if (ALL_TICKET_STATUSES.includes(value as TicketStatus)) return value as any;
  return null;
}

function formatCompactDateTime(ts: string) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  const url = new URL(request.url);

  const statusParam = url.searchParams.get("status");
  const assignedParam = url.searchParams.get("assigned");
  const q = String(url.searchParams.get("q") ?? "").trim();

  const status = asTicketStatus(statusParam);

  const normalizedAssigned =
    assignedParam === "unassigned" ||
    assignedParam === "me" ||
    assignedParam?.startsWith("uid:")
      ? assignedParam
      : "all";

  const assignedToUid =
    normalizedAssigned === "me"
      ? admin.uid
      : normalizedAssigned?.startsWith("uid:")
        ? Number(normalizedAssigned.slice("uid:".length))
        : null;
  const unassigned = normalizedAssigned === "unassigned";

  const [tickets, categories, users] = await Promise.all([
    listAllTickets({
      status: status ?? undefined,
      unassigned,
      assignedToUid: Number.isFinite(assignedToUid as any)
        ? (assignedToUid as number)
        : undefined,
      query: q || undefined,
    }),
    listAllCategories(),
    listAllUsers(),
  ]);

  return data({
    admin: { uid: admin.uid },
    tickets,
    categories,
    users,
    filters: {
      status: status ?? "all",
      assigned: normalizedAssigned ?? "all",
      q,
    },
  });
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

export default function AdminTickets({ loaderData }: Route.ComponentProps) {
  const categoryMap = new Map(loaderData.categories.map((c) => [c.id, c.name]));
  const userMap = new Map(
    loaderData.users.map((u) => [u.uid, u.display_name ?? u.username])
  );
  const adminUsers = loaderData.users.filter((u) => u.is_admin);

  const submit = useSubmit();
  const location = useLocation();
  const params = useParams();
  const revalidator = useRevalidator();

  const selectedTicketId = params.ticketId;
  const detailScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 });
  }, [selectedTicketId]);

  const statusValue = String(loaderData.filters.status ?? "all");
  const assignedValue = String(loaderData.filters.assigned ?? "all");
  const qValue = String(loaderData.filters.q ?? "");

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_7fr] gap-2">
      <section className="min-h-0 flex flex-col rounded-medium border border-default-200">
        <div className="p-2 border-b border-default-200">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">
              工单列表
              <span className="ml-2 text-xs text-default-500">
                {loaderData.tickets.length}
              </span>
            </div>
            <Button
              variant="flat"
              className="h-8 px-3 text-sm"
              isLoading={revalidator.state === "loading"}
              onPress={() => revalidator.revalidate()}
            >
              刷新
            </Button>
          </div>

          <Form method="get" replace className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-default-600">
              状态
              <select
                name="status"
                defaultValue={statusValue}
                onChange={(e) => {
                  const form = e.currentTarget.form;
                  if (form) submit(form, { replace: true });
                }}
                className="mt-1 block w-full h-8 rounded-medium border border-default-200 bg-background px-2 text-sm"
              >
                <option value="all">全部</option>
                {ALL_TICKET_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ticketStatusLabel(s)}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-default-600">
              分配
              <select
                name="assigned"
                defaultValue={assignedValue}
                onChange={(e) => {
                  const form = e.currentTarget.form;
                  if (form) submit(form, { replace: true });
                }}
                className="mt-1 block w-full h-8 rounded-medium border border-default-200 bg-background px-2 text-sm"
              >
                <option value="all">全部</option>
                <option value="unassigned">未分配</option>
                <option value="me">分配给我</option>
                {adminUsers.map((u) => (
                  <option key={u.uid} value={`uid:${u.uid}`}>
                    {u.display_name ?? u.username}
                  </option>
                ))}
              </select>
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
              <Button
                type="submit"
                variant="flat"
                className="h-8 px-3 text-sm"
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
              {loaderData.tickets.map((t) => {
                const creatorName =
                  userMap.get(t.creator_uid) ?? `uid:${t.creator_uid}`;
                const creator = `${creatorName} (uid:${t.creator_uid})`;
                const category = categoryMap.get(t.category_id) ?? t.category_id;
                const assignee = t.assigned_to_uid
                  ? userMap.get(t.assigned_to_uid) ?? `uid:${t.assigned_to_uid}`
                  : "未分配";

                return (
                  <NavLink
                    key={t.id}
                    to={{ pathname: t.id, search: location.search }}
                    className={({ isActive }) =>
                      [
                        "block border-b border-default-200 px-2 py-2 hover:bg-default-100",
                        isActive ? "bg-default-100" : "",
                      ].join(" ")
                    }
                    aria-current={selectedTicketId === t.id ? "page" : undefined}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {t.subject}
                        </div>
                        <div className="mt-0.5 text-xs text-default-500 truncate">
                          {creator} · {category} · {formatCompactDateTime(t.updated_at)}
                        </div>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <StatusChip status={t.status} />
                        <div className="text-[11px] text-default-500 max-w-[10rem] truncate">
                          {assignee}
                        </div>
                      </div>
                    </div>
                  </NavLink>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="min-h-0 rounded-medium border border-default-200 overflow-hidden flex flex-col">
        <div ref={detailScrollRef} className="flex-1 min-h-0 overflow-auto">
          {selectedTicketId ? (
            <Outlet />
          ) : (
            <div className="h-full flex items-center justify-center p-6 text-sm text-default-500">
              从左侧选择一个工单以查看详情与回复。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
