# 🦅 xgodo CLI

Sync local project files with [xgodo.com](https://xgodo.com) online IDE — push, pull, status, commit. No more browser copy-paste.

## Quick Start

```bash
# Install
cd ~/projects/xgodo-cli && npm link

# Configure (one-time)
xgodo config
# → Paste your bearer token (from xgodo.com page source or network tab)
# → Project ID (from URL: ?id=69ff69448c276d3bba06c460)
# → Source directory (default: src)

# Push local changes
xgodo push -m "your commit message"

# Check what changed
xgodo status

# Pull remote files
xgodo pull
```

## Config

Per-project `.xgodo.json`:
```json
{
  "token": "eyJhbG...",
  "projectId": "69ff69448c276d3bba06c460",
  "source": "src"
}
```

Or global `~/.xgodo.json` (applies to all projects).

### How to get your token

1. Open xgodo.com in your browser
2. Open DevTools → Network tab
3. Look for requests to `/server/api/v1/` 
4. Copy the `Authorization: Bearer` header value
5. Or: check page source for `"token"` in the inline script

## Commands

| Command | Description |
|---------|-------------|
| `xgodo config` | Set up project config |
| `xgodo push -m "msg"` | Push local files + commit |
| `xgodo pull` | Download remote files |
| `xgodo status` | Show diff (new/modified/deleted) |
| `xgodo help` | Show help |

## How It Works

xodo uses the xgodo.com `/server/api/v1/automation-project/{id}` API:

- `GET /files` — list all files
- `GET /file?path=...` — read file content  
- `PUT /file` — create/update file (auto-compiles `.ts` → `.js`)
- `DELETE /file?path=...` — delete file
- `POST /git/commit` — commit changes

All requests use Bearer token auth. The CLI walks your local directory, diffs against remote, uploads/deletes as needed, then commits.

## Ignoring Files

By default, `.git`, `node_modules`, etc. are ignored. Create a `.xgodoignore` file for custom patterns:

```
*.log
dist/
secrets.json
```

## Example Workflow

```bash
# Develop locally
vim src/main.ts
vim src/auth/LoginStage.ts

# Check what changed
xgodo status

# Push to xgodo
xgodo push -m "fix: update login flow validation"
```

That's it. Your files are now on xgodo.com with the commit recorded.
