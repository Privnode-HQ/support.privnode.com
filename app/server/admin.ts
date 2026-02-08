import { redirect } from "react-router";
import { requireUser } from "./auth";
import { getIsAdminForUid } from "./models/users.server";

export async function requireAdmin(request: Request) {
  const user = await requireUser(request);
  const isAdmin = await getIsAdminForUid(user.uid);
  if (!isAdmin) {
    // Keep it simple: redirect to home.
    throw redirect("/");
  }

  return user;
}
