// Fleet management panel: the version and provider matrix with guarded,
// staged updates (F26, F78), and each owner's routes, verified capabilities,
// providers, MCP endpoint, editor links and binding-gated native terminal
// (F01-F03, F07, F15, F18, F19, F21, F23, F25, F27).
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard, useBbNavigate, useRealtime, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import type { updatesRpcContract, UpdateMatrix } from "../owner/updates";
import type { OwnerDetail, ownerDetailRpcContract } from "../owner/detail-contract";
import type { simulatorForwardContract } from "../owner/simulators";
import type { browserForwardContract } from "../owner/browser";
import type { transferRpcContract } from "../owner/transfer-manifest";
import type { ownerProjectContract } from "../owner/project-contract";
import { rpcFlight } from "../lib/rpc-flight";
import { useVisiblePoll } from "../lib/visible-poll";
import { NewProjectForm } from "./new-project-form";
import { pickReusableTerminal, planTerminal, terminalTitle } from "../owner/terminal";
import { LoadMetricsPanel } from "./load-metrics-panel";
import { useFeatureOff } from "./picks-context";
import { AppUpdateButton, ChannelSelect, PinControl } from "./channel-controls";
import { channelChangeMessage, channelFor, policyForChannel, updateGate, type UpdateChannel } from "../owner/update-policy";
import { OWNER_AGE_TICK_MS, ago, createOwnerRefresher, readAge, routeChip, type OwnerRefresher } from "./owner-refresh";

type Machine = string;
export interface FleetMachineEntry { id: string; label: string }
type Contract = typeof rpcContract & typeof updatesRpcContract & typeof ownerDetailRpcContract;

const STYLE = `
.fm{margin-top:24px;display:flex;flex-direction:column;gap:16px}
.fm :is(button,input,select,textarea):focus-visible{outline:none;box-shadow:0 0 0 2px var(--ring)}
.fm h3{font-size:14px;font-weight:500;margin:0 0 8px}
.fm-table{width:100%;border-collapse:collapse;font-size:12px}
.fm-table th,.fm-table td{text-align:left;padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
.fm-table th{color:var(--muted-foreground);font-weight:500}
.fm-muted{color:var(--muted-foreground);font-size:12px}
.fm-chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--border);margin:0 4px 4px 0;color:var(--muted-foreground)}
.fm-chip.ok{color:var(--success);border-color:color-mix(in oklab,var(--success) 40%,transparent)}
.fm-chip.bad{color:var(--destructive-text);border-color:color-mix(in oklab,var(--destructive) 40%,transparent)}
.fm-card{background:var(--surface-recessed);border-radius:var(--radius);padding:12px}
.fm-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fm-btn{font:inherit;font-size:13px;min-height:32px;padding:4px 12px;border-radius:var(--radius);border:1px solid var(--border);background:var(--secondary);color:var(--secondary-foreground);cursor:pointer;transition:background-color .15s}
.fm-btn:hover:not(:disabled){background:var(--accent)}
.fm-btn:disabled{opacity:.5;cursor:default}
.fm-select,.fm-input{font:inherit;font-size:13px;min-height:32px;padding:4px 8px;border-radius:var(--radius);border:1px solid var(--input);background:var(--background);color:var(--foreground)}
.fm-input{width:90px}
`;

function intentId(machine: string, version: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `fleet-${machine.toLowerCase()}-${version.replace(/\./g, "")}-${random}`;
}

