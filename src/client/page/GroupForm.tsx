/*
 * @Description: 新建 / 编辑分组的弹窗表单 —— 只有名称与父级分组
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/page/GroupForm.tsx
 *
 * 分组只用来归类主机；不再在界面上配置分组默认值（用户名 / 认证 / 跳板 / 代理等）。
 * 编辑已有分组时原样带回它已有的默认值（旧数据），避免改个名就把它们清掉；
 * 认证 / 代理不发送即保留（存储层补丁语义）。
 */
import { useMemo, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GroupView } from '../../types.js'
import type { SaveGroupInput } from '../../wire/dto.js'
import type { Translate } from '../context.js'
import { Field } from './fields.js'
import { GroupSelect, normalizePath } from './GroupSelect.js'
import { messageOf } from './useWorkspace.js'

export interface GroupFormProps {
  t: Translate
  open: boolean
  group: GroupView | undefined
  /** 新建时预填的父路径。 */
  parentPath?: string
  /** 新建时预填完整路径（为只由主机推导出的虚拟分组补记录）。 */
  presetPath?: string
  /** 现有全部分组路径（父级下拉的候选）。 */
  groupPaths: string[]
  onClose: () => void
  onSave: (input: SaveGroupInput) => Promise<void>
}

function splitPath(path: string): { parent: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { parent: '', name: path } : { parent: path.slice(0, slash), name: path.slice(slash + 1) }
}

export function GroupForm(props: GroupFormProps) {
  const { t, group } = props
  const initial =
    group !== undefined
      ? splitPath(group.path)
      : props.presetPath !== undefined
        ? splitPath(props.presetPath)
        : { parent: props.parentPath ?? '', name: '' }
  const [name, setName] = useState(initial.name)
  const [parent, setParent] = useState(initial.parent)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const trimmed = name.trim()
  const nameError = trimmed === '' ? t('form.required') : trimmed.includes('/') ? t('form.groupNameSlash') : undefined
  const fullPath = normalizePath(parent === '' ? trimmed : `${parent}/${trimmed}`)
  const duplicate = fullPath !== '' && fullPath !== group?.path && fullPath !== props.presetPath && props.groupPaths.includes(fullPath)
  const error = nameError ?? (duplicate ? t('form.groupExists') : undefined)

  // 编辑时不能把分组挪到自己或自己的子分组下面。
  const self = group?.path
  const parentCandidates = useMemo(
    () => props.groupPaths.filter((p) => self === undefined || (p !== self && !p.startsWith(`${self}/`))),
    [props.groupPaths, self]
  )

  const submit = async (): Promise<void> => {
    setSubmitted(true)
    if (error !== undefined) return
    const d = group?.defaults
    const input: SaveGroupInput = {
      path: fullPath,
      ...(group !== undefined ? { previousPath: group.path } : {}),
      ...(d?.username !== undefined ? { username: d.username } : {}),
      ...(d?.port !== undefined ? { port: d.port } : {}),
      ...(d?.jumpHostIds !== undefined && d.jumpHostIds.length > 0 ? { jumpHostIds: d.jumpHostIds } : {}),
      ...(d?.startupCommand !== undefined ? { startupCommand: d.startupCommand } : {}),
      ...(d?.environmentVariables !== undefined ? { environmentVariables: d.environmentVariables } : {})
    }
    setSaving(true)
    setFormError(null)
    try {
      await props.onSave(input)
    } catch (err) {
      setFormError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={group === undefined ? t('form.newGroup') : t('form.editGroup')}
      closeLabel={t('common.close')}
      className="dshws-group-dialog"
      footer={
        <div className="dshws-footer">
          <Button variant="outline" onClick={props.onClose} disabled={saving}>
            {t('form.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? t('form.saving') : t('form.save')}
          </Button>
        </div>
      }
    >
      <div className="dshws-form">
        {formError !== null ? <div className="dshws-form-error">{formError}</div> : null}
        <Field label={t('form.groupName')} required error={submitted ? error : undefined}>
          <input
            className="dshws-input"
            value={name}
            autoFocus
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </Field>
        <Field label={t('form.groupParent')} hint={fullPath !== '' ? t('form.groupFullPath', { path: fullPath.split('/').join(' / ') }) : undefined}>
          <GroupSelect t={t} value={parent} paths={parentCandidates} rootLabel={t('form.groupRoot')} onChange={setParent} />
        </Field>
      </div>
    </Modal>
  )
}
