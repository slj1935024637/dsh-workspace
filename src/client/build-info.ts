/*
 * @Description: 构建信息 —— 版本号由 tsdown 在打包时注入（define），以及项目主页相关链接
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/build-info.ts
 */

/** 打包时替换为 package.json 的 version；单测 / 未经打包时不存在。 */
declare const __DSHWS_VERSION__: string | undefined

export const VERSION: string = typeof __DSHWS_VERSION__ === 'string' ? __DSHWS_VERSION__ : 'dev'

export const REPO_URL = 'https://github.com/yh4922/dsh-workspace'

/** 「关于」里的链接：均指向 GitHub 仓库里对应的位置。 */
export const LINKS = {
  repo: REPO_URL,
  changelog: `${REPO_URL}/blob/main/CHANGELOG.md`,
  readme: `${REPO_URL}#readme`,
  issues: `${REPO_URL}/issues`,
  releases: `${REPO_URL}/releases`
} as const
