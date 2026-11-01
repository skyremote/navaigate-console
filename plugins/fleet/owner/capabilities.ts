// Verified host capabilities (F01, F02, F03, F12, F15, F21, F82) and the
// opaque hardware identity used to prove that an independent owner and an
// enrolled host are the same physical machine (F18). Everything here is
// observed on the machine itself; nothing is declared by a label.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { z } from "zod";

export const hostCapabilitiesSchema = z.object({
  v: z.literal(1),
  observedAt: z.number(),
  platform: z.object({ os: z.string(), arch: z.string(), release: z.string() }),
  hardwareId: z.string().nullable(),
  gui: z.enum(["present", "absent", "unknown", "not-applicable"]),
  xcode: z.object({ verified: z.boolean(), version: z.string().nullable() }),
  simulators: z.object({ available: z.boolean(), booted: z.number().int().nonnegative(), tapControl: z.boolean() }),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export type Exec = (bin: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>;

export const defaultExec: Exec = (bin, args, timeoutMs = 10_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1) : 0, stdout: String(stdout ?? "") });
  });
});

/** sha256 over a domain tag and the platform's stable machine identifier; never the raw id. */
export function opaqueHardwareId(raw: string | null): string | null {
  const value = raw?.trim() ?? "";
  if (value.length < 8 || value.length > 256) return null;
  return `bbhw1:${createHash("sha256").update(`bb-fleet-hardware-v1\0${value}`).digest("hex").slice(0, 40)}`;
}

export async function rawHardwareId(exec: Exec, os: NodeJS.Platform = platform()): Promise<string | null> {
  if (os === "darwin") {
    const out = await exec("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const match = out.code === 0 ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(out.stdout) : null;
    return match?.[1] ?? null;
  }
  if (os === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try { if (existsSync(path)) return readFileSync(path, "utf8").trim() || null; } catch { return null; }
    }
    return null;
  }
  if (os === "win32") {
    const out = await exec("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    return out.code === 0 ? /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out.stdout)?.[1] ?? null : null;
  }
  return null;
}

export async function probeCapabilities(options: { exec?: Exec; os?: NodeJS.Platform; uid?: number; now?: () => number } = {}): Promise<HostCapabilities> {
  const exec = options.exec ?? defaultExec;
  const os = options.os ?? platform();
  const hardwareId = opaqueHardwareId(await rawHardwareId(exec, os));
  let gui: HostCapabilities["gui"] = "not-applicable";
  let xcode: HostCapabilities["xcode"] = { verified: false, version: null };
  let simulators: HostCapabilities["simulators"] = { available: false, booted: 0, tapControl: false };
  if (os === "darwin") {
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const session = await exec("/bin/launchctl", ["print", `gui/${uid}`]);
    gui = session.code === 0 ? "present" : session.code === -1 ? "unknown" : "absent";
    const build = await exec("/usr/bin/xcodebuild", ["-version"], 20_000);
    const version = build.code === 0 ? /^Xcode\s+(\S+)/m.exec(build.stdout)?.[1] ?? null : null;
    xcode = { verified: version !== null, version };
    if (version !== null) {
      const list = await exec("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "-j"], 20_000);
      let booted = 0;
      try { booted = Object.values((JSON.parse(list.stdout) as { devices: Record<string, unknown[]> }).devices).reduce((sum, devices) => sum + devices.length, 0); } catch { booted = 0; }
      const idb = await exec("/usr/bin/which", ["idb"]);
      simulators = { available: list.code === 0, booted, tapControl: idb.code === 0 && idb.stdout.trim() !== "" };
    }
  }
  return { v: 1, observedAt: (options.now ?? Date.now)(), platform: { os, arch: arch(), release: release() }, hardwareId, gui, xcode, simulators };
}

/** Capability names a router may treat as verified, derived only from observations. */
export function verifiedCapabilityNames(caps: HostCapabilities): string[] {
  return [
    ...(caps.xcode.verified ? ["xcode"] : []),
    ...(caps.simulators.available ? ["ios-simulator"] : []),
    ...(caps.gui === "present" ? ["gui-session"] : []),
  ];
}
