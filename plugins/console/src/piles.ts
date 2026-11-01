// Jev piles for the Inbox page, shared by the server (questions, rule) and the
// app (labels, colours). Pure data: no Node or DOM imports.

export const PILE_IDS = ["reply_today", "clients", "partners", "billing", "community", "social", "newsletters", "fyi", "spam"] as const;
export type PileId = (typeof PILE_IDS)[number];

/** Labels and dot colours, in the order the owner reads them. Calm categorical tones; the pile that needs him leads in blue. */
export const PILES: Record<PileId, { label: string; color: string }> = {
  reply_today: { label: "Reply today", color: "#2a5bff" },
  clients: { label: "Clients & leads", color: "#1f7a4d" },
  partners: { label: "Partners & sponsors", color: "#4f7a6e" },
  billing: { label: "Billing & receipts", color: "#66707a" },
  community: { label: "Community (Skool)", color: "#6e56a8" },
  social: { label: "Social & notifications", color: "#7a5c8a" },
  newsletters: { label: "Newsletters", color: "#6b6b72" },
  fyi: { label: "FYI", color: "#8e8e96" },
  spam: { label: "Spam", color: "#c81e1e" },
};

/** "Reply today" is a rule in code, not only a Jev option: a person asks the owner for something, soon. */
export const REPLY_RULE = { needsReply: 0.6, fromPerson: 0.5, urgency: 1.5 } as const;

export const URGENCY_LEVELS = ["No reply expected", "Some time this week", "Within a day or two", "Today, or blocked"];
