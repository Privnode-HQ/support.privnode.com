import type { Route } from "./+types/admin";
import { Button, Card, CardBody, CardHeader, Input } from "@heroui/react";
import { Form, Link, data, redirect } from "react-router";
import { requireAdmin } from "../server/admin";
import { getSupabaseAdminDb } from "../server/supabase.server";
import { updateMyDisplayName } from "../server/models/admin.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAdmin(request);
  const supabase = getSupabaseAdminDb();
  const { data: me, error } = await supabase
    .from("users")
    .select("display_name,username")
    .eq("uid", user.uid)
    .maybeSingle();
  if (error) throw new Error(`读取个人信息失败：${error.message}`);

  return data({
    me: {
      uid: user.uid,
      username: user.username,
      display_name: (me as any)?.display_name ?? null,
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "updateDisplayName") {
    const displayName = String(form.get("displayName") ?? "").trim();
    if (!displayName) {
      return data(
        { ok: false as const, error: "显示名称不能为空。" },
        { status: 400 }
      );
    }
    await updateMyDisplayName({ uid: user.uid, displayName });
    return redirect("/admin");
  }

  return data(
    { ok: false as const, error: "未知操作。" },
    { status: 400 }
  );
}

export default function AdminDashboard({ loaderData, actionData }: Route.ComponentProps) {
  const { me } = loaderData;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">管理后台</h1>
        <p className="text-default-600">管理员功能（全量工单/用户/分类与表单）。</p>
      </div>

      {actionData?.ok === false ? (
        <p className="text-danger">{actionData.error}</p>
      ) : null}

      <Card>
        <CardHeader className="font-medium">我的管理员信息</CardHeader>
        <CardBody className="space-y-4">
          <div className="text-sm text-default-600">
            uid: {me.uid} · username: {me.username}
          </div>
          <Form method="post" className="flex gap-3 items-end">
            <input type="hidden" name="_intent" value="updateDisplayName" />
            <Input
              name="displayName"
              label="显示名称"
              defaultValue={me.display_name ?? me.username}
              className="max-w-sm"
              isRequired
            />
            <Button color="primary" type="submit">
              保存
            </Button>
          </Form>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="font-medium">工单</CardHeader>
          <CardBody className="space-y-2">
            <p className="text-sm text-default-600">查看/回复全部工单，分配与关闭。</p>
            <Button as={Link} to="/admin/tickets" color="primary" variant="flat">
              进入
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader className="font-medium">用户</CardHeader>
          <CardBody className="space-y-2">
            <p className="text-sm text-default-600">查看所有工单系统用户。</p>
            <Button as={Link} to="/admin/users" color="primary" variant="flat">
              进入
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader className="font-medium">分类与表单</CardHeader>
          <CardBody className="space-y-2">
            <p className="text-sm text-default-600">自定义分类及其表单 schema。</p>
            <Button
              as={Link}
              to="/admin/categories"
              color="primary"
              variant="flat"
            >
              进入
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
