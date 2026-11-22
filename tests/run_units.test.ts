import { describe, expect, it } from "vitest";

import { parse_run_unit_settings, run_unit, RunUnitConfigError } from "../src/agent/tasks.ts";

describe("run unit settings", () => {
  it("reads the slice and the properties the module writes", () => {
    expect(parse_run_unit_settings({ slice: "nix-work.slice", properties: { OOMScoreAdjust: "500", UMask: "0077" } })).toEqual({
      slice: "nix-work.slice",
      properties: { OOMScoreAdjust: "500", UMask: "0077" },
    });
    expect(parse_run_unit_settings({ slice: null, properties: {} })).toEqual({ slice: undefined, properties: {} });
  });

  it("refuses settings that are not an object, a slice that is not a slice's name, or properties that are not strings", () => {
    expect(() => parse_run_unit_settings([])).toThrow(RunUnitConfigError);
    expect(() => parse_run_unit_settings({ slice: "nix-work.service" })).toThrow(/slice unit's name/);
    expect(() => parse_run_unit_settings({ slice: "a b.slice" })).toThrow(/slice unit's name/);
    expect(() => parse_run_unit_settings({ properties: { OOMScoreAdjust: 500 } })).toThrow(/map names to strings/);
  });
});

describe("run units", () => {
  it("starts and stops units named for X-Nix through sudo, and hands the run the agent's environment without systemd's own", () => {
    const unit = run_unit({ slice: "nix-work.slice", properties: { Nice: "19" } }, {
      PATH: "/run/wrappers/bin",
      HOME: "/var/lib/x-nix-agent",
      INVOCATION_ID: "abc",
      CREDENTIALS_DIRECTORY: "/example/agent",
      NOTIFY_SOCKET: "/example/notify",
      UNSET: undefined,
    });
    expect(unit).toEqual({
      prefix: "x-nix-run",
      slice: "nix-work.slice",
      properties: { Nice: "19" },
      environment: { PATH: "/run/wrappers/bin", HOME: "/var/lib/x-nix-agent" },
      start_command: ["sudo", "-n", "systemd-run"],
      stop_command: ["sudo", "-n", "systemctl", "stop"],
    });
  });
});
