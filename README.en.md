# dsh-workspace

[简体中文](./README.md) | English

A remote workspace plugin for DeepSeek Harness (DSH). It manages SSH hosts inside DSH, opens remote terminals, lets you browse and edit remote files and inspect remote Git, and adds remote directories as workspaces, so the Agent's file operations and commands run on the remote machine.

## Features

- **Host management**: nested groups, group defaults inheritance, jump host chains, SOCKS5 / HTTP proxies; host key fingerprints are recorded on first connect (TOFU) and changes are blocked afterwards
- **Credential vault**: passwords, private keys and other secrets are encrypted with a master password (AES-256-GCM + scrypt) and stored locally; optional "remember on this machine" auto-unlock (protected by DPAPI on Windows)
- **SSH terminal**: interactive terminal shared between the page and the sidebar, with automatic reconnect
- **Remote files**: file tree, Monaco editor (syntax highlighting, Ctrl+S to save, conflict detection), Markdown / HTML / image preview, upload and download, context menu (rename / copy / paste / copy path)
- **Remote Git**: changes (stage / discard / commit), diff, commit history with a branch graph; view any branch, and edit and commit to local branches without checking them out
- **Add workspace**: takes over DSH's "Add workspace" dialog, letting you pick a local folder (quick places + drives) or a folder on a remote host (grouped by host group)
- **Remote Agent tools**: in a remote workspace session, the Agent's read / write / edit / glob / grep / bash run on the remote host; local sessions are unaffected

## Requirements

| Requirement | Notes |
| --- | --- |
| DSH | `>= 0.1.5-rc.2` (both 0.1.x and 0.2.x; developed against DSH Desktop 2.0.16 / host 0.2.0-rc.1) |
| Node.js | `>= 20` |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (npm package `dsh-better-sidebar`) | **The sidebar features depend on this plugin** (remote files, remote Git and SSH terminal in the right sidebar). Install and enable it first |

## Installation

### 1. Install the sidebar plugin first

```bash
dsh plugin --profile <profile> add dsh-better-sidebar
```

### 2. Install dsh-workspace

Install the latest version from npm (the command carries no version number and always resolves to the newest release):

```bash
dsh plugin --profile <profile> add @yh4922/dsh-workspace
```

You can also install the latest package from [Releases](https://github.com/yh4922/dsh-workspace/releases), or download it and install from a local path (that file name contains the version):

```bash
dsh plugin --profile <profile> add https://github.com/yh4922/dsh-workspace/releases/latest/download/dsh-workspace.tgz
dsh plugin --profile <profile> add /path/to/yh4922-dsh-workspace-<version>.tgz
```

- `<profile>` is the profile to install into, e.g. `web`
- **Upgrading**: run `dsh plugin --profile <profile> remove @yh4922/dsh-workspace` first, then install with the command above. Installing the same package or URL again leaves the dependency value unchanged, so the plugin manager rolls the change back with "Which package was installed cannot be told from the dependency change."
- **Coming from 0.7.7 or earlier**: the package name was `dsh-workspace` back then — run `dsh plugin --profile <profile> remove dsh-workspace` before installing the new name, otherwise both packages stay installed and the old code keeps running
- **DSH Desktop**: the `desktop` profile cannot be managed from the CLI; use "Plugin manager" → "Add plugin" and enter `@yh4922/dsh-workspace` or the URL above. Upgrading means removing the plugin and adding it again — the plugin manager has no "Update" button
- This plugin depends on `ssh2`, which has native build scripts. If pnpm blocks them, click "Allow these scripts and retry" in the plugin manager; on the CLI, approve `ssh2` and `cpu-features` when prompted
- Installing directly from the Git repository URL does not work: the repository does not contain build output (`lib/`)

### Uninstall

```bash
dsh plugin --profile <profile> remove dsh-workspace
```

> Uninstalling or upgrading this plugin while DSH Desktop is running has crashed DSH before. Quit DSH first.

## Usage

1. Open "Remote workspace" from the left sidebar and set a master password on first use
2. Create a host (optionally in a group) and click "Test connection"
3. Use the Hosts / Files / Terminals / Connection log tabs to manage hosts, browse files and open terminals
4. Click DSH's "Add workspace" ("Take over Add workspace" in the Settings tab must be on; it is on by default), pick a remote host and folder to create a remote workspace
5. In a remote workspace session, open "Remote files", "Remote Git" and "SSH terminal" from the right sidebar
6. The Settings tab also has the auto-unlock switch, version info and links such as the [changelog](./CHANGELOG.md) (in Chinese)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- Integration tests against real hosts are skipped by default; set `DSHWS_IT=1` and provide the test host through environment variables, then run `pnpm test:it`
- The build scripts (`scripts/`) are not in the repository yet, so a fresh clone cannot run the full `pnpm build`

### Packaging and releasing

| Command | Purpose |
| --- | --- |
| `npm run pack:dev` | Development package: version is "next patch-dev.timestamp", kept only in the local `pack/`; `package.json` is not changed and nothing is pushed |
| `npm run release -- [patch\|minor\|major]` | Release: bump the version, finalize the "未发布" (Unreleased) section of `CHANGELOG.md`, build and pack, commit and push the tag, create a GitHub Release with the package attached, and publish the same package to npm |
| `npm run release -- --dry-run --allow-dirty` | Rehearsal: checks, builds and packs only (no npm publish, nothing committed or pushed); files are restored afterwards |

Before releasing: be on `main` with no uncommitted changes, in sync with the remote, with the release notes written under "未发布", and with `npm login` done on this machine (publishing goes to `registry.npmjs.org`; without a login the release fails at the pre-flight checks).

## Security

- Credentials are stored only on this machine, encrypted with the master password; the master password itself is never written to disk
- The system prompt of remote workspace sessions tells the Agent not to commit, push, `reset --hard` or rebase unless the user explicitly asks
- Remote commands are not confined by the local sandbox; in read-only sandbox mode writes and bash are rejected

## License

MIT
