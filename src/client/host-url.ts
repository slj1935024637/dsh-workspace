/*
 * @Description: 桌面版运行环境探测 —— 宿主服务地址与渲染进程判断
 * @Author: YangHeng
 * @Date: 2026-09-30 11:10:00
 * @FilePath: /dsh-workspace/src/client/host-url.ts
 *
 * DSH NEXT（macOS 实测）的页面由自定义协议 dsh-app://app 提供，前端启动时写入
 * `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }`。两类请求要区别对待：
 * - HTTP（上传 / 下载 / 预览路由 / 图片）：必须用页面同源的相对地址。Electron 把同源请求转发给宿主并附上
 *   渲染进程令牌；直连 streamBaseUrl 的 http 地址拿不到令牌，会被拒（Browser access is disabled）。
 * - WebSocket：自定义协议不能升级，必须连 streamBaseUrl（宿主自己的流通道也这么取，见 terminal/link.ts）。
 */

/** 宿主注入的服务地址（桌面版才有；网页版为 undefined）。只给 WebSocket 用。 */
export function hostStreamBaseUrl(): string | undefined {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__
  return typeof transport?.streamBaseUrl === 'string' && transport.streamBaseUrl !== '' ? transport.streamBaseUrl : undefined
}

/**
 * 是否运行在 DSH 桌面版的渲染进程里（preload 注入 window.dshDesktop，各平台都有）。
 * 桌面版只给主框架的同源请求附令牌；沙箱 iframe（不透明来源）里的请求会被拒，
 * 预览需要走远程调用 + 内联（见 sidebar/inline-preview.ts）。
 */
export function isDesktopRenderer(): boolean {
  const g = globalThis as { dshDesktop?: unknown; __DSH_TRANSPORT__?: { ownsHost?: unknown } }
  return (typeof g.dshDesktop === 'object' && g.dshDesktop !== null) || g.__DSH_TRANSPORT__?.ownsHost === true
}
