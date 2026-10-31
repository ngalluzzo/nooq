import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/**
 * The sandbox gates run candidate code under macOS `sandbox-exec`. That
 * binary is denied inside some CI and local environments (sandbox_apply
 * EPERM, exit 71) — the same environment-gating pattern as the EB lab's
 * NQ_LAB: when the capability is absent, these tests skip rather than lie.
 */
const probe = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8" });
export const sandboxAvailable: boolean = probe.status === 0;

export const skipWithoutSandbox = <T extends Record<string, unknown>>(suite: T): T | Record<string, unknown> =>
  sandboxAvailable ? suite : {};

void expect;
void test;
