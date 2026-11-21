// Child entry for `takeGhSlotSync`: takes one gh-throttle slot, then exits. Exit 1 on GH_THROTTLE_UNAVAILABLE.
import { takeGhSlot } from "./gh-throttle.mjs";

await takeGhSlot();
