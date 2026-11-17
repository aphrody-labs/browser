// After an edit: format the file with the native formatter when it is TypeScript, JSON or HTML under tools/ or .claude/.
// Reads the hook payload on stdin; never fails the edit.
const input = (await Bun.stdin.json().catch(() => null)) as { tool_input?: { file_path?: string } } | null;
const path = input?.tool_input?.file_path?.replaceAll("\\", "/");
if (path && /\/(tools|\.claude)\/.+\.(ts|json|html)$/.test(path) && !path.includes("/upstream/"))
  await Bun.spawn(["bun", "fmt", path], { stdout: "ignore", stderr: "ignore" }).exited;
