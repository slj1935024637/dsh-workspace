/*
 * @Description: 插件自带图标 —— 不依赖宿主 primitives 的图标导出
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/icons.tsx
 *
 * 为什么自带：DSH 0.1.7 把 primitives 的图标从 `IconPlusOutline16` 这类「尾号」命名
 * 整体改成了 `IconPlusOutlineRegular / Medium`，旧名全部删除。插件若直接引用，
 * 在新版上取到 undefined，渲染时报 "Element type is invalid"；换成新名又会在旧版上坏。
 * 插件只用到 7 个字形，自带 SVG 最省事，也不再受宿主命名变动影响。
 *
 * 描边统一 1.3（对齐宿主 Medium 档），颜色走 currentColor，随所在文字颜色与主题变化。
 */
import type { ReactNode } from 'react'

export interface IconProps {
  size?: number
}

function Svg(props: IconProps & { children: ReactNode }) {
  const size = props.size ?? 16
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg size={props.size ?? 14}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  )
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg size={props.size ?? 14}>
      <path d="M10 3.5L5.5 8l4.5 4.5" />
    </Svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  )
}

export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.5 2.8l2.7 2.7L6 12.7 2.8 13.2l.5-3.2 7.2-7.2z" />
      <path d="M9 4.3l2.7 2.7" />
    </Svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.6 9h6.4l.6-9M6.8 6.8v4M9.2 6.8v4" />
    </Svg>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg size={props.size ?? 14}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6" />
    </Svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}
