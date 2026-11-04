import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));

const step = deploy.slice(deploy.indexOf("- name: Deploy this commit"));
const script = step
  .slice(step.indexOf("run: |\n") + 7, step.indexOf("\n        env:"))
  .replace(/^ {10}/gm, "");

function runDeployStep(env: Record<string, string>) {
  const bin = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  try {
    writeFileSync(join(bin, "jq"), "#!/bin/sh\necho '{}'\n");
    writeFileSync(join(bin, "curl"), '#!/bin/sh\necho "$@"\n');
    chmodSync(join(bin, "jq"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);
    return spawnSync("/bin/bash", ["-eo", "pipefail", "-c", script], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:/usr/bin:/bin`,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REPOSITORY_OWNER: "owner",
        GITHUB_SHA: "abc123",
        ...env,
      },
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe("migration-before-deploy gate", () => {
  it("keeps Vercel from deploying main on its own", () => {
    expect(JSON.parse(readFileSync("vercel.json", "utf8"))).toMatchObject({
      git: { deploymentEnabled: { main: false } },
    });
  });

  it("deploys only from main, after verification and integration", () => {
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain("needs: [verify, integration]");
  });

  it("never cancels an in-progress run on main", () => {
    expect(workflow).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  it("fails fast without a migration URL and runs the deploy under pipefail", () => {
    expect(deploy).toContain(
      ': "${MIGRATION_DATABASE_URL:?MIGRATION_DATABASE_URL is not set}"',
    );
    expect(step.startsWith("- name: Deploy this commit to Vercel\n        shell: bash\n")).toBe(true);
  });

  it("applies migrations before deploying", () => {
    const migrate = deploy.indexOf("npm run db:migrate:deploy");
    const vercel = deploy.indexOf("api.vercel.com/v13/deployments");
    expect(migrate).toBeGreaterThan(-1);
    expect(vercel).toBeGreaterThan(migrate);
  });

  it("deploys the exact commit that was migrated, with a request timeout", () => {
    expect(deploy).toContain("sha: $sha");
    expect(deploy).toContain('--arg sha "$GITHUB_SHA"');
    expect(deploy).toContain("--max-time 30");
    expect(deploy).not.toContain("DEPLOY_HOOK");
  });

  it("never gives the Vercel build a migration step", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts["vercel-build"]).toBeUndefined();
    expect(scripts.build).not.toContain("migrate");
  });

  it.each([
    ["VERCEL_TOKEN", { VERCEL_PROJECT_ID: "prj_1" }],
    ["VERCEL_PROJECT_ID", { VERCEL_TOKEN: "token" }],
  ])("fails before calling Vercel when %s is missing", (name, env) => {
    const result = runDeployStep(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${name} is not set`);
    expect(result.stdout).toBe("");
  });

  it("forces a new deployment and keeps teamId optional", () => {
    const base = { VERCEL_TOKEN: "token", VERCEL_PROJECT_ID: "prj_1" };
    const personal = runDeployStep(base);
    expect(personal.status).toBe(0);
    expect(personal.stdout).toContain(
      "https://api.vercel.com/v13/deployments?forceNew=1 ",
    );
    const team = runDeployStep({ ...base, VERCEL_ORG_ID: "team_1" });
    expect(team.status).toBe(0);
    expect(team.stdout).toContain(
      "https://api.vercel.com/v13/deployments?forceNew=1&teamId=team_1 ",
    );
  });
});
