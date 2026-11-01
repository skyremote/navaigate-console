// bb.host artifact: the fleet-mirror provider bridge (mirror/bridge.ts) and a
// host entry that reports this machine's opaque hardware identity.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { defaultExec, opaqueHardwareId, rawHardwareId } from "./owner/capabilities";
import { hostIdentityContract } from "./owner/host-identity";

export { experimental_providerBridge } from "./mirror/bridge";

export default experimental_defineHostEntry({
  contract: hostIdentityContract,
  handlers: {
    host_identity_get: async () => ({ hardwareId: opaqueHardwareId(await rawHardwareId(defaultExec)), os: process.platform }),
  },
});
