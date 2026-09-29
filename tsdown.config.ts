/*
 * @Description: tsdown 打包配置 —— 宿主半（ESM/Node）与浏览器半（__ModuleLoader__ 包装）分别产出
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/tsdown.config.ts
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/** 打包时从 package.json 现读：version 注入「关于」页（见 src/client/build-info.ts），name 决定浏览器 bundle 的 ModuleLoader id。 */
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { name: string; version: string }
const VERSION = PKG.version

/**
 * 浏览器端只能 require 宿主外壳提供的这几个「种子」模块。
 * 其余一切（xterm、本插件代码）都必须打进 bundle，否则运行时 require 会失败。
 * 清单取自 better-sidebar / skill-mcp-panel / dsh-remote 三个现役插件的实测交集。
 */
const CLIENT_SEEDS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives'
]

/**
 * 宿主从 /plugins/<包名>/client.js 下发浏览器 bundle，要求它是一次
 * `window.__ModuleLoader__.load({ id, factory })` 调用：factory 拿到受限的 require，
 * 返回模块导出。这里把 CJS 产物夹在 banner / footer 之间得到该形态。
 * id 必须与 package.json 的 name 一致（宿主按包名核对；对不上会 "loaded without registering" 并让 DSH 启动失败）。
 */
const CLIENT_BANNER = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PKG.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });'
].join('\n')

const CLIENT_FOOTER = ['    return module.exports;', '  }', '});'].join('\n')

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: false,
    clean: false,
    treeshake: true,
    // package.json 的 main 指向 lib/index.js；node 平台默认输出 .mjs，必须显式固定。
    outExtensions: () => ({ js: '.js' }),
    deps: {
      // 原生模块与宿主服务不打包：运行时从 profile 的 node_modules 解析。
      // ssh2 尤其重要 —— 它必须保持可被 createRequire 延迟加载的外部模块。
      neverBundle: ['ssh2', 'ws', 'socks', 'zod', /^node:/, /^@deepseek-ai\//, /^cordis/]
    }
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    define: { __DSHWS_VERSION__: JSON.stringify(VERSION) },
    dts: false,
    clean: false,
    treeshake: true,
    // 固定 .js 扩展名：宿主按 exports["./client"] = ./lib/client.js 取文件。
    outExtensions: () => ({ js: '.js' }),
    deps: {
      neverBundle: CLIENT_SEEDS,
      // tsdown 默认把 package.json dependencies 里的包全部外置。
      // @xterm/* 列在 dependencies 里（给 pnpm 装），但浏览器端没有任何地方提供它们，
      // 必须强制打进来 —— 漏掉的话类型检查和单测全绿，浏览器里 require 直接失败。
      alwaysBundle: [/^@xterm\//]
    },
    outputOptions: {
      banner: CLIENT_BANNER,
      footer: CLIENT_FOOTER
    }
  }
])
