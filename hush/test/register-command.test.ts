import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("registration command", () => {
  it("optionally loads the root env without overriding exported values", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: { register: string } };
    expect(packageJson.scripts.register).toBe(
      "node --env-file-if-exists=../.env --import tsx scripts/register.ts"
    );

    const directory = await mkdtemp(join(tmpdir(), "hush-register-env-"));
    const envFile = join(directory, ".env");
    await writeFile(envFile, "HUSH_REGISTER_TEST=from-file\n", "utf8");
    const printValue =
      "process.stdout.write(process.env.HUSH_REGISTER_TEST ?? '')";

    const loaded = await execFileAsync(
      process.execPath,
      [`--env-file-if-exists=${envFile}`, "--eval", printValue],
      { env: {} }
    );
    expect(loaded.stdout).toBe("from-file");

    const exported = await execFileAsync(
      process.execPath,
      [`--env-file-if-exists=${envFile}`, "--eval", printValue],
      { env: { HUSH_REGISTER_TEST: "exported" } }
    );
    expect(exported.stdout).toBe("exported");
  });
});
