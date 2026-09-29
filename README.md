# dsh-workspace

简体中文 | [English](./README.en.md)

DeepSeek Harness（DSH）的远程工作区插件：在 DSH 里管理 SSH 主机，打开远程终端、浏览和编辑远程文件、查看远程 Git，并把远程目录添加为工作区，让 Agent 的读写和命令都作用在远程机器上。

## 功能

- **主机管理**：多层分组、组默认值继承、跳板机链、SOCKS5 / HTTP 代理；首次连接记录主机指纹（TOFU），之后指纹变化会拦截
- **凭据保险箱**：密码、私钥等敏感字段用主密码加密（AES-256-GCM + scrypt）后保存在本机；可选「在本机记住」自动解锁（Windows 用 DPAPI 保护）
- **SSH 终端**：交互式终端，页面与侧边栏共用同一会话，断线自动重连
- **远程文件**：目录树、Monaco 编辑器（语法高亮、Ctrl+S 保存、冲突检测）、Markdown / HTML / 图片预览、上传下载、右键菜单（重命名 / 复制 / 粘贴 / 复制路径）
- **远程 Git**：改动（暂存 / 放弃 / 提交）、diff、带分叉图的提交历史；可查看任意分支，本地分支不检出也能直接修改和提交
- **添加工作区**：接管 DSH 的「添加工作区」弹窗，可选本机目录（快捷位置 + 盘符）或远程主机目录（按分组展示）
- **远程 Agent 工具**：远程工作区会话里，Agent 的 read / write / edit / glob / grep / bash 都在远程主机上执行，本地会话不受影响

## 依赖

| 依赖 | 说明 |
| --- | --- |
| DSH | `>= 0.1.5-rc.2`（开发基于 DSH Desktop 2.0.15 / 宿主 0.1.7-rc.2） |
| Node.js | `>= 20` |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（npm 包 `dsh-better-sidebar`） | **侧边栏相关功能依赖这个插件**（右侧栏里的远程文件、远程 Git、SSH 终端）。请先安装并启用它 |

## 安装

### 1. 先安装侧边栏插件

```bash
dsh plugin --profile <profile> add dsh-better-sidebar
```

### 2. 安装 dsh-workspace

从 npm 安装最新版（命令不带版本号，自动装最新一版）：

```bash
dsh plugin --profile <profile> add @yh4922/dsh-workspace
```

也可以装 [Releases](https://github.com/yh4922/dsh-workspace/releases) 里的最新安装包，或下载后用本地路径安装（文件名带版本号）：

```bash
dsh plugin --profile <profile> add https://github.com/yh4922/dsh-workspace/releases/latest/download/dsh-workspace.tgz
dsh plugin --profile <profile> add /path/to/yh4922-dsh-workspace-<版本>.tgz
```

- `<profile>` 是要安装到的 profile，例如 `web`
- **升级**：先 `dsh plugin --profile <profile> remove @yh4922/dsh-workspace`，再用上面的命令安装。对同一个包/地址再装一次时，插件管理器判断不出这次装的是哪个包（依赖值没有变化），会回滚并提示「无法从依赖变更中确定安装了哪一个包」
- **0.7.7 及更早版本的用户**：当时的包名是 `dsh-workspace`，请先 `dsh plugin --profile <profile> remove dsh-workspace` 再装新包名；否则会同时存在两个包，运行的仍是旧代码
- **DSH Desktop**：`desktop` profile 不能用命令行管理，请在「插件管理」→「添加插件」里填入 `@yh4922/dsh-workspace` 或上面的地址；升级同样是先移除、再添加（插件管理里没有「更新」按钮）
- 本插件依赖 `ssh2`，其中有原生构建脚本。pnpm 拦下构建时，在插件管理的失败界面点「允许这些脚本并重试」；命令行安装则按提示放行 `ssh2`、`cpu-features`
- 不能直接从 Git 仓库地址安装：仓库里没有编译产物（`lib/`）

### 卸载

```bash
dsh plugin --profile <profile> remove dsh-workspace
```

> 在 DSH Desktop 运行时卸载或升级本插件，曾导致 DSH 崩溃。建议先退出 DSH 再操作。

## 使用

1. 左侧栏打开「远程工作区」，第一次使用时设置主密码
2. 新建主机（可以放进分组），点「测试连接」确认能连上
3. 在「主机 / 文件 / 终端 / 连接日志」几个页签里管理主机、浏览文件、打开终端
4. 点 DSH 的「添加工作区」（「全局配置」页签里的「接管『添加工作区』」需开启，默认开启），选择远程主机和目录，即可创建远程工作区
5. 在远程工作区会话里，右侧栏可以打开「远程文件」「远程 Git」「SSH 终端」
6. 「全局配置」页签里还有自动解锁开关，以及版本信息、[更新日志](./CHANGELOG.md)等链接

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- 真机集成测试默认跳过，设置 `DSHWS_IT=1` 并通过环境变量提供测试主机后运行 `pnpm test:it`
- 目前构建脚本（`scripts/`）没有放进仓库，单独克隆后暂时不能完整执行 `pnpm build`

### 打包与发布

| 命令 | 用途 |
| --- | --- |
| `npm run pack:dev` | 开发调试包：版本号为「下一个 patch-dev.时间戳」，只放在本机 `pack/`，不改 `package.json`、不推送 |
| `npm run release -- [patch\|minor\|major]` | 正式发布：累加版本号，把 `CHANGELOG.md` 的「未发布」定稿为新版本，构建打包，提交并推送 tag，创建附带安装包的 GitHub Release，并把同一个包发布到 npm |
| `npm run release -- --dry-run --allow-dirty` | 发布演练：只检查、构建和打包（不发 npm、不提交不推送），结束后还原 |

发布前要求：在 `main` 分支、没有未提交改动、与远程同步，「未发布」下已写好本次的更新日志，且本机已 `npm login`（发布到 `registry.npmjs.org`，未登录会在前置检查阶段直接失败）。

## 安全说明

- 凭据只保存在本机，并用主密码加密；主密码本身不落盘
- 远程工作区会话的系统提示词会要求 Agent：没有用户明确要求时，不执行 commit、push、`reset --hard`、rebase
- 远程命令不受本机沙箱约束，只读沙箱模式下会拒绝写入和 bash

## 许可证

MIT
