import type { Route } from "./+types/admin.categories";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Input,
  Textarea,
} from "@heroui/react";
import { Form, data, redirect } from "react-router";
import { requireAdmin } from "../server/admin";
import {
  createCategory,
  listAllCategories,
  updateCategory,
} from "../server/models/admin.server";

function parseJsonOrError(text: string) {
  try {
    return { ok: true as const, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false as const, error: "form_schema 不是合法 JSON。" };
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const categories = await listAllCategories();
  return data({ categories });
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  const name = String(form.get("name") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const sortOrder = Number(form.get("sortOrder") ?? 0);
  const enabled = String(form.get("enabled") ?? "") === "on";
  const formSchemaText = String(form.get("formSchema") ?? "[]").trim() || "[]";
  const parsed = parseJsonOrError(formSchemaText);
  if (!parsed.ok) return data({ ok: false as const, error: parsed.error }, { status: 400 });

  if (!name) {
    return data(
      { ok: false as const, error: "分类名称不能为空。" },
      { status: 400 }
    );
  }
  if (!Number.isFinite(sortOrder)) {
    return data(
      { ok: false as const, error: "sortOrder 必须是数字。" },
      { status: 400 }
    );
  }

  if (intent === "create") {
    await createCategory({
      name,
      description,
      sortOrder,
      enabled,
      formSchema: parsed.value,
    });
    return redirect("/admin/categories");
  }

  if (intent === "update") {
    const id = String(form.get("id") ?? "");
    if (!id) {
      return data(
        { ok: false as const, error: "缺少分类 id。" },
        { status: 400 }
      );
    }
    await updateCategory({
      id,
      name,
      description,
      sortOrder,
      enabled,
      formSchema: parsed.value,
    });
    return redirect("/admin/categories");
  }

  return data(
    { ok: false as const, error: "未知操作。" },
    { status: 400 }
  );
}

export default function AdminCategories({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">分类与表单</h1>
        <p className="text-default-600">管理工单分类，以及每个分类的表单 schema。</p>
      </div>

      {actionData?.ok === false ? (
        <p className="text-danger">{actionData.error}</p>
      ) : null}

      <Card>
        <CardHeader className="font-medium">新增分类</CardHeader>
        <CardBody>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="_intent" value="create" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input name="name" label="名称" isRequired />
              <Input
                name="sortOrder"
                label="排序"
                defaultValue="0"
                inputMode="numeric"
              />
            </div>
            <Input name="description" label="描述（可选）" />
            <Checkbox name="enabled" defaultSelected>
              启用
            </Checkbox>
            <Textarea
              name="formSchema"
              label="form_schema（JSON）"
              defaultValue="[]"
              minRows={6}
              description='示例：[{"key":"order_id","label":"订单号","type":"text","required":false}]'
            />
            <Button color="primary" type="submit">
              创建
            </Button>
          </Form>
        </CardBody>
      </Card>

      <div className="space-y-3">
        {loaderData.categories.map((c) => (
          <Card key={c.id}>
            <CardHeader className="font-medium">编辑：{c.name}</CardHeader>
            <CardBody>
              <Form method="post" className="space-y-4">
                <input type="hidden" name="_intent" value="update" />
                <input type="hidden" name="id" value={c.id} />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input name="name" label="名称" defaultValue={c.name} isRequired />
                  <Input
                    name="sortOrder"
                    label="排序"
                    defaultValue={String(c.sort_order)}
                    inputMode="numeric"
                  />
                </div>
                <Input
                  name="description"
                  label="描述（可选）"
                  defaultValue={c.description ?? ""}
                />
                <Checkbox name="enabled" defaultSelected={c.enabled}>
                  启用
                </Checkbox>
                <Textarea
                  name="formSchema"
                  label="form_schema（JSON）"
                  defaultValue={JSON.stringify(c.form_schema ?? [], null, 2)}
                  minRows={8}
                />
                <Button color="primary" type="submit">
                  保存
                </Button>
              </Form>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

