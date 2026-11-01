// Stands in for @get-bb/plugin-sdk/app when Helper Desk's screens are bundled for a local browser page.
export const definePluginApp = <T,>(app: T) => app;
export const experimental_usePluginId = () => "helper-desk";
export const useBbContext = () => ({});
export const useBbNavigate = () => () => undefined;
export const useComposer = () => ({});
export const useRealtime = () => undefined;
export const useRpc = () => ({});
export const useSdk = () => ({});
export const useSettings = () => ({ values: { companion: true, autoHide: false, hideDelaySeconds: 8 } });
