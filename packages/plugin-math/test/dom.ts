import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// KaTeX refuses quirks mode; happy-dom's default document reports it.
// Standards mode is the truthful declaration for every real host.
if (document.compatMode !== "CSS1Compat") {
  Object.defineProperty(document, "compatMode", { configurable: true, get: () => "CSS1Compat" });
}
