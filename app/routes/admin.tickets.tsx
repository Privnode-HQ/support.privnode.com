import type { Route } from "./+types/admin.tickets";
import { Chip, Button } from "@heroui/react";
import { useEffect, useRef } from "react";
import {
  Form,
  NavLink,
  Outlet,
  data,
  redirect,
  useLocation,
  useParams,
  useRevalidator,
  useSubmit,
} from "react-router";
import { requireAdmin } from "../server/admin";
import { recomputeTicketSmartScores } from "../server/models/smart-sort.server";
import {
  type AdminTicketSort,
  type AdminTicketSortDirection,
  listAllCategories,
  listAllTickets,
  listAllUsers,
} from "../server/models/admin.server";
import { type TicketStatus, ticketStatusLabel } from "../shared/tickets";

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
    listAllCategories(),
    listAllUsers(),
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
  await requireAdmin(request);
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

export default function AdminTickets({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const categoryMap = new Map(loaderData.categories.map((c) => [c.id, c.name]));
  const userMap = new Map(
    loaderData.users.map((u) => [u.uid, u.display_name ?? u.username]),
  );
  const adminUsers = loaderData.users.filter((u) => u.is_admin);

  const submit = useSubmit();
  const location = useLocation();
  const params = useParams();
  const revalidator = useRevalidator();

  const selectedTicketId = params.ticketId;
  const detailScrollRef = useRef<HTMLDivElement | null>(null);

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

  const selectedStatuses = loaderData.filters.statuses ?? [];
  const selectedAssigned = loaderData.filters.assigned ?? [];
  const qValue = String(loaderData.filters.q ?? "");
  const sortValue = String(loaderData.filters.sort ?? "updated_at");
  const dirValue = String(loaderData.filters.dir ?? "desc");

  return (
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
                variant="flat"
                className="h-8 px-3 text-sm"
                isLoading={revalidator.state === "loading"}
                onPress={() => revalidator.revalidate()}
              >
                刷新
              </Button>
              <Form method="post">
                <input type="hidden" name="_intent" value="recomputeSmartScores" />
                <Button
                  type="submit"
                  variant="flat"
                  className="h-8 px-3 text-sm"
                >
                  立刻计算
                </Button>
              </Form>
            </div>
          </div>

          {actionData?.ok === false ? (
            <div className="mt-2 text-xs text-danger">{actionData.error}</div>
          ) : null}

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

              <Button type="submit" variant="flat" className="h-8 px-3 text-sm">
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
                const category =
                  categoryMap.get(t.category_id) ?? t.category_id;
                const assignee = t.assigned_to_uid
                  ? (userMap.get(t.assigned_to_uid) ??
                    `uid:${t.assigned_to_uid}`)
                  : "未分配";
                const showSmartScore = t.status !== "closed";
                const smartScoreText =
                  typeof t.smart_urgency_score === "number"
                    ? t.smart_urgency_score.toFixed(2)
                    : "未计算";

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
                    aria-current={
                      selectedTicketId === t.id ? "page" : undefined
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-default-500">
                            #{t.short_id}
                          </span>
                          {t.nudge_pending ? (
                            <span
                              title={
                                t.nudge_last_at
                                  ? `客户催单：${formatCompactDateTime(t.nudge_last_at)}`
                                  : "客户催单"
                              }
                              className="text-warning text-xs"
                            >
                              ★
                            </span>
                          ) : null}
                          <div className="text-sm font-medium truncate">
                            {t.subject}
                          </div>
                        </div>
                        <div className="mt-0.5 text-xs text-default-500 truncate">
                          {creator} · {category} ·{" "}
                          {formatCompactDateTime(t.updated_at)}
                        </div>
                      </div>
                      <div className="shrink-0 flex flex-col items-end gap-1">
                        <StatusChip status={t.status} />
                        <div className="text-[11px] text-default-500 max-w-[10rem] truncate">
                          {assignee}
                        </div>
                        {showSmartScore ? (
                          <div
                            className="text-[11px] text-default-500"
                            title={
                              t.smart_computed_at
                                ? `智能分数计算时间：${formatCompactDateTime(t.smart_computed_at)}`
                                : "智能分数尚未计算"
                            }
                          >
                            分: {smartScoreText}
                          </div>
                        ) : null}
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
