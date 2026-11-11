// Preloaded for every test file (bunfig.toml). A scanner fault reads as "widen", so a test that expects a widening would pass
// silently if a helper threw: no test may change the fault count unless it injects a fault on purpose and says so.
import { afterEach, beforeEach, expect } from "bun:test";
import { scannerFaultCount } from "../src/install-closure.ts";

let faultsAtStart = 0;
let faultsAllowed = false;

/** Call at the top of a test that injects a fault. */
export const allowFaults = (): void => {
  faultsAllowed = true;
};

beforeEach(() => {
  faultsAtStart = scannerFaultCount();
  faultsAllowed = false;
});

afterEach(() => {
  if (!faultsAllowed) expect(scannerFaultCount()).toBe(faultsAtStart);
});
