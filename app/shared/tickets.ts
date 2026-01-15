export type TicketStatus =
  | "pending_assign"
  | "assigned"
  | "replied_by_staff"
  | "replied_by_customer"
  | "closed";

export function ticketStatusLabel(s: TicketStatus): string {
  switch (s) {
    case "pending_assign":
      return "待分配";
    case "assigned":
      return "已分配";
    case "replied_by_staff":
      return "已被工作人员回复";
    case "replied_by_customer":
      return "已被客户回复";
    case "closed":
      return "被关闭";
    default:
      return s;
  }
}

