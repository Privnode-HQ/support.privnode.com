import type { PropsWithChildren } from "react";
import {
  Button,
  Link,
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
} from "@heroui/react";
import { Form, useLocation } from "react-router";

function TopNavLink({ href, label }: { href: string; label: string }) {
  const location = useLocation();
  const active =
    location.pathname === href ||
    (href !== "/" && location.pathname.startsWith(href + "/"));

  return (
    <NavbarItem isActive={active}>
      <Link
        href={href}
        color={active ? "primary" : "foreground"}
        aria-current={active ? "page" : undefined}
      >
        {label}
      </Link>
    </NavbarItem>
  );
}

export function AppShell({
  children,
  user,
}: PropsWithChildren<{
  user: { uid: number; username: string; isAdmin: boolean } | null;
}>) {
  return (
    <div className="min-h-dvh flex flex-col">
      <Navbar maxWidth="full" isBordered>
        <NavbarBrand>
          <Link href="/" className="font-semibold text-foreground">
            Privnode 支持
          </Link>
        </NavbarBrand>

        <NavbarContent className="hidden sm:flex gap-4" justify="center">
          <TopNavLink href="/tickets" label="我的工单" />
          <TopNavLink href="/new" label="发起工单" />
          {user?.isAdmin && <TopNavLink href="/admin" label="管理后台" />}
        </NavbarContent>

        <NavbarContent justify="end">
          {user ? (
            <>
              <NavbarItem className="hidden sm:flex text-sm text-default-600">
                {user.username}
              </NavbarItem>
              <NavbarItem>
                <Form method="post" action="/logout">
                  <Button color="default" variant="flat" type="submit">
                    退出
                  </Button>
                </Form>
              </NavbarItem>
            </>
          ) : (
            <NavbarItem>
              <Button as={Link} color="primary" href="/login" variant="flat">
                登录
              </Button>
            </NavbarItem>
          )}
        </NavbarContent>
      </Navbar>

      <main className="flex-1 container mx-auto max-w-5xl px-4 py-6">
        {children}
      </main>

      <footer className="border-t border-default-200">
        <div className="container mx-auto max-w-5xl px-4 py-4 text-sm text-default-500">
          © {new Date().getFullYear()} Privnode
        </div>
      </footer>
    </div>
  );
}
