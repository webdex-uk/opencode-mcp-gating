# opencode-mcp-gating

A zero-dependency [OpenCode](https://opencode.ai) plugin that gates MCP servers per repository. Each repo ships a tiny marker file (`.opencode/mcp.json`) naming the MCP servers it needs; every other server is disabled before OpenCode connects to anything. Fail-closed by design: no marker or an unreadable marker means no MCP servers at all.

## Why this exists

OpenCode 2 dropped the V1 "enabled marker" MCP pattern. During config normalization, enabled-only MCP entries are ignored with a warning, a partial `{"disabled": false}` override is schema-invalid, and config merging replaces server objects wholesale — so per-repo toggles either repeat the full server object in every repo, or need a plugin. This plugin restores the lightweight pattern: the base config defines every server once (with `"disabled": true`), and each repo ships only a marker file listing the server names it wants.

## Requirements

- OpenCode 2.x for the gating behavior.
- On OpenCode 1.x (≥ 1.18.29), the plugin loads as a no-op (`server` returns an empty hook map), so a shared config repo stays V1-safe.

## Install

Add the package to the `plugins` array in `opencode.json(c)` (the V2 spelling; the V1 `plugin` key is normalized):

```jsonc
{
  "plugins": ["github:webdex-uk/opencode-mcp-gating"]
}
```

With plugin options, use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "github:webdex-uk/opencode-mcp-gating",
      "options": { "marker": ".config/mcp-servers.json" }
    }
  ]
}
```

Alternatively, drop `plugin.ts` into a config dir's `plugins/` folder (`~/.config/opencode/plugins/` or `<project>/.opencode/plugins/`); files in those folders are auto-discovered.

## Usage

In each repository, create `.opencode/mcp.json`:

```json
["jira", "github"]
```

or equivalently:

```json
{ "servers": ["jira", "github"] }
```

Rules:

- Server names must match keys under `mcp.servers` in your OpenCode config.
- No marker or invalid JSON ⇒ every MCP server stays disabled (fail-closed). Invalid JSON logs a `console.warn`.
- Names that do not match a configured server log a `console.warn` and are ignored.
- The marker is read from the project canonical checkout first, then from the working directory.
- Restart OpenCode (or run `opencode reload`) after changing the marker.

## Recommended base config

Define all servers under `mcp.servers` with `"disabled": true`, so this plugin is the only thing that enables them — if the plugin ever fails to load, every server stays off:

```jsonc
{
  "mcp": {
    "servers": {
      "jira": { "type": "remote", "url": "https://mcp.atlassian.com/v1/mcp/authv2", "disabled": true },
      "github": { "type": "remote", "url": "https://api.githubcopilot.com/mcp/", "disabled": true }
    }
  }
}
```

Keep the `mcp.servers` form: the flat V1 `mcp: { "<name>": { ... } }` form silently drops `"disabled": true` during normalization and therefore fails open.

## Options

- `marker` — path to the marker file, relative to each project directory. Default: `.opencode/mcp.json`.

## How it works

At plugin load (once per project location), the plugin reads the marker once, then runs a synchronous `ctx.mcp.transform` callback that lists the configured servers and sets `disabled` on each one. OpenCode reconciles the MCP server lifecycle from the transformed configuration.

## Compatibility

Tested against OpenCode v2.0.29. Uses the V2 plugin API: `ctx.location`, `ctx.options`, and `ctx.mcp.transform`.

## License

MIT
