// mcp-gating — per-repo MCP enable/disable for OpenCode.
// V2 runs `setup(ctx)`: read a repo-local marker file, then rewrite `disabled` on every
// configured MCP server so only the marker's names come up (fail-closed without a marker).
// The V1 `server` half is an empty hook map so shared config repos stay V1-loadable (>= 1.18.29).
import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID = "mcp-gating";
const DEFAULT_MARKER = ".opencode/mcp.json";

interface MarkerResult {
  file: string | null; // absolute path of the marker that was found, or null when none exists
  names: string[] | null; // server names to enable; null means fail closed (disable every server)
}

/** Marker is `["jira","github"]` or `{"servers":["jira","github"]}`; canonical checkout first. */
function readMarker(ctx: any): MarkerResult {
  const marker =
    typeof ctx?.options?.marker === "string" && ctx.options.marker ? ctx.options.marker : DEFAULT_MARKER;
  const dirs = [ctx?.location?.project?.canonical, ctx?.location?.directory].filter(
    (dir: unknown): dir is string => typeof dir === "string" && dir.length > 0,
  );

  for (const dir of dirs) {
    const file = path.join(dir, marker);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
      return { file, names: list.filter((name: unknown): name is string => typeof name === "string") };
    } catch (error) {
      console.warn(
        `[${PLUGIN_ID}] invalid marker at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { file, names: null };
    }
  }
  return { file: null, names: null };
}

export default {
  id: PLUGIN_ID,
  // V1 half: no-op hook map so OpenCode 1.x (>= 1.18.29) can load this object definition.
  server: async () => ({}),
  /** V2 half: fail closed without a valid marker, then a synchronous transform sets `disabled`
   * per configured server; marker names missing from `mcp.servers` warn and are ignored. */
  setup: async (ctx: any) => {
    const { names } = readMarker(ctx);
    await ctx.mcp.transform((editor: any) => {
      const all: string[] = editor.list().map(([name]: [string, unknown]) => name);
      const desired = new Set<string>(names ?? []);
      for (const name of all) {
        editor.update(name, (server: any) => {
          server.disabled = !desired.has(name);
        });
      }
      for (const name of desired) {
        if (!all.includes(name)) console.warn(`[${PLUGIN_ID}] marker lists unknown server: ${name}`);
      }
    });
  },
};
