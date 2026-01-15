import { getTicketIdByShortId, canUserAccessTicket } from "./models/tickets.server";

/**
 * Process markdown content to replace #shortid patterns with links to tickets
 * Only replaces short IDs that the user has access to
 */
export async function processTicketLinks(
  markdown: string,
  viewerUid: number | null,
  isAdmin: boolean = false
): Promise<string> {
  // Match #followed by exactly 8 lowercase hex characters
  const shortIdPattern = /#([a-f0-9]{8})\b/gi;
  const matches = [...markdown.matchAll(shortIdPattern)];

  if (matches.length === 0) {
    return markdown;
  }

  // Collect unique short IDs
  const shortIds = new Set(matches.map(m => m[1].toLowerCase()));

  // Map short_id -> ticket_id for accessible tickets
  const accessibleTickets = new Map<string, string>();

  for (const shortId of shortIds) {
    try {
      const ticketId = await getTicketIdByShortId(shortId);
      if (!ticketId) continue;

      // Admin can access all tickets, regular users need ownership check
      if (isAdmin) {
        accessibleTickets.set(shortId, ticketId);
      } else if (viewerUid !== null) {
        const hasAccess = await canUserAccessTicket(viewerUid, ticketId);
        if (hasAccess) {
          accessibleTickets.set(shortId, ticketId);
        }
      }
    } catch (error) {
      // Ignore errors for individual lookups
      console.error(`Error processing short_id ${shortId}:`, error);
    }
  }

  // Replace accessible short IDs with markdown links
  let result = markdown;
  for (const [shortId, ticketId] of accessibleTickets.entries()) {
    const pattern = new RegExp(`#${shortId}\\b`, 'gi');
    result = result.replace(pattern, `[#${shortId}](/tickets/${ticketId})`);
  }

  return result;
}