function UpdatesMatrix() {
  const rpc = useRpc<Contract>();
  const channelsOff = useFeatureOff("F78");
  const [matrix, setMatrix] = useState<UpdateMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const read = useCallback((fresh: boolean) => {
    rpcFlight().call("updates_matrix", () => rpc.call("updates_matrix", null), { fresh }).then((value) => { setMatrix(value); setError(null); }, (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);
  const load = useCallback(() => read(true), [read]);
  const poll = useCallback(() => read(false), [read]);
  useEffect(poll, [poll]);
  useVisiblePoll(poll, 60_000);

  const updateApp = async (row: UpdateMatrix["rows"][number]) => {
    const app = row.status?.app;
    if (!app?.available) return;
    const native = app.exactApply && app.desktopUpdateSupported;
    if (!window.confirm(`Update ${row.machine} from bb ${app.current} to ${app.available}? It waits for running threads to finish, then restarts bb there.`)) return;
    setBusy(`app:${row.machine}`);
    try {
      const result = await rpc.call("update_dispatch", { v: 1, machine: row.machine, intentId: intentId(row.machine, app.available), fromVersion: app.current, targetVersion: app.available, mode: native ? "native" : "bootstrap", quitMode: "signal" });
      if (result.state === "started" || result.state === "existing") toast.success(`${row.machine}: update ${result.intent?.intentId ?? ""} ${result.state}`);
      else toast.error(`${row.machine}: ${result.state}${result.reason ? `: ${result.reason}` : ""}`);
      load();
    } finally { setBusy(null); }
  };

  const savePolicy = async (next: { testMachine: string | null; pinnedVersion: string | null }, label: string) => {
    setBusy("policy");
    try {
      await rpc.call("updates_policy_set", { testMachine: next.testMachine, pinnedVersion: next.pinnedVersion });
      toast.success(label);
      load();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };
  const changeChannel = (machine: string, channel: UpdateChannel) => {
    if (!matrix) return;
    void savePolicy(policyForChannel(matrix.policy, machine, channel), channelChangeMessage(matrix.policy, machine, channel));
  };
  const changePin = (value: string | null) => {
    if (!matrix) return;
    void savePolicy({ ...matrix.policy, pinnedVersion: value }, value ? `Fleet pinned to ${value}` : "Version pin cleared");
  };

  const updateProvider = async (row: UpdateMatrix["rows"][number], provider: NonNullable<UpdateMatrix["rows"][number]["status"]>["providers"][number]) => {
    if (!window.confirm(`Update ${provider.displayName} on ${row.machine} from ${provider.currentVersion ?? "not installed"}? Threads using it must finish first.`)) return;
    setBusy(`prov:${row.machine}:${provider.provider}`);
    try {
      const result = await rpc.call("provider_update_dispatch", { v: 1, machine: row.machine, requestId: intentId(row.machine, `${provider.provider}`), provider: provider.provider, expectedFromVersion: provider.currentVersion });
      if (result.state === "completed") toast.success(`${provider.displayName} on ${row.machine}: ${result.fromVersion ?? "-"} → ${result.toVersion ?? "?"}`);
      else toast.error(`${provider.displayName} on ${row.machine}: ${result.state}${result.message ? `: ${result.message}` : ""}`);
      load();
    } finally { setBusy(null); }
  };

  return (
    <div className="fm-card">
      <h3>Versions and updates</h3>
      {error ? <div className="fm-muted">{error}</div> : null}
      {matrix ? (
        <>
          <div className="fm-muted" style={{ marginBottom: 6 }}>
            Staging: {matrix.policy.testMachine ? `${matrix.policy.testMachine} first` : "off"} · Other machines update only after the nightly host runs that version
          </div>
          {channelsOff ? null : <PinControl pinned={matrix.policy.pinnedVersion} busy={busy !== null} onSave={changePin} />}
          <table className="fm-table">
            <thead><tr><th>Machine</th>{channelsOff ? null : <th>Channel</th>}<th>bb</th><th>Update</th><th>Providers</th></tr></thead>
            <tbody>
              {matrix.rows.map((row) => {
                const app = row.status?.app ?? null;
                const intent = row.status?.helper.latestIntent ?? null;
                return (
                  <tr key={row.machine}>
                    <td><b>{row.machine}</b><div className="fm-muted">{row.route === "self" ? "this bb" : row.route === "ssh" ? "via SSH" : "no route"}</div></td>
                    {channelsOff ? null : <td><ChannelSelect machine={row.machine} channel={channelFor(matrix.policy, row.machine)} busy={busy !== null} nightlyDisabled={row.route === "none"} onChange={changeChannel} /></td>}
                    <td>
                      {app ? <>{app.current}<div className="fm-muted">{app.runningThreadCount} running · {app.desktopUpdateSupported ? "desktop relay" : app.support}{app.exactApply ? " · exact" : ""}</div></> : <span className="fm-muted">{row.reason ?? row.status?.appError ?? "unknown"}</span>}
                    </td>
                    <td>
                      {app?.available ? (
                        <AppUpdateButton available={app.available} gate={updateGate(matrix.policy, matrix.rows, row.machine)} busy={busy !== null} helperSupported={row.status?.helper.supported === true} helperReason={row.status?.helper.reason ?? null} onUpdate={() => void updateApp(row)} />
                      ) : <span className="fm-muted">{app ? "up to date" : "-"}</span>}
                      {intent ? <div className="fm-muted">Last: {intent.intentId} · {intent.phase}{intent.reason ? ` · ${intent.reason}` : ""}</div> : null}
                    </td>
                    <td>
                      {(row.status?.providers ?? []).filter((provider) => provider.installed).map((provider) => (
                        <div key={provider.provider} className="fm-row">
                          <span>{provider.displayName} {provider.currentVersion ?? "?"}</span>
                          {provider.needsUpdate && provider.actionKind ? (
                            <button type="button" className="fm-btn" disabled={busy !== null} onClick={() => void updateProvider(row, provider)}>→ {provider.latestVersion ?? "latest"}</button>
                          ) : null}
                        </div>
                      ))}
                      {row.status?.providersError ? <div className="fm-muted">{row.status.providersError}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : <div className="fm-muted">Loading versions...</div>}
    </div>
  );
}

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function useOwnerDetail(machine: Machine) {
  const rpc = useRpc<Contract>();
  const [detail, setDetail] = useState<OwnerDetail | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refresher = useRef<OwnerRefresher | null>(null);
  useEffect(() => {
    const instance = createOwnerRefresher<OwnerDetail>({
      load: () => rpc.call("owner_detail_get", { machine }),
      onData: (value, at) => { setDetail(value); setFetchedAt(at); setError(null); setNow(at); },
      onError: setError,
      visible: pageVisible(),
    });
    refresher.current = instance;
    instance.start();
    const onVisibility = () => instance.setVisible(pageVisible());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      instance.stop();
      refresher.current = null;
    };
  }, [rpc, machine]);
  useRealtime("fleet-changed", () => refresher.current?.refresh());
  useEffect(() => {
    const timer = setInterval(() => { if (pageVisible()) setNow(Date.now()); }, OWNER_AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const load = useCallback(() => refresher.current?.refresh(true), []);
  return { detail, fetchedAt, error, now, load };
}

function OwnerCard({ machine, label, localMachine, threads }: { machine: Machine; label: string; localMachine: string; threads: OwnerThread[] }) {
  const rpc = useRpc<Contract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { detail, fetchedAt, error, now, load } = useOwnerDetail(machine);
  const off = { mcpToggle: useFeatureOff("F07"), terminal: useFeatureOff("F18"), simulator: useFeatureOff("F21"), browser: useFeatureOff("F22"), routes: useFeatureOff("F23"), mcpEndpoint: useFeatureOff("F25"), ignored: useFeatureOff("F29"), newProject: useFeatureOff("F65") };

  const plan = detail && !off.terminal ? planTerminal({ machine, localMachine, binding: detail.binding, sshAlias: detail.terminal.sshAlias, sshVerified: detail.terminal.sshVerified, localHostId: detail.terminal.localHostId }) : null;
  const openTerminal = async () => {
    if (plan === null || plan.kind === "none") return;
    const via = plan.kind === "ssh" ? "ssh" : "enrolled";
    try {
      const listed = await sdk.terminals.list({ scope: { kind: "host_path", hostId: plan.hostId } });
      const reused = pickReusableTerminal(listed.sessions, machine, via, plan.hostId);
      const session = reused ?? await sdk.terminals.create({
        scope: { kind: "host_path", hostId: plan.hostId, cwd: null }, cols: 100, rows: 30, title: terminalTitle(machine, via),
        ...(plan.kind === "ssh" ? { start: { mode: "argv" as const, argv: plan.argv } } : {}),
      });
      const opened = await navigate.experimental_openTerminal({ terminalId: session.id });
      if (!opened) toast.error(`The ${label} terminal could not be shown here`);
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  };

  const toggleMcp = async () => {
    if (!detail?.mcp) return;
    try { await rpc.call("mcp_enable", { enabled: !detail.mcp.enabled }); load(); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (!detail && error) return <div className="fm-card"><h3>{label}</h3><div className="fm-muted">{error}</div></div>;
  if (!detail || fetchedAt === null) return <div className="fm-card"><h3>{label}</h3><div className="fm-muted">Loading...</div></div>;
  const caps = detail.capabilities;
  return (
    <div className="fm-card">
      <div className="fm-row" style={{ justifyContent: "space-between" }}>
        <h3>{label}{detail.owner?.appVersion ? ` · bb ${detail.owner.appVersion}` : ""}</h3>
        {off.routes ? null : <span className="fm-muted">route: {detail.activeRoute}{detail.owner ? ` · updated ${ago(detail.owner.publishedAt, now)}` : ""}</span>}
      </div>
      <div>
        {off.routes ? null : detail.routes.map((route) => {
          const chip = routeChip(route, now);
          return <span key={route.kind} className={`fm-chip ${chip.tone}`} title={route.detail ?? undefined}>{chip.label}</span>;
        })}
        {(() => {
          const age = readAge(fetchedAt, error !== null, now);
          return <span className={`fm-chip ${age.tone}`} title={error ?? undefined}>{age.label}</span>;
        })()}
      </div>
      {caps ? (
        <div>
          <span className="fm-chip">{caps.platform.os}/{caps.platform.arch}</span>
          <span className={`fm-chip ${caps.gui === "present" ? "ok" : ""}`}>GUI {caps.gui}</span>
          <span className={`fm-chip ${caps.xcode.verified ? "ok" : ""}`}>{caps.xcode.verified ? `Xcode ${caps.xcode.version}` : "no Xcode"}</span>
          {caps.simulators.available && !off.simulator ? <span className="fm-chip">{caps.simulators.booted} simulator(s){caps.simulators.tapControl ? "" : " · taps unsupported (no idb)"}</span> : null}
        </div>
      ) : <div className="fm-muted">Capabilities unknown (owner Fleet too old or unreachable)</div>}
      {detail.providers ? (
        <div>
          {detail.providers.map((provider) => (
            <span key={provider.id} className={`fm-chip ${provider.auth === "ready" ? "ok" : provider.auth && provider.auth !== "unknown" ? "bad" : ""}`} title={provider.fork ? `fork: ${provider.fork}` : undefined}>
              {provider.displayName ?? provider.id}{provider.auth ? ` · ${provider.auth}` : provider.available ? "" : " · unavailable"}{provider.planLabel ? ` · ${provider.planLabel}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      <div className="fm-row">
        {detail.mcp && !(off.mcpToggle && off.mcpEndpoint) ? (
          <>
            <span className="fm-muted">MCP: {detail.mcp.installed ? (detail.mcp.enabled ? "on" : "off") : "not installed"}</span>
            {detail.mcp.endpoint && !off.mcpEndpoint ? <button type="button" className="fm-btn" onClick={() => void experimental_copyToClipboard({ text: detail.mcp!.endpoint! }).then(() => toast.success(`${label} MCP endpoint copied`))}>Copy MCP endpoint</button> : null}
            {machine === localMachine && detail.mcp.installed && !off.mcpToggle ? <button type="button" className="fm-btn" onClick={() => void toggleMcp()}>{detail.mcp.enabled ? "Turn MCP off" : "Turn MCP on"}</button> : null}
          </>
        ) : null}
        {plan?.kind === "enrolled" || plan?.kind === "ssh" ? (
          <button type="button" className="fm-btn" onClick={() => void openTerminal()} title={plan.kind === "ssh" ? `Runs ssh ${plan.alias} from this Mac; opening it again reuses the same session` : undefined}>Open terminal on {label}{plan.kind === "ssh" ? " (SSH)" : ""}</button>
        ) : plan && machine !== localMachine ? <span className="fm-muted" title={detail.binding.reason ?? undefined}>Terminal: {plan.reason}</span> : null}
        {detail.owner?.url && machine !== localMachine ? <button type="button" className="fm-btn" onClick={() => navigate.openUrl(detail.owner!.url!)}>Open {label} bb</button> : null}
      </div>
      {off.newProject ? null : detail.owner ? <NewProjectForm machine={machine} label={label} projects={detail.projects} onChanged={load} /> : <div className="fm-muted">New project on {label}: there is no authenticated route to {label}, so nothing can be created there from here</div>}
      {off.simulator ? null : <SimulatorViewer machine={machine} />}
      {detail.owner && !off.browser ? <BrowserPanel machine={machine} threads={threads} /> : null}
      {detail.owner && machine !== localMachine && threads.length && !off.ignored ? <TransferPanel machine={machine} threads={threads} /> : null}
      {detail.editorLinks.length ? (
        <div className="fm-row">
          {detail.editorLinks.slice(0, 8).map((link) => (
            <button key={link.projectId} type="button" className="fm-btn" onClick={() => navigate.openUrl(link.url)}>Open {link.name} in VS Code</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SimulatorViewer({ machine }: { machine: Machine }) {
  const rpc = useRpc<typeof simulatorForwardContract>();
  type Device = { platform: "ios" | "android"; id: string; name: string; state: string; runtime: string };
  const [devices, setDevices] = useState<Device[]>([]);
  const [iosInput, setIosInput] = useState(false);
  const [androidNote, setAndroidNote] = useState<string | null>(null);
  const [active, setActive] = useState<Device | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const call = useCallback((body: Parameters<typeof rpc.call<"simulator_forward">>[1]) => rpc.call("simulator_forward", body) as Promise<unknown>, [rpc]);
  useEffect(() => {
    call({ machine, call: { method: "simulator_list", input: null } }).then((value) => {
      const list = value as { ios: { inputControl: boolean }; android: { reason: string | null }; devices: Device[] };
      setDevices(list.devices.filter((device) => device.state === "Booted"));
      setIosInput(list.ios.inputControl);
      setAndroidNote(list.android.reason);
    }, (cause: unknown) => setNote(cause instanceof Error ? cause.message : String(cause)));
  }, [call, machine]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const shot = await call({ machine, call: { method: "simulator_frame", input: { platform: active.platform, id: active.id } } }) as { contentBase64: string; mimeType: string };
          setFrame(`data:${shot.mimeType};base64,${shot.contentBase64}`);
        } catch (cause) { setNote(cause instanceof Error ? cause.message : String(cause)); return; }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    };
    void loop();
    return () => { stopped = true; };
  }, [active, call, machine]);
  const act = async (action: Record<string, unknown>) => {
    if (!active) return;
    const result = await call({ machine, call: { method: "simulator_action", input: { target: { platform: active.platform, id: active.id }, action } as never } }) as { ok: boolean; message: string | null };
    if (!result.ok) toast.error(result.message ?? "The device did not accept that");
  };
  const canInput = active?.platform === "android" || (active?.platform === "ios" && iosInput);
  if (devices.length === 0) return note || androidNote ? <div className="fm-muted">Devices: {note ?? "no running simulators or emulators"}{androidNote ? ` · Android: ${androidNote}` : ""}</div> : null;
  return (
    <div>
      <div className="fm-row">
        {devices.map((device) => <button key={`${device.platform}:${device.id}`} type="button" className="fm-btn" onClick={() => setActive(active?.id === device.id ? null : device)}>{active?.id === device.id ? "Hide" : "Show"} {device.name} ({device.runtime})</button>)}
        {!iosInput && devices.some((device) => device.platform === "ios") ? <span className="fm-muted">iOS taps and typing need idb on {machine}</span> : null}
        {androidNote ? <span className="fm-muted">Android: {androidNote}</span> : null}
      </div>
      {active && frame ? (
        <div>
          <img alt="Device screen" src={frame} style={{ maxWidth: 280, borderRadius: 6, marginTop: 8, cursor: canInput ? "pointer" : "default" }} onClick={(event) => {
            if (!canInput) return;
            const box = event.currentTarget.getBoundingClientRect();
            const scale = event.currentTarget.naturalWidth / box.width / (active.platform === "ios" ? 3 : 1);
            void act({ kind: "tap", x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale });
          }} />
          {canInput ? (
            <div className="fm-row">
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Type on the device" style={{ font: "inherit", fontSize: 12 }} />
              <button type="button" className="fm-btn" disabled={!text} onClick={() => { void act({ kind: "text", text }); setText(""); }}>Type</button>
              {(["Enter", "Back", "Home"] as const).filter((key) => active.platform === "android" || key === "Enter").map((key) => <button key={key} type="button" className="fm-btn" onClick={() => void act({ kind: "key", key })}>{key}</button>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type OwnerThread = { id: string; title: string };
type BrowserPending = { requestId: string; method: "owner_browser_open" | "owner_browser_input"; key: string; label: string; fingerprint: string; at: number };
const BROWSER_SEND_MS = 60_000;

function BrowserPanel({ machine, threads }: { machine: Machine; threads: OwnerThread[] }) {
  const rpc = useRpc<typeof browserForwardContract>();
  const call = useCallback((method: string, input: unknown) => rpc.call("browser_forward", { machine, call: { method, input } as never }) as Promise<Record<string, unknown>>, [rpc, machine]);
  const [instance, setInstance] = useState<{ instanceId: string; generation: string; label: string } | null>(null);
  const [threadId, setThreadId] = useState<string>(threads[0]?.id ?? "");
  const [url, setUrl] = useState("https://");
  const [tabs, setTabs] = useState<{ tabId: string; url: string; title: string }[]>([]);
  const [tabId, setTabId] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ key: string; target: { threadId: string; instanceId: string; generation: string; tabId: string }; src: string; url: string; width: number; height: number } | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    call("owner_browser_instances", null).then((value) => {
      const list = value as { hostId: string | null; instances: { instanceId: string; generation: string; label: string }[] };
      setInstance(list.instances[0] ?? null);
      if (!list.hostId) setStatus("The owner's own host is not proven yet");
      else if (list.instances.length === 0) setStatus(`No bb desktop browser is open on ${machine}`);
    }, (cause: unknown) => setStatus(cause instanceof Error ? cause.message : String(cause)));
  }, [call, machine]);
  const scope = instance && threadId ? { threadId, instanceId: instance.instanceId, generation: instance.generation } : null;
  const loadTabs = useCallback(async () => {
    if (!scope) return;
    const listed = await call("owner_browser_tabs", scope) as { tabs: { tabId: string; url: string; title: string }[] };
    setTabs(listed.tabs);
  }, [call, scope?.threadId, scope?.instanceId, scope?.generation]);
  useEffect(() => { void loadTabs().catch(() => undefined); }, [loadTabs]);
  const selectedKey = scope && tabId ? JSON.stringify([machine, scope.threadId, scope.instanceId, scope.generation, tabId]) : null;
  useEffect(() => {
    setFrame(null);
    if (!scope || !tabId || !selectedKey) return;
    const target = { ...scope, tabId };
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        try {
          const shot = await call("owner_browser_frame", target) as { tab: { url: string }; mimeType: string; width: number; height: number; base64: string };
          if (stopped) return;
          setFrame({ key: selectedKey, target, src: `data:${shot.mimeType};base64,${shot.base64}`, url: shot.tab.url, width: shot.width, height: shot.height });
        } catch (cause) { if (!stopped) setStatus(cause instanceof Error ? cause.message : String(cause)); return; }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    };
    void loop();
    return () => { stopped = true; };
  }, [call, selectedKey]);
  const shown = frame && frame.key === selectedKey ? frame : null;
  const report = (receipt: Record<string, unknown>) => setStatus(`${String(receipt.state)}${receipt.message ? `: ${String(receipt.message)}` : ""}`);
  const pendingStore = `fleet.browser.pending.${machine}`;
  const readPending = useCallback((): BrowserPending | null => {
    try { return JSON.parse(localStorage.getItem(pendingStore) ?? "null") as BrowserPending | null; } catch { return null; }
  }, [pendingStore]);
  const [pending, setPendingState] = useState<BrowserPending | null>(() => readPending());
  const inFlight = useRef(false);
  const sameAction = (left: BrowserPending | null, right: BrowserPending | null) => left !== null && right !== null && left.requestId === right.requestId && left.fingerprint === right.fingerprint;
  /** Persist a new pending action only if none is held; false means nothing may be sent. */
  const holdPending = useCallback((value: BrowserPending): boolean => {
    try {
      if (readPending() !== null) return false;
      localStorage.setItem(pendingStore, JSON.stringify(value));
      if (!sameAction(readPending(), value)) return false;
    } catch {
      return false;
    }
    setPendingState(value);
    return true;
  }, [pendingStore, readPending]);
  /** Clear only the exact action this view settled; a newer action from another view stays held. */
  const releasePending = useCallback((expected: BrowserPending) => {
    const current = readPending();
    if (sameAction(current, expected)) {
      try { localStorage.removeItem(pendingStore); } catch { setStatus("The pending action could not be cleared here"); return; }
    }
    setPendingState(readPending());
  }, [pendingStore, readPending]);
  const settles = (receipt: Record<string, unknown>, action: BrowserPending) => receipt.requestId === action.requestId && receipt.method === action.method && (receipt.state === "applied" || receipt.state === "refused");
  /** Read-only check of the held action; true only once no action is held. */
  const reconcile = useCallback(async (): Promise<boolean> => {
    const current = readPending();
    if (!current) { setPendingState(null); return true; }
    setPendingState(current);
    let receipt: Record<string, unknown>;
    try { receipt = await call("owner_browser_receipt", { requestId: current.requestId }); }
    catch (cause) { setStatus(`The last action's receipt could not be read: ${cause instanceof Error ? cause.message : String(cause)}`); return false; }
    if (settles(receipt, current)) {
      releasePending(current);
      report(receipt);
      return readPending() === null;
    }
    setStatus(`The last ${current.label} may have run on ${machine}. Check the page, then confirm before acting again.`);
    return false;
  }, [call, machine, readPending, releasePending]);
  useEffect(() => { void reconcile(); }, [reconcile]);
  const dispatch = async (method: "owner_browser_open" | "owner_browser_input", key: string, label: string, body: Record<string, unknown>) => {
    if (inFlight.current || !(await reconcile())) return null;
    const action: BrowserPending = { requestId: crypto.randomUUID(), method, key, label, fingerprint: JSON.stringify(body), at: Date.now() };
    if (!holdPending(action)) {
      setStatus("Nothing was sent: this browser could not keep a durable record of the action first");
      return null;
    }
    inFlight.current = true;
    try {
      const receipt = await call(method, { v: 1, requestId: action.requestId, ...body });
      report(receipt);
      const exact = receipt.requestId === action.requestId && receipt.method === method;
      if (exact && (settles(receipt, action) || receipt.state === "unavailable")) releasePending(action);
      return exact ? receipt : null;
    } catch (cause) {
      setStatus(`The ${label} may have run on ${machine}: ${cause instanceof Error ? cause.message : String(cause)}. Check the page, then confirm before acting again.`);
      return null;
    } finally {
      inFlight.current = false;
    }
  };
  const send = async (input: Record<string, unknown>) => {
    if (!shown) return;
    await dispatch("owner_browser_input", shown.key, input.kind === "key" ? `${String(input.key)} key` : String(input.kind), { ...shown.target, expected: { url: shown.url, width: shown.width, height: shown.height }, input });
  };
  if (!instance) return status ? <div className="fm-muted">Browser on {machine}: {status}</div> : null;
  return (
    <div>
      <div className="fm-row">
        <span className="fm-muted">Browser on {machine} ({instance.label})</span>
        <select value={threadId} onChange={(event) => { setThreadId(event.target.value); setTabId(null); setTabs([]); }} style={{ font: "inherit", fontSize: 12 }}>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
        <input value={url} onChange={(event) => setUrl(event.target.value)} style={{ font: "inherit", fontSize: 12, minWidth: 220 }} />
        <button type="button" className="fm-btn" disabled={!scope || !/^https?:\/\/.+/.test(url)} onClick={async () => { if (!scope) return; const receipt = await dispatch("owner_browser_open", JSON.stringify([machine, scope.threadId, scope.instanceId, scope.generation, "open"]), "page open", { ...scope, url }); const tab = (receipt?.result as { tabId?: string } | null | undefined)?.tabId; if (tab) setTabId(tab); void loadTabs(); }}>Open on {machine}</button>
        {tabs.map((tab) => <button key={tab.tabId} type="button" className="fm-btn" onClick={() => setTabId(tab.tabId)}>{tab.title || tab.url}</button>)}
      </div>
      {shown ? (
        <div>
          <div className="fm-muted">{shown.url}</div>
          <img alt="Owner browser" src={shown.src} style={{ maxWidth: 520, borderRadius: 6, marginTop: 6, cursor: "pointer" }} onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void send({ kind: "click", x: (event.clientX - box.left) * (shown.width / box.width), y: (event.clientY - box.top) * (shown.height / box.height) });
          }} />
          <div className="fm-row">
            <input value={text} onChange={(event) => setText(event.target.value)} placeholder={`Type into ${machine}'s page`} style={{ font: "inherit", fontSize: 12 }} />
            <button type="button" className="fm-btn" disabled={!text} onClick={() => { void send({ kind: "text", text }); setText(""); }}>Type</button>
            {(["Enter", "Tab", "Backspace", "Escape"] as const).map((key) => <button key={key} type="button" className="fm-btn" onClick={() => void send({ kind: "key", key })}>{key}</button>)}
          </div>
        </div>
      ) : null}
      {pending ? (
        <div className="fm-row">
          <span className="fm-muted">Waiting on the last {pending.label}: its result is not known.</span>
          <button type="button" className="fm-btn" onClick={() => void reconcile()}>Check again</button>
          <button type="button" className="fm-btn" onClick={() => { releasePending(pending); setStatus(null); }}>I checked the page</button>
        </div>
      ) : null}
      {status ? <div className="fm-muted">{status}</div> : null}
    </div>
  );
}

function TransferPanel({ machine, threads }: { machine: Machine; threads: OwnerThread[] }) {
  const rpc = useRpc<typeof transferRpcContract & typeof ownerProjectContract>();
  const sdk = useSdk();
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const [paths, setPaths] = useState("");
  const [manifest, setManifest] = useState<{ files: { path: string; sizeBytes: number; sha256: string; contentBase64: string }[]; refused: { path: string; reason: string }[]; totalBytes: number } | null>(null);
  const [target, setTarget] = useState<{ serverId: string; machineKey: Machine; hostId: string; projectId: string; environmentId: string } | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<{ candidates: { path: string; kind: string; sizeBytes: number | null; selectable: boolean; reason: string | null }[]; truncated: boolean } | null>(null);
  const selectedPaths = paths.split("\n").map((line) => line.trim()).filter(Boolean);
  const toggle = (path: string, on: boolean) => {
    const next = on ? [...selectedPaths.filter((entry) => entry !== path), path] : selectedPaths.filter((entry) => entry !== path);
    setPaths(next.join("\n"));
    setManifest(null);
  };
  const listIgnored = async () => {
    try { setCandidates(await rpc.call("transfer_candidates", { projectId })); setStatus(null); } catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => {
    sdk.projects.list({ includePersonal: false }).then((list) => {
      const rows = (list as unknown as { id: string; name: string }[]).map(({ id, name }) => ({ id, name }));
      setProjects(rows);
      setProjectId((current) => current || rows[0]?.id || "");
    }, () => undefined);
  }, [sdk]);
  const preview = async () => {
    try {
      const built = await rpc.call("transfer_manifest_build", { projectId, paths: paths.split("\n").map((line) => line.trim()).filter(Boolean) });
      setManifest(built);
      const owner = await rpc.call("owner_thread_target", { machine, threadId });
      setTarget({ serverId: owner.serverId, machineKey: owner.machineKey, hostId: owner.hostId, projectId: owner.projectId, environmentId: owner.environmentId });
      setRequestId(crypto.randomUUID());
      setStatus(null);
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : String(cause)); }
  };
  const apply = async () => {
    if (!manifest || !target || !requestId || manifest.files.length === 0) return;
    const receipt = await rpc.call("transfer_manifest_apply", { target, requestId, files: manifest.files.map(({ path, sizeBytes, sha256, contentBase64 }) => ({ path, sizeBytes, sha256, contentBase64 })) }) as { outcome: string; message: string | null };
    setStatus(`${receipt.outcome}${receipt.message ? `: ${receipt.message}` : ""}`);
  };
  const check = async () => {
    if (!target || !requestId) return;
    const receipt = await rpc.call("transfer_receipt", { target, requestId }) as { outcome: string; message: string | null };
    setStatus(`${receipt.outcome}${receipt.message ? `: ${receipt.message}` : ""}`);
  };
  return (
    <div>
      <div className="fm-row">
        <span className="fm-muted">Copy selected files to {machine}</span>
        <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setCandidates(null); setManifest(null); }} style={{ font: "inherit", fontSize: 12 }}>
          {projects.map((project) => <option key={project.id} value={project.id}>From {project.name}</option>)}
        </select>
        <select value={threadId} onChange={(event) => setThreadId(event.target.value)} style={{ font: "inherit", fontSize: 12 }}>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>Into {thread.title}</option>)}
        </select>
      </div>
      <div className="fm-row">
        <button type="button" className="fm-btn" disabled={!projectId} onClick={() => void listIgnored()}>List ignored files</button>
        {candidates ? <span className="fm-muted">{candidates.candidates.filter((entry) => entry.selectable).length} selectable of {candidates.candidates.length}{candidates.truncated ? " (list truncated; type other paths below)" : ""}</span> : null}
      </div>
      {candidates && candidates.candidates.length ? (
        <div style={{ maxHeight: 160, overflow: "auto" }}>
          {candidates.candidates.map((entry) => (
            <label key={entry.path} className="fm-row" style={{ fontSize: 12 }}>
              <input type="checkbox" aria-label={`Select ${entry.path}`} disabled={!entry.selectable} checked={selectedPaths.includes(entry.path)} onChange={(event) => toggle(entry.path, event.target.checked)} />
              <span>{entry.path}{entry.kind === "directory" ? "/" : ""}</span>
              {entry.sizeBytes !== null ? <span className="fm-muted">{entry.sizeBytes} B</span> : null}
              {entry.reason ? <span className="fm-muted">{entry.reason}</span> : null}
            </label>
          ))}
        </div>
      ) : candidates ? <div className="fm-muted">No ignored files in this checkout.</div> : null}
      <textarea value={paths} onChange={(event) => { setPaths(event.target.value); setManifest(null); }} placeholder={"One relative path per line, e.g. config/local.json"} style={{ width: "100%", minHeight: 54, font: "inherit", fontSize: 12 }} />
      <div className="fm-row">
        <button type="button" className="fm-btn" disabled={!projectId || !threadId || !paths.trim()} onClick={() => void preview()}>Preview</button>
        <button type="button" className="fm-btn" disabled={!manifest || !target || manifest.files.length === 0} onClick={() => void apply()}>Copy {manifest?.files.length ?? 0} file(s)</button>
        <button type="button" className="fm-btn" disabled={!requestId || !target} onClick={() => void check()}>Check status</button>
      </div>
      {manifest ? (
        <table className="fm-table">
          <tbody>
            {manifest.files.map((file) => <tr key={file.path}><td>{file.path}</td><td>{file.sizeBytes} B</td><td className="fm-muted">{file.sha256.slice(0, 12)}</td></tr>)}
            {manifest.refused.map((entry) => <tr key={entry.path}><td>{entry.path}</td><td colSpan={2} className="fm-muted">refused: {entry.reason}</td></tr>)}
          </tbody>
        </table>
      ) : null}
      {target ? <div className="fm-muted">Destination: {target.machineKey} project {target.projectId}, environment {target.environmentId}. Caps: 1 MiB per file, 8 MiB total; .env files, keys and credentials are never copied.</div> : null}
      {status ? <div className="fm-muted">{status}</div> : null}
    </div>
  );
}

export function FleetManagement({ localMachine, machines, threadsByMachine = {} }: { localMachine: string; machines: FleetMachineEntry[]; threadsByMachine?: Record<string, OwnerThread[]> }) {
  const updatesOff = useFeatureOff("F26");
  const metricsOff = useFeatureOff("F77");
  return (
    <div className="fm">
      <style>{STYLE}</style>
      {updatesOff ? null : <UpdatesMatrix />}
      {metricsOff ? null : <LoadMetricsPanel />}
      {machines.map((machine) => <OwnerCard key={machine.id} machine={machine.id} label={machine.label} localMachine={localMachine} threads={threadsByMachine[machine.id] ?? []} />)}
    </div>
  );
}
