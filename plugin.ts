// mcp-gating — per-repo MCP enable/disable for OpenCode.
// V2 runs `setup(ctx)`: read a repo-local marker file on every transform replay, then rewrite
// `disabled` on every configured MCP server so only the marker's names come up (fail-closed
// without a marker). A poll watcher re-reads the marker and reloads MCP when it changes.
// The V1 `server` half is an empty hook map so shared config repos stay V1-loadable (>= 1.18.29);
// if a V1 host also invokes `setup`, the missing `ctx.mcp.transform` is detected and the plugin
// exits silently — no logs, no watchers.
import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID = "mcp-gating";
const DEFAULT_MARKER = ".opencode/mcp.json";
const WATCH_INTERVAL_MS = 1000;
const RELOAD_DEBOUNCE_MS = 250;

interface MarkerResult {
  file: string | null; // absolute path of the marker that was found, or null when none exists
  names: string[] | null; // server names to enable; null means fail closed (disable every server)
}

/** Project dirs the marker is resolved against: canonical checkout first, then working directory. */
function markerDirs(ctx: any): string[] {
  const dirs = [
    ctx?.location?.project?.canonical,
    ctx?.location?.directory,
  ].filter(
    (dir: unknown): dir is string => typeof dir === "string" && dir.length > 0,
  );
  return [...new Set(dirs)];
}

/** Configured marker path, relative to each project dir. */
function markerOption(ctx: any): string {
  return typeof ctx?.options?.marker === "string" && ctx.options.marker
    ? ctx.options.marker
    : DEFAULT_MARKER;
}

/** Marker is `["jira","github"]` or `{"servers":["jira","github"]}`; canonical checkout first. */
function readMarker(ctx: any): MarkerResult {
  const marker = markerOption(ctx);

  for (const dir of markerDirs(ctx)) {
    const file = path.join(dir, marker);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.servers)
          ? parsed.servers
          : [];
      return {
        file,
        names: list.filter(
          (name: unknown): name is string => typeof name === "string",
        ),
      };
    } catch (error) {
      console.warn(
        `[${PLUGIN_ID}] invalid marker at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { file, names: null };
    }
  }
  return { file: null, names: null };
}

/** True when a watcher tick saw a real change (created, edited, removed) rather than a zeroed ENOENT stat. */
function statChanged(curr: fs.Stats, prev: fs.Stats): boolean {
  const zeroed = (stats: fs.Stats) =>
    stats.mtimeMs === 0 && stats.size === 0 && stats.ino === 0;
  if (zeroed(curr) && zeroed(prev)) return false;
  return (
    curr.mtimeMs !== prev.mtimeMs ||
    curr.size !== prev.size ||
    curr.ino !== prev.ino
  );
}

/** Poll the marker path (and its parent dir, so a marker created after boot is caught even when the
 * dir did not exist yet) and fire one debounced `mcp.reload()` per burst of changes. Returns a
 * cleanup fn that stops the watches and clears the pending timer. */
function watchMarker(ctx: any): () => void {
  const marker = markerOption(ctx);
  const targets = new Set<string>();
  for (const dir of markerDirs(ctx)) {
    const file = path.join(dir, marker);
    targets.add(file);
    targets.add(path.dirname(file));
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const onChange = (curr: fs.Stats, prev: fs.Stats) => {
    if (!statChanged(curr, prev)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const reloaded = ctx?.mcp?.reload?.();
        if (reloaded && typeof reloaded.catch === "function")
          reloaded.catch(() => {});
      } catch {
        // a failed reload must never break the session
      }
    }, RELOAD_DEBOUNCE_MS);
    (timer as { unref?: () => void }).unref?.();
  };

  for (const target of targets) {
    try {
      fs.watchFile(
        target,
        { interval: WATCH_INTERVAL_MS, persistent: false },
        onChange,
      );
    } catch {
      // an unwatchable path must never break plugin setup
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const target of targets) {
      try {
        fs.unwatchFile(target, onChange);
      } catch {
        // ignoring unwatch failures keeps plugin unload quiet
      }
    }
  };
}

export default {
  id: PLUGIN_ID,
  // V1 half: no-op hook map so OpenCode 1.x (>= 1.18.29) can load this object definition.
  server: async () => ({}),
  /** V2 half: fail closed without a valid marker, then a synchronous transform that re-reads the
   * marker on every replay and sets `disabled` per configured server; marker names missing from
   * `mcp.servers` warn and are ignored. Returns a cleanup fn so plugin unload stops the watches. */
  setup: async (ctx: any) => {
    // OpenCode 1.x may load this object and invoke `setup`, but it has no V2 MCP API.
    // Skip silently: no transform, no watchers, no console output.
    if (typeof ctx?.mcp?.transform !== "function") return () => {};

    try {
      await ctx.mcp.transform((editor: any) => {
        const { names } = readMarker(ctx);
        const all: string[] = editor
          .list()
          .map(([name]: [string, unknown]) => name);
        const desired = new Set<string>(names ?? []);
        for (const name of all) {
          editor.update(name, (server: any) => {
            server.disabled = !desired.has(name);
          });
        }
        for (const name of desired) {
          if (!all.includes(name))
            console.warn(`[${PLUGIN_ID}] marker lists unknown server: ${name}`);
        }
      });
    } catch (error) {
      console.warn(
        `[${PLUGIN_ID}] mcp transform failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      return watchMarker(ctx);
    } catch {
      return () => {};
    }
  },
};
