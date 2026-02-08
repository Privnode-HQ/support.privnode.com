import type { Route } from "./+types/tickets";
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
import { ticketStatusLabel } from "../shared/tickets";

export async function loader({ request }: Route.LoaderArgs) {
  const { requireUser } = await import("../server/auth");
  const { listTicketsForUser } = await import("../server/models/tickets.server");

  const user = await requireUser(request);
  const tickets = await listTicketsForUser(user.uid);
  return data({ me: { uid: user.uid }, tickets });
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

export default function Tickets({ loaderData }: Route.ComponentProps) {
  const { me, tickets } = loaderData;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">我的工单</h1>
        <p className="text-default-600">
          这里展示与你相关的全部工单（你发起 / 被加入 / 全体工单）。
        </p>
      </div>

      <Card>
        <CardHeader className="font-medium">工单列表</CardHeader>
        <CardBody>
          <Table aria-label="tickets">
            <TableHeader>
              <TableColumn>工单ID</TableColumn>
              <TableColumn>标题</TableColumn>
              <TableColumn>范围</TableColumn>
              <TableColumn>类别</TableColumn>
              <TableColumn>状态</TableColumn>
              <TableColumn>更新时间</TableColumn>
            </TableHeader>
            <TableBody emptyContent="暂无工单。">
              {tickets.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <span className="font-mono text-sm text-default-600">
                      #{t.short_id}
                    </span>
                  </TableCell>
                  <TableCell>
                    <UiLink as={Link} to={`/tickets/${t.id}`} color="primary">
                      {t.subject}
                    </UiLink>
                  </TableCell>
                  <TableCell>
                    {t.is_global ? (
                      <Chip size="sm" variant="flat" color="secondary">
                        全体
                      </Chip>
                    ) : t.creator_uid !== me.uid ? (
                      <Chip size="sm" variant="flat">
                        共同
                      </Chip>
                    ) : (
                      <span className="text-default-500 text-sm">-</span>
                    )}
                  </TableCell>
                  <TableCell>{t.category_name ?? "-"}</TableCell>
                  <TableCell>
                    <StatusChip status={t.status} />
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
