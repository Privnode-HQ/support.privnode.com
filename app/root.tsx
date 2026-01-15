import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  data,
  useLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { AppShell } from "./ui/AppShell";
import { Providers } from "./ui/Providers";

export async function loader({ request }: Route.LoaderArgs) {
  const { getSessionUser } = await import("./server/session");
  const user = await getSessionUser(request);

  if (!user) {
    return data({ user: null });
  }

  // Fetch is_admin from database
  const { getSupabaseAdminDb } = await import("./server/supabase.server");
  const supabase = getSupabaseAdminDb();
  const { data: userData } = await supabase
    .from("users")
    .select("is_admin")
    .eq("uid", user.uid)
    .maybeSingle();

  return data({
    user: {
      uid: user.uid,
      username: user.username,
      isAdmin: userData?.is_admin ?? false,
    },
  });
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="light">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          // Keep theme selection consistent with system preference.
          // HeroUI themes are activated via `html.dark` / `html.light`.
          dangerouslySetInnerHTML={{
            __html: `(()=>{const m=window.matchMedia('(prefers-color-scheme: dark)');const set=()=>{const d=m.matches;document.documentElement.classList.toggle('dark',d);document.documentElement.classList.toggle('light',!d);document.documentElement.style.colorScheme=d?'dark':'light';};set();m.addEventListener?.('change',set);})();`,
          }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { user } = useLoaderData<typeof loader>();

  return (
    <Providers>
      <AppShell user={user}>
        <Outlet />
      </AppShell>
    </Providers>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "出错了";
  let details = "发生了一个意外错误。";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "错误";
    details =
      error.status === 404
        ? "你访问的页面不存在。"
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
