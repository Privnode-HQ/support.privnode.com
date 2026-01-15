# Privnode 支持

技术栈：React Router Framework Mode + Supabase + HeroUI + TailwindCSS。

## 本地开发（带 Mock SSO）

1. 准备环境变量：

```bash
cp .env.example .env
```

2. 启动：

```bash
npm run dev
```

3. 打开：`http://localhost:5173`

4. 点击右上角「登录」进入模拟 SSO 登录流程。

## Supabase 初始化

1. 创建 Supabase 项目后，在 SQL Editor 里执行：`supabase/migrations/001_init.sql`
2. 在 Supabase Dashboard → Settings → API → Schemas 中，把 `app` 加到 Exposed schemas（否则 PostgREST 无法访问 `app.*` 表）
3. 在 `.env` 中配置：

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

说明：当前实现以服务端 service role 访问 Supabase 为主，数据库表已开启 RLS 并默认拒绝 anon/authenticated。

如果你看到类似 “schema cache” 的报错，可在 SQL Editor 里执行一次：

```sql
notify pgrst, 'reload schema';
```

如果你看到 `permission denied for schema app`，请确认：

- `.env` 使用的是 `SUPABASE_SERVICE_ROLE_KEY`（不是 anon key）
- 并在 SQL Editor 执行（也可以重新执行迁移文件）：

```sql
grant usage on schema app to service_role;
grant all privileges on all tables in schema app to service_role;
grant all privileges on all sequences in schema app to service_role;
grant execute on all functions in schema app to service_role;
```

## 管理员权限

在 `app.users` 表中将 `is_admin` 设为 `true` 即可成为管理员。例如：

```sql
update app.users set is_admin = true where uid = 10001;
```

## 真实 SSO 对接

本项目实现的 SSO 流程：

- `/login`：生成 nonce/metadata，并重定向到 `https://privnode.com/sso-beta/v1?...&postauth=<host>`
- `/sso/callback`：接收 `nonce/metadata/token`，校验并写入 httpOnly 会话 cookie

你需要提供/配置用于验证 `token` 的密钥：

- HS256：设置 `SSO_JWT_ALG=HS256` 与 `SSO_JWT_SECRET`
- RS256：设置 `SSO_JWT_ALG=RS256` 与 `SSO_JWT_PUBLIC_KEY_PEM`

## 目录结构（当前阶段）

- `app/server/*`：仅服务端使用的逻辑（SSO/JWT、cookie session 等）
- `app/routes/*`：路由（/login、/sso/callback、/mock-sso 等）
- `app/ui/*`：HeroUI Provider 与基础壳（导航/布局）
