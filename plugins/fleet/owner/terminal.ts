import type { HostBinding } from "./host-identity";

export type TerminalPlan =
  | { kind: "enrolled"; hostId: string }
  | { kind: "ssh"; hostId: string; alias: string; argv: string[] }
  | { kind: "none"; reason: string };

export function terminalTitle(machine: string, via: "enrolled" | "ssh"): string {
  return via === "ssh" ? `${machine} terminal (ssh)` : `${machine} terminal`;
}

/** The options the owner RPC route is verified with, so the shell is reached the same way: keys only, bounded connect, no forwarding. */
export function sshTerminalArgv(alias: string): string[] {
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", alias];
}

/** An enrolled host that is provably the machine, else ssh to the always-on Mac once its route is authenticated, from this Mac's proven host. */
export function planTerminal(input: { machine: string; localMachine: string; binding: HostBinding; sshAlias: string | null; sshVerified: boolean; localHostId: string | null }): TerminalPlan {
  if (input.binding.verified && input.binding.enrolledHostId) return { kind: "enrolled", hostId: input.binding.enrolledHostId };
  if (input.machine === input.localMachine) return { kind: "none", reason: input.binding.reason ?? "This is the Mac you are on; use its own terminal" };
  if (input.sshAlias === null) return { kind: "none", reason: `No SSH alias for ${input.machine} on this Mac, and ${input.binding.reason ?? "no enrolled host is proven"}` };
  if (!input.sshVerified) return { kind: "none", reason: `The ${input.sshAlias} SSH route to ${input.machine} is not verified right now, so Fleet will not open a terminal over it` };
  if (input.localHostId === null) return { kind: "none", reason: "This Mac's own host is not proven yet, so Fleet cannot start an SSH terminal from it" };
  return { kind: "ssh", hostId: input.localHostId, alias: input.sshAlias, argv: sshTerminalArgv(input.sshAlias) };
}

interface Session { id: string; title: string; status: string; hostId: string; updatedAt: number }

/** A live or reconnecting session for this machine is reopened; only an exited one is replaced. */
export function pickReusableTerminal<T extends Session>(sessions: T[], machine: string, via: "enrolled" | "ssh", hostId: string): T | null {
  const title = terminalTitle(machine, via);
  const live = sessions.filter((session) => session.title === title && session.hostId === hostId && session.status !== "exited").sort((a, b) => b.updatedAt - a.updatedAt);
  return live[0] ?? null;
}
