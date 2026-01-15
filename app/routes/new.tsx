import type { Route } from "./+types/new";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Textarea,
} from "@heroui/react";
import { Form, Link, data, redirect } from "react-router";

type TicketCategory = {
  id: string;
  name: string;
  description: string | null;
  form_schema: unknown;
};

type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea";
  required?: boolean;
  placeholder?: string;
};

function parseFormSchema(schema: unknown): FormField[] {
  if (!Array.isArray(schema)) return [];
  const fields: FormField[] = [];
  for (const item of schema) {
    const key = (item as any)?.key;
    const label = (item as any)?.label;
    const type = (item as any)?.type;
    if (typeof key !== "string" || typeof label !== "string") continue;
    if (type !== "text" && type !== "textarea") continue;
    fields.push({
      key,
      label,
      type,
      required: Boolean((item as any)?.required),
      placeholder:
        typeof (item as any)?.placeholder === "string"
          ? (item as any).placeholder
          : undefined,
    });
  }
  return fields;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { requireUser } = await import("../server/auth");
  const { getCategoryById, listEnabledCategories } = await import(
    "../server/models/categories.server"
  );

  await requireUser(request);
  const url = new URL(request.url);
  const categoryId = url.searchParams.get("category");

  const categories = await listEnabledCategories();
  const selectedCategory = categoryId ? await getCategoryById(categoryId) : null;

  return data({
    categories,
    selectedCategory,
    selectedFields: selectedCategory
      ? parseFormSchema(selectedCategory.form_schema)
      : [],
  });
}

export async function action({ request }: Route.ActionArgs) {
  const { requireUser } = await import("../server/auth");
  const { createTicket } = await import("../server/models/tickets.server");
  const { uploadAttachments } = await import(
    "../server/models/attachments.server"
  );

  const user = await requireUser(request);
  const form = await request.formData();

  const categoryId = String(form.get("categoryId") ?? "");
  const subject = String(form.get("subject") ?? "").trim();
  const bodyMarkdown = String(form.get("bodyMarkdown") ?? "").trim();

  if (!categoryId) {
    return data(
      { ok: false as const, error: "请先选择工单类别。" },
      { status: 400 }
    );
  }
  if (!subject) {
    return data(
      { ok: false as const, error: "请填写标题。" },
      { status: 400 }
    );
  }
  if (!bodyMarkdown) {
    return data(
      { ok: false as const, error: "请填写工单内容（支持 Markdown）。" },
      { status: 400 }
    );
  }

  const files = form
    .getAll("attachments")
    .filter((v): v is File => v instanceof File && v.size > 0);

  // Collect dynamic form data: everything except known fields.
  const formData: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (k === "categoryId" || k === "subject" || k === "bodyMarkdown") continue;
    if (typeof v !== "string") continue;
    formData[k] = v;
  }

  let created: { id: string; messageId: string } | null = null;
  try {
    created = await createTicket({
      creatorUid: user.uid,
      creatorDisplayName: user.username,
      categoryId,
      subject,
      formData,
      bodyMarkdown,
    });

    await uploadAttachments({
      ticketId: created.id,
      messageId: created.messageId,
      uploaderUid: user.uid,
      files,
    });
  } catch (e: any) {
    return data(
      {
        ok: false as const,
        error: e instanceof Error ? e.message : "创建工单失败。",
        createdTicketId: created?.id ?? null,
      },
      { status: 400 }
    );
  }

  return redirect(`/tickets/${created.id}`);
}

export default function NewTicket({ loaderData, actionData }: Route.ComponentProps) {
  const { categories, selectedCategory, selectedFields } = loaderData;
  const createdTicketId = (actionData as any)?.createdTicketId as string | null | undefined;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">发起工单</h1>
        <p className="text-default-600">
          流程：1) 选择类别 2) 填写表单（可选）3) 发起工单
        </p>
      </div>

      {!selectedCategory ? (
        <Card>
          <CardHeader className="font-medium">1) 选择类别</CardHeader>
          <CardBody className="space-y-3">
            {categories.length === 0 ? (
              <p className="text-default-600">暂无可用分类（请联系管理员）。</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {categories.map((c: TicketCategory) => (
                  <Card key={c.id} shadow="sm" className="border border-default-200">
                    <CardBody className="space-y-2">
                      <div className="font-medium">{c.name}</div>
                      {c.description ? (
                        <div className="text-sm text-default-600">{c.description}</div>
                      ) : null}
                      <div>
                        <Button
                          as={Link}
                          color="primary"
                          size="sm"
                          to={`/new?category=${encodeURIComponent(c.id)}`}
                        >
                          选择
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader className="font-medium">2) 填写信息并提交</CardHeader>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="text-default-600">
                当前类别：<span className="text-foreground">{selectedCategory.name}</span>
              </div>
              <Button as={Link} to="/new" variant="flat" size="sm">
                重新选择类别
              </Button>
            </div>

            {actionData?.ok === false ? (
              <div className="space-y-2">
                <p className="text-danger">{actionData.error}</p>
                {createdTicketId ? (
                  <p className="text-sm text-default-600">
                    工单可能已创建：
                    <Link
                      className="text-primary underline"
                      to={`/tickets/${createdTicketId}`}
                    >
                      点击查看
                    </Link>
                  </p>
                ) : null}
              </div>
            ) : null}

            <Form
              method="post"
              className="space-y-4"
              encType="multipart/form-data"
            >
              <input type="hidden" name="categoryId" value={selectedCategory.id} />

              <Input
                name="subject"
                label="标题"
                placeholder="请简要概述问题"
                isRequired
              />

              {selectedFields.length > 0 ? (
                <Card shadow="none" className="border border-default-200">
                  <CardHeader className="text-sm font-medium">可选表单</CardHeader>
                  <CardBody className="space-y-4">
                    {selectedFields.map((f) =>
                      f.type === "textarea" ? (
                        <Textarea
                          key={f.key}
                          name={f.key}
                          label={f.label}
                          placeholder={f.placeholder}
                          isRequired={Boolean(f.required)}
                        />
                      ) : (
                        <Input
                          key={f.key}
                          name={f.key}
                          label={f.label}
                          placeholder={f.placeholder}
                          isRequired={Boolean(f.required)}
                        />
                      )
                    )}
                  </CardBody>
                </Card>
              ) : null}

              <Textarea
                name="bodyMarkdown"
                label="工单内容（Markdown）"
                placeholder="请详细描述问题。支持 Markdown，例如：\n\n- 复现步骤\n- 期望结果\n- 实际结果"
                minRows={8}
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
                发起工单
              </Button>
            </Form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
