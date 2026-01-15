import type { Route } from "./+types/admin.tickets";
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  Link as UiLink,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { Link, data } from "react-router";
import { requireAdmin } from "../server/admin";
import {
  listAllCategories,
  listAllTickets,
  listAllUsers,
} from "../server/models/admin.server";
import { ticketStatusLabel } from "../shared/tickets";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const [tickets, categories, users] = await Promise.all([
    listAllTickets(),
    listAllCategories(),
    listAllUsers(),
  ]);
  return data({ tickets, categories, users });
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

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">全部工单</h1>
        <p className="text-default-600">查看与处理全部工单。</p>
      </div>

      <Card>
        <CardHeader className="font-medium">工单列表</CardHeader>
        <CardBody>
          <Table aria-label="admin tickets">
            <TableHeader>
              <TableColumn>标题</TableColumn>
              <TableColumn>客户</TableColumn>
              <TableColumn>类别</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>分配给</TableColumn>
              <TableColumn>更新时间</TableColumn>
            </TableHeader>
            <TableBody emptyContent="暂无工单。">
              {loaderData.tickets.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <UiLink as={Link} to={`/admin/tickets/${t.id}`} color="primary">
                      {t.subject}
                    </UiLink>
                  </TableCell>
                  <TableCell>
                    {userMap.get(t.creator_uid) ?? `uid:${t.creator_uid}`}
                  </TableCell>
                  <TableCell>
                    {categoryMap.get(t.category_id) ?? t.category_id}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={t.status} />
                  </TableCell>
                  <TableCell>
                    {t.assigned_to_uid
                      ? userMap.get(t.assigned_to_uid) ?? `uid:${t.assigned_to_uid}`
                      : "-"}
                  </TableCell>
                  <TableCell>
                    {new Date(t.updated_at).toLocaleString("zh-CN")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardBody>
      </Card>
    </div>
  );
}
