/*
 * @Description: dsh-client-ui-primitives 的类型声明（该包未发布 .d.ts）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/primitives.d.ts
 *
 * props 取自 lib/index.js 中组件实际解构的参数，只声明本插件用到的部分。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactNode } from 'react'

  export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
    variant?: 'ghost' | 'primary' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  }
  export const Button: ComponentType<ButtonProps>

  export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    icon?: ReactNode
  }
  export const Input: ComponentType<InputProps>

  export interface ModalProps {
    open: boolean
    onClose: () => void
    title?: string
    closeLabel?: string
    description?: ReactNode
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }
  export const Modal: ComponentType<ModalProps>

  export interface SwitchProps {
    checked: boolean
    onChange: (next: boolean) => void
    label?: string
    disabled?: boolean
    title?: string
    className?: string
  }
  export const Switch: ComponentType<SwitchProps>

  export interface StateDotProps {
    state: 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
    size?: number
    className?: string
  }
  export const StateDot: ComponentType<StateDotProps>

  export interface ToastProps {
    text: ReactNode
    icon?: ReactNode
    anchor?: HTMLElement | null
    holdMs?: number
    onDone: () => void
  }
  export const Toast: ComponentType<ToastProps>

  export type MenuEntry =
    | { id: string; label: string; icon?: ReactNode; disabled?: boolean; danger?: boolean }
    | { type: 'separator' }
    | { type: 'label'; text: string }

  export interface MenuProps {
    open: boolean
    anchor: ReactNode
    items: MenuEntry[]
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
  }
  export const Menu: ComponentType<MenuProps>

  /*
   * 刻意不声明任何 Icon* 导出：图标命名在 0.1.5 → 0.1.7 之间整体改过一次
   * （IconPlusOutline16 → IconPlusOutlineRegular/Medium，旧名删除），
   * 插件改用 src/client/icons.tsx 自带图标。这里不声明，
   * 任何人再从 primitives 引用图标都会在编译期报错，而不是到浏览器里才崩。
   */
}
