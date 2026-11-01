import { afterEach, beforeEach } from "vitest";
import { resetRpcFlight } from "../src/rpc-flight";

beforeEach(() => {
  resetRpcFlight({ minGapMs: 0 });
});

afterEach(() => {
  resetRpcFlight({ minGapMs: 0 });
});
