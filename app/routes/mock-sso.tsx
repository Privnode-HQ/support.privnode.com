import type { Route } from "./+types/mock-sso";
import { randomUUID } from "node:crypto";
import { Button, Card, CardBody, CardHeader, Input } from "@heroui/react";
import { Form, data, redirect } from "react-router";
import { env } from "../server/env";
import { signMockSsoToken } from "../server/sso";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return data({
    enabled: env.mockSsoEnabled,
    nonce: url.searchParams.get("nonce") ?? "",
    metadata: url.searchParams.get("metadata") ?? "",
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (!env.mockSsoEnabled) {
    return data(
      { ok: false as const, error: "Mock SSO 未启用（请设置 MOCK_SSO=true）。" },
      { status: 400 }
    );
  }

  const form = await request.formData();
  const nonce = String(form.get("nonce") ?? "");
  const metadata = String(form.get("metadata") ?? "");
  const uid = Number(form.get("uid"));
  const username = String(form.get("username") ?? "").trim();
  const authtk = String(form.get("authtk") ?? "").trim();

  if (!nonce || !metadata) {
    return data(
      { ok: false as const, error: "缺少 nonce/metadata。" },
      { status: 400 }
    );
  }
  if (!Number.isFinite(uid) || uid <= 0) {
    return data(
      { ok: false as const, error: "uid 必须是正整数。" },
      { status: 400 }
    );
  }
  if (!username) {
    return data(
      { ok: false as const, error: "username 不能为空。" },
      { status: 400 }
    );
  }

  const token = await signMockSsoToken({
    uid,
    username,
    authtk: authtk || `mock-${randomUUID()}`,
  });

  const cb = new URL("/sso/callback", "http://local");
  cb.searchParams.set("nonce", nonce);
  cb.searchParams.set("metadata", metadata);
  cb.searchParams.set("token", token);

  return redirect(cb.pathname + cb.search);
}

export default function MockSso({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.enabled) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Mock SSO 未启用</h1>
        <p className="text-default-600">请在本地开发环境中设置环境变量：MOCK_SSO=true</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">模拟 SSO 登录（仅本地开发）</h1>

      <Card>
        <CardHeader className="font-medium">生成并跳转到 /sso/callback</CardHeader>
        <CardBody className="space-y-4">
          {actionData?.ok === false && (
            <p className="text-danger">{actionData.error}</p>
          )}

          <Form method="post" className="space-y-4">
            <input type="hidden" name="nonce" value={loaderData.nonce} />
            <input type="hidden" name="metadata" value={loaderData.metadata} />

            <Input
              name="uid"
              label="uid"
              placeholder="例如：10001"
              defaultValue="10001"
              inputMode="numeric"
              isRequired
            />
            <Input
              name="username"
              label="username"
              placeholder="例如：tethys"
              defaultValue="dev-user"
              isRequired
            />
            <Input
              name="authtk"
              label="authtk（可选）"
              placeholder="留空则自动生成"
            />

            <Button color="primary" type="submit">
              模拟登录
            </Button>
          </Form>
        </CardBody>
      </Card>
    </div>
  );
}

