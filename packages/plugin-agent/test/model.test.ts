import { expect, test } from "bun:test";
import { isolated } from "./isolated.ts";

test("Pi actually sends thinking off and the token bound to the local endpoint", async () => {
  const result = await isolated<{ stopReason: string; payload: any }>('import {probe} from "./model-probe.ts"; console.log(JSON.stringify(await probe()));', null);
  expect(result.stopReason).toBe("stop");
  expect(result.payload.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(result.payload.max_tokens).toBe(8192);
});
