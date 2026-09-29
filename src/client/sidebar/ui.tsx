/*
 * @Description: 远程文件 / 远程 Git 共用的小图标与小部件（统一的线性 SVG，替代 emoji 与字符图标）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/ui.tsx
 *
 * 为什么不用 emoji：📁📄🏷 在不同系统字体下大小、基线、颜色都不一致（无头浏览器里 🏷 直接显示不出来），
 * 与 DSH 界面的线性图标风格也不搭。这里统一用 16×16 视框、1.3 线宽、currentColor 的 SVG。
 */
import type { ReactNode } from 'react'

type IconProps = { size?: number; className?: string }

function Svg(props: IconProps & { children: ReactNode; fill?: string }) {
  const s = props.size ?? 16
  return (
    <svg
      className={props.className ?? 'dshws-ico'}
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill={props.fill ?? 'none'}
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  )
}

export const IconChevron = (p: IconProps & { open?: boolean }) => (
  <Svg {...p} className={`dshws-ico dshws-chevron${p.open === true ? ' is-open' : ''}`}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
)
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.46-3.54" />
    <path d="M13 3v2.5h-2.5" />
  </Svg>
)
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 4L5.5 8l4 4" />
  </Svg>
)
export const IconEye = (p: IconProps & { off?: boolean }) => (
  <Svg {...p}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.8" />
    {p.off === true ? <path d="M2.5 13.5l11-11" /> : null}
  </Svg>
)
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)
export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8h9" />
  </Svg>
)
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 6.5H10a3 3 0 0 1 0 6H6.5" />
    <path d="M7 4L4.5 6.5 7 9" />
  </Svg>
)
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="3.5" r="1.5" />
    <circle cx="5" cy="12.5" r="1.5" />
    <circle cx="11" cy="5.5" r="1.5" />
    <path d="M5 5v6M11 7c0 2.5-6 1.8-6 4" />
  </Svg>
)
export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
    <circle cx="5.5" cy="5.5" r="1" />
  </Svg>
)
export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12.5h7a2.8 2.8 0 0 0 .3-5.6A4 4 0 0 0 4.1 7.6 2.5 2.5 0 0 0 4.5 12.5z" />
  </Svg>
)
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
    <path d="M4.5 6.2L6.8 8l-2.3 1.8M8.5 10h3" />
  </Svg>
)
export const IconServer = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1.3" />
    <rect x="2" y="9" width="12" height="4.5" rx="1.3" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" strokeWidth={2} />
  </Svg>
)
export const IconPulse = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 8.5h3l1.8-4.5 3 8 1.9-5h3.3" />
  </Svg>
)
export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
    <path d="M9 4l3 3" />
  </Svg>
)
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.4} />
  </Svg>
)
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />
  </Svg>
)

/** 图钉：设为本会话默认查看的分支；filled = 已设为默认。 */
export const IconPin = (p: IconProps & { filled?: boolean }) => (
  <Svg {...p} fill={p.filled === true ? 'currentColor' : 'none'}>
    <path d="M9.8 1.8l4.4 4.4-1.7.6-2.6 2.6.2 3-1.3 1.3-2.4-2.4-3.2 3.2M6.3 10.6l-2.4-2.4 1.3-1.3 3 .2 2.6-2.6.6-1.7z" />
  </Svg>
)
export const IconCommit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M1.5 8h4M10.5 8h4" />
  </Svg>
)
export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
    <path d="M9 1.8V5.2h3.5" />
  </Svg>
)
export const IconSubmodule = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1" />
  </Svg>
)

export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Svg>
)
export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 7.2L8 2.5l5.5 4.7M4 6v7.5h8V6" />
    <path d="M6.5 13.5V10h3v3.5" />
  </Svg>
)
export const IconDrive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="4" width="12.4" height="8" rx="1.6" />
    <path d="M4.5 9.5h.01M7 9.5h4.5" strokeWidth={1.5} />
  </Svg>
)
export const IconDesktop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.4" />
    <path d="M5.5 13.5h5M8 11v2.5" />
  </Svg>
)
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" />
  </Svg>
)
export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
    <path d="M6 8h4.5M6 10.5h4.5" />
  </Svg>
)
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" />
  </Svg>
)
export const IconFolderPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.8 4.2c0-.6.4-1 1-1h3l1.4 1.5h6c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" />
    <path d="M8 7.2v3.6M6.2 9h3.6" />
  </Svg>
)

/** 文件夹（实心，便于在长列表里一眼区分目录与文件）。 */
export const IconFolder = (p: IconProps & { open?: boolean }) => (
  <svg className="dshws-ico dshws-ico-folder" width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" aria-hidden="true">
    {p.open === true ? (
      <path d="M1.5 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.3c.6 0 1 .4 1 1v1H4.3c-.5 0-.9.3-1 .8L1.5 12.3z M3.4 7.3h11.3l-1.6 5.5H1.8z" fill="currentColor" />
    ) : (
      <path d="M1.5 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h6.3c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.5c-.6 0-1-.4-1-1z" fill="currentColor" />
    )}
  </svg>
)

/** 按扩展名给文件图标着色（颜色取常见编辑器的约定，只是辅助辨认，不承载含义）。 */
const EXT_COLOR: Array<[RegExp, string]> = [
  [/\.(ts|tsx|mts|cts)$/i, '#3178c6'],
  [/\.(js|jsx|mjs|cjs)$/i, '#d8a200'],
  [/\.(json|jsonc|ya?ml|toml|ini|conf|env)$/i, '#c28b1d'],
  [/\.(md|mdx|markdown|txt|rst)$/i, '#5b8def'],
  [/\.(html?|vue|svelte)$/i, '#e2572c'],
  [/\.(css|scss|less|sass)$/i, '#8b5cf6'],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i, '#16a34a'],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/i, '#22a06b'],
  [/\.(py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift)$/i, '#2f80c9'],
  [/\.(lock|log)$/i, '#8a8f98'],
  [/^(Dockerfile|Makefile|\.gitignore|\.dockerignore|\.editorconfig)$/i, '#8a8f98']
]

export function fileColor(name: string): string | undefined {
  for (const [re, color] of EXT_COLOR) if (re.test(name)) return color
  return undefined
}

export function FileIcon(props: { name: string; size?: number }) {
  const color = fileColor(props.name)
  return (
    <span className="dshws-file-ico" style={color !== undefined ? { color } : undefined}>
      <IconFile size={props.size ?? 15} />
    </span>
  )
}

/** 图标按钮：统一尺寸、悬停底色、无障碍标题。 */
export function IconButton(props: { title: string; onClick(): void; disabled?: boolean; children: ReactNode; tone?: 'danger'; active?: boolean }) {
  return (
    <button
      type="button"
      className="dshws-ibtn"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      data-tone={props.tone}
      data-active={props.active}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    >
      {props.children}
    </button>
  )
}

/** git 状态字母徽标（M 修改 / A 新增 / D 删除 / R 重命名 / U 未跟踪 / C 复制 / ! 冲突）。 */
export function StatusBadge(props: { s: string }) {
  const s = props.s === '?' ? 'U' : props.s
  return (
    <span className="dshws-st" data-s={s}>
      {s}
    </span>
  )
}

/** 空状态：图标 + 一句话（替代孤零零的一行灰字）。 */
export function EmptyState(props: { icon?: ReactNode; text: string }) {
  return (
    <div className="dshws-emptystate">
      {props.icon ?? null}
      <span>{props.text}</span>
    </div>
  )
}
