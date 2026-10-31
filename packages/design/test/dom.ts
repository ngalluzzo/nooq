/**
 * Registers happy-dom globals for component tests. Imported per file rather
 * than preloaded, so `bun test` at the repo root works without config.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
