import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadWorkspaceLocalEnv, parseDotEnvLocal } from "../src/local-env.js";

describe("tools-pack local env loading", () => {
  it("parses common .env.local assignment forms", () => {
    expect({
      ...parseDotEnvLocal(
        [
          "# comment",
          "OD_CLERK_ISSUER=https://clean-jay-54.clerk.accounts.dev",
          "OD_CLERK_PUBLISHABLE_KEY=pk_test_local # trailing comment",
          "export POSTHOG_KEY=\"phc local\"",
          "POSTHOG_HOST='https://us.i.posthog.com'",
          "BAD-KEY=ignored",
          "",
        ].join("\n"),
      ),
    }).toEqual({
      OD_CLERK_ISSUER: "https://clean-jay-54.clerk.accounts.dev",
      OD_CLERK_PUBLISHABLE_KEY: "pk_test_local",
      POSTHOG_KEY: "phc local",
      POSTHOG_HOST: "https://us.i.posthog.com",
    });
  });

  it("loads workspace .env.local over the parent environment", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));
    await writeFile(
      join(workspaceRoot, ".env.local"),
      ["OD_CLERK_ISSUER=https://from-file.clerk.accounts.dev", "POSTHOG_KEY=phc_from_file"].join("\n"),
    );
    const env: NodeJS.ProcessEnv = { POSTHOG_KEY: "phc_from_parent" };

    const result = loadWorkspaceLocalEnv({ workspaceRoot, env });

    expect(result.loaded).toBe(true);
    expect(env.POSTHOG_KEY).toBe("phc_from_file");
    expect(env.OD_CLERK_ISSUER).toBe("https://from-file.clerk.accounts.dev");
    expect(result.loadedFiles).toEqual([".env.local"]);
    expect(result.keys).toEqual(["OD_CLERK_ISSUER", "POSTHOG_KEY"]);
  });

  it("loads workspace env files in precedence order without overriding higher-priority files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));
    await writeFile(join(workspaceRoot, ".env"), "FROM_BASE=base\nSHARED=base\n");
    await writeFile(join(workspaceRoot, ".env.development"), "FROM_DEV=dev\nSHARED=dev\n");
    await writeFile(join(workspaceRoot, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n");
    await writeFile(join(workspaceRoot, ".env.development.local"), "FROM_DEV_LOCAL=dev-local\nSHARED=dev-local\n");
    const logs: string[] = [];
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({
      workspaceRoot,
      env,
      log: (message) => logs.push(message),
    });

    expect(result.loadedFiles).toEqual([".env.development.local", ".env.local", ".env.development", ".env"]);
    expect(env.FROM_DEV_LOCAL).toBe("dev-local");
    expect(env.FROM_LOCAL).toBe("local");
    expect(env.FROM_DEV).toBe("dev");
    expect(env.FROM_BASE).toBe("base");
    expect(env.SHARED).toBe("dev-local");
    expect(logs).toEqual(["tools-pack env: loaded .env.development.local, .env.local, .env.development, .env"]);
  });

  it("uses explicit env files instead of default env files", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));
    await writeFile(join(workspaceRoot, ".env.local"), "DEFAULT_ONLY=yes\n");
    await writeFile(join(workspaceRoot, "custom.env"), "CUSTOM_ONLY=yes\n");
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({ args: ["--env-file", "custom.env"], workspaceRoot, env });

    expect(result.loadedFiles).toEqual(["custom.env"]);
    expect(env.CUSTOM_ONLY).toBe("yes");
    expect(env.DEFAULT_ONLY).toBeUndefined();
  });

  it("can be disabled with --no-env-file", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));
    await writeFile(join(workspaceRoot, ".env.local"), "SHOULD_NOT_LOAD=yes\n");
    const env: NodeJS.ProcessEnv = {};

    const result = loadWorkspaceLocalEnv({ args: ["--no-env-file"], workspaceRoot, env });

    expect(result.loaded).toBe(false);
    expect(env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it("does not load env files for help output and suppresses logs for json output", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));
    await writeFile(join(workspaceRoot, ".env.local"), "VALUE=yes\n");
    const helpEnv: NodeJS.ProcessEnv = {};

    const helpResult = loadWorkspaceLocalEnv({ args: ["--help"], workspaceRoot, env: helpEnv });

    expect(helpResult.loaded).toBe(false);
    expect(helpEnv.VALUE).toBeUndefined();

    const logs: string[] = [];
    loadWorkspaceLocalEnv({
      args: ["mac", "build", "--json"],
      workspaceRoot,
      env: {},
      log: (message) => logs.push(message),
    });

    expect(logs).toEqual([]);
  });

  it("requires explicitly requested env files to exist", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "od-pack-local-env-"));

    expect(() => loadWorkspaceLocalEnv({ args: ["--env-file", "missing.env"], workspaceRoot, env: {} })).toThrow(
      /env file not found: missing\.env/,
    );
  });
});
