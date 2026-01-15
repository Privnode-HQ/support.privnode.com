import type { Route } from "./+types/logout";
import { redirect } from "react-router";
import { destroySession } from "../server/session";

export async function action({}: Route.ActionArgs) {
  const headers = new Headers();
  headers.append("Set-Cookie", destroySession());
  return redirect("/", { headers });
}

export async function loader() {
  // Avoid accidental GET logouts.
  return redirect("/");
}

export default function Logout() {
  return null;
}

