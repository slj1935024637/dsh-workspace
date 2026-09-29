/*
 * @Description: 浏览器端 cordis 上下文的最小结构约束
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/context.ts
 *
 * 客户端宿主服务没有发布类型声明，这里只声明本插件实际用到的面，
 * 避免把 any 渗进业务代码。
 */
import type { ComponentType } from 'react'

export type Disposer = () => void

export interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  /** 单占位插槽里越小越优先（DSH 官方选择器为 0）。 */
  priority?: number
  label?: () => string
  locale?: string
  inject?: () => Record<string, unknown>
}

export interface ClientContext {
  effect(factory: () => Disposer | void, label?: string): Disposer
  get(name: string): unknown
  slots: {
    inject(name: string, factory: () => Disposer | void): Disposer
    register(options: SlotRegistration, component: ComponentType<never>): Disposer
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): Disposer
    bind(namespace: string): (key: string) => string
  }
  remote: {
    $mount(contribution: unknown): unknown
  }
}

/** 翻译函数：支持 `{name}` 占位符替换。 */
export type Translate = (key: string, vars?: Record<string, string | number>) => string
