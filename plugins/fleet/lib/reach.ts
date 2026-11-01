export type Reach = "here" | "brain" | "ssh";

/** How this bb can send work or a message to a machine; null when it cannot. */
export function reachOf(
  column: { key: string; online: boolean; local: boolean },
  board: { me: { joined: boolean }; transport?: { directOwner: "ready" | "unavailable" | "unconfigured"; directMachine?: string | null } },
): Reach | null {
  if (!column.online) return null;
  if (column.local) return "here";
  if (board.me.joined) return "brain";
  return board.transport?.directMachine != null && column.key === board.transport.directMachine && board.transport.directOwner === "ready" ? "ssh" : null;
}
