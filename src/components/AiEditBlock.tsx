'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export type RuleSnapshot = {
  rule_id: string
  rule_name: string
  reward_type: string
  reward_rate: number | null
  reward_fixed_amount: number | null
  min_spending: number | null
  reward_cap_amount: number | null
  notes: string | null
}

type AiEdit = {
  rule_id: string
  changes: Partial<Omit<RuleSnapshot, 'rule_id'>>
  reason: string
}

const FIELD_LABELS: Record<string, string> = {
  rule_name: '活動名稱',
  reward_type: '回饋類型',
  reward_rate: '回饋率',
  reward_fixed_amount: '固定回饋金額',
  min_spending: '最低消費',
  reward_cap_amount: '回饋上限',
  notes: '備註',
}

const REWARD_TYPE_ZH: Record<string, string> = {
  cashback: '現金回饋',
  points: '點數回饋',
  fixed_amount: '固定回饋金額',
}

function fmtVal(field: string, value: unknown): string {
  if (value === null || value === undefined) return '無'
  if (field === 'reward_type') return REWARD_TYPE_ZH[value as string] ?? String(value)
  if (field === 'reward_rate') return `${((value as number) * 100).toFixed(1)}%`
  if (['reward_fixed_amount', 'min_spending', 'reward_cap_amount'].includes(field)) {
    const n = value as number
    return n === 0 ? 'NT$0' : `NT$${n.toLocaleString()}`
  }
  return String(value) || '無'
}

type Props = {
  currentRule: RuleSnapshot
  onShowToast?: (msg: string) => void
  onComplete?: () => void
}

export default function AiEditBlock({ currentRule, onShowToast, onComplete }: Props) {
  const [jsonInput, setJsonInput] = useState('')
  const [parseError, setParseError] = useState('')
  const [preview, setPreview] = useState<AiEdit | null>(null)
  const [applying, setApplying] = useState(false)

  function handleParse() {
    setParseError('')
    setPreview(null)
    let parsed: unknown
    try { parsed = JSON.parse(jsonInput) } catch {
      setParseError('格式有誤，請確認貼入的是純 JSON，不要包含說明文字或 Markdown 符號')
      return
    }
    const p = parsed as { rule_id?: unknown; changes?: unknown; reason?: unknown }
    if (typeof p.rule_id !== 'string') { setParseError('找不到 rule_id 欄位'); return }
    if (p.rule_id !== currentRule.rule_id) {
      setParseError(`找不到對應規則，請確認 rule_id 是否正確（預期：${currentRule.rule_id}）`)
      return
    }
    const changes = p.changes as Record<string, unknown>
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      setParseError('格式錯誤：缺少 changes 欄位')
      return
    }
    if ('reward_type' in changes && changes.reward_type !== null &&
        !['cashback', 'points', 'fixed_amount'].includes(changes.reward_type as string)) {
      setParseError('reward_type 欄位錯誤：必須是 cashback、points 或 fixed_amount')
      return
    }
    if ('reward_rate' in changes && changes.reward_rate !== null && typeof changes.reward_rate !== 'number') {
      setParseError('reward_rate 欄位錯誤：必須是數字或 null')
      return
    }
    setPreview({
      rule_id: p.rule_id,
      changes: changes as AiEdit['changes'],
      reason: typeof p.reason === 'string' ? p.reason : '',
    })
  }

  async function handleApply() {
    if (!preview) return
    setApplying(true)
    const { error } = await supabase.from('offer_rules')
      .update({
        ...preview.changes,
        review_status: 'human_reviewed',
        review_note: 'AI 建議修改，使用者已確認',
      })
      .eq('rule_id', preview.rule_id)
    if (error) { alert(`更新失敗：${error.message}`); setApplying(false); return }
    onShowToast?.('規則已更新')
    setJsonInput('')
    setPreview(null)
    onComplete?.()
    setApplying(false)
  }

  const changedFields = preview
    ? Object.keys(preview.changes).filter(f => f in FIELD_LABELS)
    : []

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <p className="text-xs font-semibold text-gray-600 mb-2">貼入 AI 修改建議</p>
      {!preview ? (
        <>
          <textarea
            value={jsonInput}
            onChange={e => { setJsonInput(e.target.value); setParseError('') }}
            placeholder="將 AI 回傳的 JSON 貼在這裡"
            rows={4}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-2"
          />
          {parseError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-2">{parseError}</p>
          )}
          <button
            onClick={handleParse}
            disabled={!jsonInput.trim()}
            className="w-full bg-gray-800 text-white text-xs font-medium py-2 rounded-xl hover:bg-gray-900 active:scale-95 transition-all disabled:opacity-40"
          >
            解析並預覽修改
          </button>
        </>
      ) : (
        <>
          <p className="text-xs font-semibold text-gray-700 mb-2">修改預覽：{currentRule.rule_name}</p>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden mb-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-gray-400">
                  <th className="text-left py-1.5 px-3 font-medium w-1/4">欄位</th>
                  <th className="text-left py-1.5 px-2 font-medium">修改前</th>
                  <th className="text-left py-1.5 px-2 font-medium">修改後</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {changedFields.map(field => (
                  <tr key={field} className="text-orange-700 font-medium">
                    <td className="py-1.5 px-3">{FIELD_LABELS[field]}</td>
                    <td className="py-1.5 px-2 text-gray-500 break-all">
                      {fmtVal(field, currentRule[field as keyof RuleSnapshot])}
                    </td>
                    <td className="py-1.5 px-2 break-all">
                      {fmtVal(field, (preview.changes as Record<string, unknown>)[field])}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.reason && (
            <p className="text-xs text-gray-500 italic mb-3">AI 修改原因：{preview.reason}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleApply}
              disabled={applying}
              className="flex-1 bg-blue-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50"
            >
              {applying ? '更新中...' : '確認修改'}
            </button>
            <button
              onClick={() => { setJsonInput(''); setPreview(null); setParseError('') }}
              className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all"
            >
              取消
            </button>
          </div>
        </>
      )}
    </div>
  )
}
