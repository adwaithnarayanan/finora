// PreToolUse hook: require explicit permission for file writes outside the project directory.
import path from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const input = JSON.parse(raw);
const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? input.cwd);
const target = path.resolve(input.cwd ?? projectDir, filePath);
const rel = path.relative(projectDir, target);

if (rel.startsWith("..") || path.isAbsolute(rel)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `${target} is outside the project directory`,
      },
    }),
  );
}
