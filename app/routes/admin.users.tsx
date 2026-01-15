import type { Route } from "./+types/admin.users";
import {
  Card,
  CardBody,
  CardHeader,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { data } from "react-router";
import { requireAdmin } from "../server/admin";
import { listAllUsers } from "../server/models/admin.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const users = await listAllUsers();
  return data({ users });
}

export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">用户</h1>
        <p className="text-default-600">所有工单系统用户（仅管理员可见）。</p>
      </div>

      <Card>
        <CardHeader className="font-medium">用户列表</CardHeader>
        <CardBody>
          <Table aria-label="users">
            <TableHeader>
              <TableColumn>uid</TableColumn>
              <TableColumn>username</TableColumn>
              <TableColumn>显示名称</TableColumn>
              <TableColumn>权限</TableColumn>
              <TableColumn>最近登录</TableColumn>
            </TableHeader>
            <TableBody emptyContent="暂无用户。">
              {loaderData.users.map((u) => (
                <TableRow key={u.uid}>
                  <TableCell>{u.uid}</TableCell>
                  <TableCell>{u.username}</TableCell>
                  <TableCell>{u.display_name ?? "-"}</TableCell>
                  <TableCell>
                    {u.is_admin ? (
                      <Chip color="primary" variant="flat" size="sm">
                        管理员
                      </Chip>
                    ) : (
                      <Chip variant="flat" size="sm">
                        普通用户
                      </Chip>
                    )}
                  </TableCell>
                  <TableCell>
                    {u.last_login_at
                      ? new Date(u.last_login_at).toLocaleString("zh-CN")
                      : "-"}
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

