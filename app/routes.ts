import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("sso/callback", "routes/sso.callback.tsx"),
  route("mock-sso", "routes/mock-sso.tsx"),

  route("attachments/:attachmentId", "routes/attachments.$attachmentId.tsx"),

  // Placeholders for the ticket system; will be implemented next.
  route("tickets", "routes/tickets.tsx"),
  route("tickets/:ticketId", "routes/tickets.$ticketId.tsx"),
  route("new", "routes/new.tsx"),
  route("admin", "routes/admin.tsx"),
  route("admin/users", "routes/admin.users.tsx"),
  route("admin/categories", "routes/admin.categories.tsx"),
  route("admin/tickets", "routes/admin.tickets.tsx", [
    route(":ticketId", "routes/admin.tickets.$ticketId.tsx"),
  ]),
] satisfies RouteConfig;
