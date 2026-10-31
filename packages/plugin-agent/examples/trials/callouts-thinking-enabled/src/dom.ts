import { defineDOMPlugin } from "@nooq/plugins/dom";
import plugin from "./index.ts";
// Add a menu invoking the insertion command and one view using ctx.mountText.
export default defineDOMPlugin({ id: plugin.id, forPlugin: plugin, views: [] });
