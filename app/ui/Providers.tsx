import type { PropsWithChildren } from "react";
import { HeroUIProvider } from "@heroui/react";
import { useHref, useNavigate } from "react-router";

export function Providers({ children }: PropsWithChildren) {
  const navigate = useNavigate();

  return (
    <HeroUIProvider
      // HeroUI expects a navigation function for its Link components.
      navigate={(to, options) => navigate(to as any, options as any)}
      // React Router provides this hook; HeroUI will call it internally.
      useHref={useHref}
      locale="zh-CN"
    >
      {children}
    </HeroUIProvider>
  );
}

