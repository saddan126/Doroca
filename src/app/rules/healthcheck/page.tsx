'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────────

type CardOption = { card_id: string; card_name: string; bank_name: string }

type CardRule = {
  rule_id: string; rule_name: string; category: string | null
  reward_type: string; reward_rate: number | null; reward_fixed_amount: number | null
  min_spending: number | null; reward_cap_amount: number | null; reward_cap_cycle: string | null
  requires_registration: string | null; requires_new_customer: string | null
  excludes_third_party_payment: string | null
  valid_from: string | null; valid_to: string | null
  confidence: string | null; review_status: string | null; notes: string | null
  source_url: string | null; source_updated_at: string | null
  extra_conditions_json: Record<string, unknown> | null
}

type Operation = {
  operation_type: 'mark_duplicate' | 'suggest_merge' | 'flag_conflict' | 'mark_expired' | 'no_action'
  confidence: 'high' | 'medium' | 'low'
  primary_rule_id: string
  affected_rule_ids: string[]
  reason: string
  requires_human_review: boolean
}

type ReviewOp = Operation & {
  _status: 'pending' | 'applied' | 'skipped'
  _primaryRuleName: string
  _affectedRuleNames: string[]
  _allRules: CardRule[]
}

// ── Constants ─────────────────────────────────────────────────────

const REWARD_TYPE_ZH: Record<string, string> = {
  cashback: '現金回饋',
  points: '點數回饋',
  fixed_amount: '固定回饋金額',
}

const CATEGORY_ZH: Record<string, string> = {
  general: '一般消費', foreign_currency: '海外消費', travel: '旅遊',
  online_shopping: '網購', restaurant: '餐廳', convenience_store: '超商',
  supermarket: '超市', department_store: '百貨', mobile_payment: '行動支付',
  flight: '機票', hotel: '飯店', food_delivery: '外送',
  new_customer_bonus: '新戶活動', easycard_auto_reload: '悠遊卡自動加值',
  subscription: '訂閱服務', ai_service: 'AI 服務',
  tax: '繳稅', bill_payment: '繳費', insurance: '保費', gas_station: '加油站',
}

const CONF_BADGE: Record<string, string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-red-100 text-red-700',
}
const CONF_LABEL: Record<string, string> = { high: '高信心', medium: '中信心', low: '低信心' }

const CLAUDE_TAIL = `請只輸出 JSON，不要使用 Markdown code block，不要加入解釋文字。`
const CHATGPT_TAIL = `請輸出可被 JSON.parse() 直接解析的 JSON。不要使用 Markdown code block、表格、摘要或補充說明。`

// ── Helpers ───────────────────────────────────────────────────────

function getDomain(url: string | null): string {
  if (!url) return '（無來源）'
  try { return new URL(url).hostname.replace(/^www\./, '') }
  catch { return url.slice(0, 30) }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return dateStr.slice(0, 10).replace(/-/g, '/')
}

function categoryZh(cat: string | null): string {
  if (!cat) return '—'
  return cat.split(',').map(c => CATEGORY_ZH[c.trim()] ?? c.trim()).join(' + ')
}

function rewardDescLine(r: CardRule): string {
  if (r.reward_type === 'cashback' && r.reward_rate != null)
    return `現金回饋 ${(r.reward_rate * 100).toFixed(1)}%`
  if (r.reward_type === 'fixed_amount' && r.reward_fixed_amount != null)
    return `固定回饋 NT$${r.reward_fixed_amount.toLocaleString()}`
  if (r.reward_type === 'points') {
    const currency = (r.extra_conditions_json?.reward_currency as string) ?? '點數'
    if (r.reward_rate != null) return `${currency}回饋 ${(r.reward_rate * 100).toFixed(1)}%`
    if (r.reward_fixed_amount != null) return `贈 ${r.reward_fixed_amount.toLocaleString()} ${currency}`
    return `${currency}回饋`
  }
  return REWARD_TYPE_ZH[r.reward_type] ?? r.reward_type
}

function humanSummaryLine(r: CardRule): string {
  const cap = r.reward_cap_amount != null ? `上限 NT$${r.reward_cap_amount.toLocaleString()}` : '無上限'
  const reg = r.requires_registration === 'yes' ? '需登錄' : '無需登錄'
  return [rewardDescLine(r), cap, reg].join('｜')
}

// 判斷新舊規則：source_updated_at 較新者為「新規則」，相同時用 rule_id 字典序判斷
function determineNewOld(rules: CardRule[]): { newRule: CardRule; oldRule: CardRule } | null {
  if (rules.length < 2) return null
  const [a, b] = rules
  const dateA = a.source_updated_at ?? ''
  const dateB = b.source_updated_at ?? ''
  if (dateA !== dateB) {
    return dateA > dateB ? { newRule: a, oldRule: b } : { newRule: b, oldRule: a }
  }
  return a.rule_id >= b.rule_id ? { newRule: a, oldRule: b } : { newRule: b, oldRule: a }
}

function sortRulesByAge(rules: CardRule[]): CardRule[] {
  return [...rules].sort((a, b) => {
    const dateA = a.valid_from ?? a.source_updated_at ?? ''
    const dateB = b.valid_from ?? b.source_updated_at ?? ''
    return dateA.localeCompare(dateB)
  })
}

function detectConflictType(op: ReviewOp): 'A' | 'B' {
  const hasBonus = op._allRules.some(r => r.rule_name?.includes('加碼'))
  const rates = op._allRules.map(r => r.reward_rate).filter((r): r is number => r !== null)
  if (hasBonus || (rates.length >= 2 && new Set(rates).size > 1)) return 'B'
  return 'A'
}

function buildMergeJudgmentPrompt(ruleA: CardRule, ruleB: CardRule, card: CardOption): string {
  function ruleInfo(r: CardRule, label: string): string {
    return [
      `【規則 ${label}】`,
      `名稱：${r.rule_name}`,
      `回饋：${rewardDescLine(r)}`,
      `有效期：${formatDate(r.valid_from)} ~ ${formatDate(r.valid_to)}`,
      `需登錄：${r.requires_registration === 'yes' ? '是' : '否'}`,
      `來源：${r.source_url ?? '（無）'}`,
    ].join('\n')
  }
  return `我有兩條信用卡優惠規則需要判斷，請幫我分析。

【卡片】${card.card_name}（${card.bank_name}）

${ruleInfo(ruleA, 'A')}

${ruleInfo(ruleB, 'B')}

【問題】
1. 這兩條規則是否描述同一個優惠？還是不同優惠？
2. 如果是同一個優惠，建議保留哪一條？
3. 如果兩條都應該保留，推薦計算時應該疊加還是擇一？
4. 如果有提供來源連結，請確認後再回答。

請直接給結論：
結論：保留規則A / 保留規則B / 兩者可同時存在
原因：（一句話）`
}

function buildHealthPrompt(cardName: string, bankName: string, rules: CardRule[]): string {
  const rulesJson = JSON.stringify(rules.map(r => ({
    rule_id: r.rule_id, rule_name: r.rule_name, category: r.category,
    reward_type: r.reward_type, reward_rate: r.reward_rate,
    reward_fixed_amount: r.reward_fixed_amount, min_spending: r.min_spending,
    reward_cap_amount: r.reward_cap_amount, reward_cap_cycle: r.reward_cap_cycle,
    requires_registration: r.requires_registration,
    valid_from: r.valid_from, valid_to: r.valid_to,
    confidence: r.confidence, review_status: r.review_status,
  })), null, 2)
  return `你是 Doroca 信用卡優惠規則審查器。

請審查以下規則，找出問題並回傳操作建議。

【卡片】${bankName} ${cardName}

重要限制：
- 不得刪除任何規則
- 不得輸出完整 offer_rules
- 不得自行創造新優惠
- 相似但可能同時存在的優惠，不可合併，只能 flag_conflict
- 如果不確定，requires_human_review = true
- 只輸出 JSON，不要輸出說明文字
- reason 欄位必須用繁體中文人話描述，不可出現任何英文欄位名稱（例如 reward_type、category、rule_id 等）

請找出：
1. 完全重複的規則（所有核心欄位相同）
2. 可能已被新版本取代的舊規則
3. 已過期但仍標示 human_reviewed 的規則
4. 同卡同分類有效期間重疊但條件衝突的規則

輸出格式：
{
  "operations": [
    {
      "operation_type": "mark_duplicate | suggest_merge | flag_conflict | mark_expired | no_action",
      "confidence": "high | medium | low",
      "primary_rule_id": "string",
      "affected_rule_ids": ["string"],
      "reason": "繁體中文人話，不用英文欄位名稱",
      "requires_human_review": true
    }
  ]
}

以下是該卡的 offer_rules：
${rulesJson}`
}

// ── Component ─────────────────────────────────────────────────────

export default function HealthCheckPage() {
  const [cards, setCards] = useState<CardOption[]>([])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [cardRules, setCardRules] = useState<CardRule[]>([])
  const [loadingRules, setLoadingRules] = useState(false)

  const [prompt, setPrompt] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [jsonInput, setJsonInput] = useState('')
  const [parseError, setParseError] = useState('')
  const [reviewOps, setReviewOps] = useState<ReviewOp[]>([])
  const [applyCount, setApplyCount] = useState(0)
  const [duplicateSelections, setDuplicateSelections] = useState<Record<string, string>>({})
  const [typeBKeepMode, setTypeBKeepMode] = useState<Record<string, boolean>>({})
  const [typeBSelections, setTypeBSelections] = useState<Record<string, string>>({})
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  const [promptFallback, setPromptFallback] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    supabase.from('cards').select('card_id, card_name, banks(bank_name)').eq('status', 'active').order('card_name')
      .then(({ data }) => {
        if (!data) return
        setCards((data as unknown as { card_id: string; card_name: string; banks: { bank_name: string } | null }[])
          .map(c => ({ card_id: c.card_id, card_name: c.card_name, bank_name: c.banks?.bank_name ?? '' })))
      })
  }, [])

  useEffect(() => {
    if (!selectedCardId) { setCardRules([]); return }
    setLoadingRules(true)
    supabase.from('offer_rules')
      .select('rule_id, rule_name, category, reward_type, reward_rate, reward_fixed_amount, min_spending, reward_cap_amount, reward_cap_cycle, requires_registration, requires_new_customer, excludes_third_party_payment, valid_from, valid_to, confidence, review_status, notes, source_url, source_updated_at, extra_conditions_json')
      .eq('card_id', selectedCardId)
      .then(({ data }) => { setCardRules((data || []) as CardRule[]); setLoadingRules(false) })
  }, [selectedCardId])

  const selectedCard = cards.find(c => c.card_id === selectedCardId)

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3000)
  }

  function handleGenerate() {
    if (!selectedCard || cardRules.length === 0) return
    setPrompt(buildHealthPrompt(selectedCard.card_name, selectedCard.bank_name, cardRules))
  }

  async function handleCopyAndOpen(target: 'claude' | 'chatgpt' | 'copy') {
    const tail = target === 'claude' ? CLAUDE_TAIL : target === 'chatgpt' ? CHATGPT_TAIL : ''
    const full = tail ? `${prompt}\n\n${tail}` : prompt
    try {
      await navigator.clipboard.writeText(full)
      if (target === 'claude') { showToast('Prompt 已複製，請在新開啟的 Claude 視窗中貼上'); window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer') }
      else if (target === 'chatgpt') { showToast('Prompt 已複製，請在新開啟的 ChatGPT 視窗中貼上'); window.open('https://chatgpt.com/', '_blank', 'noopener,noreferrer') }
      else showToast('Prompt 已複製！')
    } catch { showToast('複製失敗，請展開查看並手動複製') }
  }

  function handleParseJson() {
    setParseError(''); setReviewOps([]); setApplyCount(0)
    setDuplicateSelections({}); setTypeBSelections({}); setTypeBKeepMode({})
    setPromptFallback(null)
    let parsed: unknown
    try { parsed = JSON.parse(jsonInput) } catch (e) { setParseError(`JSON 解析失敗：${String(e)}`); return }
    const p = parsed as { operations?: unknown }
    if (!Array.isArray(p.operations)) { setParseError('格式錯誤：缺少 operations 陣列'); return }

    const ruleMap = new Map(cardRules.map(r => [r.rule_id, r]))
    const ruleNameMap = new Map(cardRules.map(r => [r.rule_id, r.rule_name]))

    const ops: ReviewOp[] = (p.operations as Operation[]).map(op => {
      const allIds = [op.primary_rule_id, ...(op.affected_rule_ids ?? [])]
      const allRules = allIds.map(id => ruleMap.get(id)).filter((r): r is CardRule => r !== undefined)
      return {
        ...op,
        affected_rule_ids: op.affected_rule_ids ?? [],
        _status: 'pending' as const,
        _primaryRuleName: ruleNameMap.get(op.primary_rule_id) ?? '（規則名稱未找到）',
        _affectedRuleNames: (op.affected_rule_ids ?? []).map(id => ruleNameMap.get(id) ?? '（規則名稱未找到）'),
        _allRules: allRules,
      }
    })

    const initDupSel: Record<string, string> = {}
    const initTypeBSel: Record<string, string> = {}
    for (const op of ops) {
      if (op.operation_type === 'mark_duplicate' && op._allRules.length > 0) {
        const sorted = [...op._allRules].sort((a, b) => (b.source_updated_at ?? '').localeCompare(a.source_updated_at ?? ''))
        initDupSel[op.primary_rule_id] = sorted[0].rule_id
      }
      if ((op.operation_type === 'flag_conflict' || op.operation_type === 'suggest_merge') && op._allRules.length >= 2) {
        const sorted = sortRulesByAge(op._allRules)
        initTypeBSel[op.primary_rule_id] = sorted[sorted.length - 1].rule_id
      }
    }
    setDuplicateSelections(initDupSel)
    setTypeBSelections(initTypeBSel)
    setReviewOps(ops)
  }

  function markApplied(primaryId: string) {
    setReviewOps(prev => prev.map(r => r.primary_rule_id === primaryId ? { ...r, _status: 'applied' as const } : r))
    setApplyCount(prev => prev + 1)
    setTimeout(() => setReviewOps(prev => prev.filter(r => r.primary_rule_id !== primaryId)), 1500)
  }

  function skipOp(primaryId: string) {
    setReviewOps(prev => prev.map(r => r.primary_rule_id === primaryId ? { ...r, _status: 'skipped' as const } : r))
    setTimeout(() => setReviewOps(prev => prev.filter(r => r.primary_rule_id !== primaryId)), 800)
  }

  async function handleDeleteDuplicates(op: ReviewOp) {
    const keepId = duplicateSelections[op.primary_rule_id]
    if (!keepId) return
    const idsToDelete = op._allRules.map(r => r.rule_id).filter(id => id !== keepId)
    if (idsToDelete.length === 0) return
    if (!window.confirm(`確定刪除 ${idsToDelete.length} 筆重複規則？此操作無法復原。`)) return
    const { error } = await supabase.from('offer_rules').delete().in('rule_id', idsToDelete)
    if (error) { alert(`刪除失敗：${error.message}`); return }
    await supabase.from('offer_rules').update({ review_status: 'human_reviewed', review_note: null }).eq('rule_id', keepId)
    markApplied(op.primary_rule_id)
  }

  async function handleDeleteSingleRule(ruleId: string, op: ReviewOp) {
    if (!window.confirm('確定刪除此規則？此操作無法復原。')) return
    const { error } = await supabase.from('offer_rules').delete().eq('rule_id', ruleId)
    if (error) { alert(`刪除失敗：${error.message}`); return }
    const survivingIds = op._allRules.map(r => r.rule_id).filter(id => id !== ruleId)
    if (survivingIds.length > 0) {
      await supabase.from('offer_rules').update({ review_status: 'human_reviewed', review_note: null }).in('rule_id', survivingIds)
    }
    markApplied(op.primary_rule_id)
  }

  async function handleDeactivateRule(ruleId: string, ruleName: string, op: ReviewOp) {
    if (!window.confirm(`確定停用「${ruleName}」嗎？\n此規則將不再參與推薦計算，但不會從資料庫刪除。`)) return
    const { error } = await supabase.from('offer_rules')
      .update({ review_status: 'deactivated', review_note: 'AI 健檢：疑似被新版規則取代，已停用' })
      .eq('rule_id', ruleId)
    if (error) { alert(`停用失敗：${error.message}`); return }
    const survivingIds = op._allRules.map(r => r.rule_id).filter(id => id !== ruleId)
    if (survivingIds.length > 0) {
      await supabase.from('offer_rules').update({ review_status: 'human_reviewed', review_note: null }).in('rule_id', survivingIds)
    }
    markApplied(op.primary_rule_id)
  }

  async function handleMarkNonStackable(op: ReviewOp) {
    const allIds = [op.primary_rule_id, ...op.affected_rule_ids].filter(Boolean)
    const note = 'AI 健檢：加碼回饋不可與總回饋自動疊加，已由使用者確認'
    for (const id of allIds) await supabase.from('offer_rules').update({ review_status: 'human_reviewed', review_note: note }).eq('rule_id', id)
    markApplied(op.primary_rule_id)
  }

  async function handleBothKeepPendingReview(op: ReviewOp) {
    const allIds = [op.primary_rule_id, ...op.affected_rule_ids].filter(Boolean)
    const note = 'AI 健檢：版本衝突，兩筆規則皆保留，需人工確認是否為同一優惠的新舊版本'
    for (const id of allIds) await supabase.from('offer_rules').update({ review_status: 'needs_review', review_note: note }).eq('rule_id', id)
    markApplied(op.primary_rule_id)
  }

  async function handleTypeBKeepOne(op: ReviewOp) {
    const keepId = typeBSelections[op.primary_rule_id]
    if (!keepId) return
    const idsToDelete = op._allRules.map(r => r.rule_id).filter(id => id !== keepId)
    if (idsToDelete.length === 0) return
    if (!window.confirm(`確定刪除 ${idsToDelete.length} 筆規則？此操作無法復原。`)) return
    const { error } = await supabase.from('offer_rules').delete().in('rule_id', idsToDelete)
    if (error) { alert(`刪除失敗：${error.message}`); return }
    await supabase.from('offer_rules').update({ review_status: 'human_reviewed', review_note: null }).eq('rule_id', keepId)
    markApplied(op.primary_rule_id)
  }

  async function applyOp(op: ReviewOp) {
    const allIds = [op.primary_rule_id, ...op.affected_rule_ids].filter(Boolean)
    if (op.operation_type === 'no_action') {
      for (const id of allIds) await supabase.from('offer_rules').update({ review_status: 'human_reviewed' }).eq('rule_id', id)
    } else {
      const note = `AI 健檢標記：${op.reason}`
      for (const id of allIds) await supabase.from('offer_rules').update({ review_status: 'needs_review', review_note: note }).eq('rule_id', id)
    }
    markApplied(op.primary_rule_id)
  }

  async function handleCopySearchKeyword(keyword: string) {
    try { await navigator.clipboard.writeText(keyword) } catch { }
    showToast('搜尋關鍵字已複製！')
  }

  async function handleCopyAiPrompt(promptText: string, opId: string) {
    try {
      await navigator.clipboard.writeText(promptText)
      showToast('已複製，請貼到你的 AI 工具進行判定。')
      setCopiedPromptId(opId)
      setPromptFallback(null)
      setTimeout(() => setCopiedPromptId(null), 3000)
    } catch {
      setPromptFallback({ id: opId, text: promptText })
      showToast('剪貼簿複製失敗，請手動複製下方文字')
    }
  }

  const SKIP_NOTE = '不會修改規則，這組衝突在下次重新執行健檢時仍會出現。'

  const pendingCount = reviewOps.filter(r => r._status === 'pending').length

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/rules" className="text-gray-400 hover:text-gray-600 text-sm">← 規則健康度</Link>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">AI 規則健檢</h1>
        <p className="text-sm text-gray-500 mb-6">每月一次，讓 AI 檢查規則是否有重複、過期或衝突</p>

        {toast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg whitespace-nowrap">
            {toast}
          </div>
        )}

        {/* 步驟 1 */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 1　選擇要健檢的卡片</p>
          <select value={selectedCardId}
            onChange={e => { setSelectedCardId(e.target.value); setPrompt(''); setReviewOps([]); setApplyCount(0) }}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">請選擇卡片</option>
            {cards.map(c => <option key={c.card_id} value={c.card_id}>{c.bank_name} {c.card_name}</option>)}
          </select>
          {selectedCardId && !loadingRules && <p className="text-xs text-gray-400 mt-2">共 {cardRules.length} 條規則將納入健檢</p>}
          {loadingRules && <p className="text-xs text-gray-400 mt-2">載入規則中...</p>}
        </div>

        {/* 步驟 2 */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 2　產生健檢 Prompt 並送給 AI</p>
          <button type="button" onClick={handleGenerate}
            disabled={!selectedCard || cardRules.length === 0 || loadingRules}
            className="w-full bg-amber-500 text-white font-semibold py-3 rounded-xl hover:bg-amber-600 active:scale-95 transition-all text-sm disabled:opacity-50 mb-3">
            產生健檢 Prompt
          </button>
          {prompt && (
            <div className="space-y-2">
              <button onClick={() => handleCopyAndOpen('claude')}
                className="w-full bg-amber-500 text-white text-sm font-medium py-2.5 rounded-xl hover:bg-amber-600 active:scale-95 transition-all">
                複製 Prompt 並開啟 Claude
              </button>
              <button onClick={() => handleCopyAndOpen('chatgpt')}
                className="w-full bg-green-600 text-white text-sm font-medium py-2.5 rounded-xl hover:bg-green-700 active:scale-95 transition-all">
                複製 Prompt 並開啟 ChatGPT
              </button>
              <button onClick={() => handleCopyAndOpen('copy')}
                className="w-full bg-white border border-gray-200 text-gray-700 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50 active:scale-95 transition-all">
                只複製 Prompt
              </button>
              <details className="pt-1">
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">查看 Prompt 內容</summary>
                <textarea readOnly value={prompt} rows={10}
                  className="w-full mt-2 border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-700 bg-gray-50 resize-none focus:outline-none" />
              </details>
            </div>
          )}
        </div>

        {/* 步驟 3 */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 3　貼回 JSON，確認並套用</p>
          {!selectedCardId ? (
            <p className="text-sm text-gray-400 text-center py-4">請先完成步驟 1 選擇卡片</p>
          ) : (
            <>
              <textarea value={jsonInput} onChange={e => { setJsonInput(e.target.value); setParseError('') }}
                placeholder={'將 AI 回傳的 JSON 貼入此處...\n{\n  "operations": [...]\n}'}
                rows={7}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-xs text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-3" />
              {parseError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{parseError}</p>}
              <button type="button" onClick={handleParseJson} disabled={!jsonInput.trim()}
                className="w-full bg-gray-800 text-white text-sm font-medium py-2.5 rounded-xl hover:bg-gray-900 active:scale-95 transition-all disabled:opacity-40">
                驗證 JSON
              </button>
            </>
          )}
        </div>

        {/* 審核建議列表 */}
        {reviewOps.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-0.5">共 {reviewOps.length} 條建議</p>
            <p className="text-xs text-gray-400 mb-3">待確認 {pendingCount} 條・已套用 {applyCount} 條</p>
            <div className="space-y-3">
              {reviewOps.map(op => {
                if (op._status === 'applied') return (
                  <div key={op.primary_rule_id} className="rounded-2xl border border-green-100 bg-green-50 px-4 py-3 flex items-center gap-2">
                    <span className="text-green-600">✓</span>
                    <p className="text-sm text-green-700 font-medium flex-1">{op._primaryRuleName}</p>
                    <span className="text-xs text-green-500">已套用</span>
                  </div>
                )
                if (op._status === 'skipped') return (
                  <div key={op.primary_rule_id} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 flex items-center gap-2 opacity-40">
                    <p className="text-sm text-gray-400 line-through flex-1">{op._primaryRuleName}</p>
                    <span className="text-xs text-gray-400">已略過</span>
                  </div>
                )

                // ── mark_duplicate ────────────────────────────
                if (op.operation_type === 'mark_duplicate' && op._allRules.length > 0) {
                  const sortedRules = [...op._allRules].sort((a, b) =>
                    (b.source_updated_at ?? '').localeCompare(a.source_updated_at ?? ''))
                  const representative = sortedRules[0]
                  const selectedKeepId = duplicateSelections[op.primary_rule_id] ?? sortedRules[0].rule_id
                  return (
                    <div key={op.primary_rule_id} className="rounded-2xl border border-red-200 bg-red-50 p-4">
                      <div className="mb-3">
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-700">
                          疑似重複（{op._allRules.length} 筆相同規則）
                        </span>
                      </div>
                      <div className="bg-white rounded-xl p-3 mb-3">
                        <p className="text-sm font-medium text-gray-900">{representative.rule_name}</p>
                        <p className="text-xs text-gray-600 mt-0.5">{humanSummaryLine(representative)}</p>
                      </div>
                      <p className="text-xs text-gray-600 mb-3">系統偵測到 {op._allRules.length} 筆內容完全相同的規則，建議只保留 1 筆。</p>
                      <p className="text-xs font-semibold text-gray-700 mb-2">保留哪一筆？</p>
                      <div className="space-y-2 mb-4">
                        {sortedRules.map((rule, idx) => {
                          const tag = idx === 0 ? '（最新）' : idx === sortedRules.length - 1 && sortedRules.length > 1 ? '（最舊）' : ''
                          return (
                            <label key={rule.rule_id} className={`flex items-center gap-2.5 p-2.5 rounded-xl cursor-pointer border transition-all ${
                              selectedKeepId === rule.rule_id ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
                            }`}>
                              <input type="radio" name={`keep-${op.primary_rule_id}`} value={rule.rule_id}
                                checked={selectedKeepId === rule.rule_id}
                                onChange={() => setDuplicateSelections(prev => ({ ...prev, [op.primary_rule_id]: rule.rule_id }))}
                                className="accent-blue-600" />
                              <span className="text-xs text-gray-700">
                                {getDomain(rule.source_url)}｜更新於 {formatDate(rule.source_updated_at)}
                                {tag && <span className="text-gray-400 ml-1">{tag}</span>}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => handleDeleteDuplicates(op)}
                          className="flex-1 bg-red-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-red-700 active:scale-95 transition-all">
                          刪除其他，保留選取的
                        </button>
                        <button onClick={() => skipOp(op.primary_rule_id)}
                          className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                          略過
                        </button>
                      </div>
                    </div>
                  )
                }

                // ── suggest_merge ─────────────────────────────
                if (op.operation_type === 'suggest_merge') {
                  const newOld = determineNewOld(op._allRules)
                  const newRule = newOld?.newRule
                  const oldRule = newOld?.oldRule
                  const hasTwoRules = !!newOld
                  const displayRule = newRule ?? op._allRules[0]
                  const mergePrompt = selectedCard && newRule && oldRule
                    ? buildMergeJudgmentPrompt(oldRule, newRule, selectedCard)
                    : ''
                  const impactText = displayRule
                    ? `若兩筆都啟用，App 可能重複計算同一筆${rewardDescLine(displayRule)}回饋`
                    : '若兩筆都啟用，App 可能重複計算回饋'

                  return (
                    <div key={op.primary_rule_id} className="rounded-2xl border border-blue-200 bg-blue-50 p-4">

                      {/* 標籤 + 信心度 */}
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
                          建議整合
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONF_BADGE[op.confidence] ?? 'bg-gray-100 text-gray-600'}`}>
                          {CONF_LABEL[op.confidence] ?? op.confidence}
                        </span>
                      </div>

                      {/* 新舊規則對比 */}
                      {hasTwoRules && newRule && oldRule ? (
                        <div className="space-y-2 mb-3">
                          <div className="bg-white rounded-xl p-3 border border-blue-100">
                            <p className="text-xs font-semibold text-blue-600 mb-1">新規則（建議保留）</p>
                            <p className="text-sm font-medium text-gray-900">{newRule.rule_name}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {rewardDescLine(newRule)}｜更新於 {formatDate(newRule.source_updated_at)}
                            </p>
                          </div>
                          <div className="bg-white rounded-xl p-3 border border-gray-200">
                            <p className="text-xs font-semibold text-gray-400 mb-1">舊規則（建議停用）</p>
                            <p className="text-sm font-medium text-gray-600">{oldRule.rule_name}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {rewardDescLine(oldRule)}｜更新於 {formatDate(oldRule.source_updated_at)}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-white rounded-xl p-3 mb-3">
                          <p className="text-sm font-semibold text-gray-900">{displayRule?.rule_name ?? op._primaryRuleName}</p>
                          {displayRule && <p className="text-xs text-gray-500 mt-0.5">{rewardDescLine(displayRule)}</p>}
                        </div>
                      )}

                      {/* 說明（AI 的 reason） */}
                      <p className="text-sm text-gray-700 leading-relaxed mb-3">{op.reason}</p>

                      {/* 對推薦的影響 */}
                      <div className="bg-amber-50 rounded-xl px-3 py-2 mb-3">
                        <p className="text-xs font-semibold text-amber-700 mb-0.5">對推薦的影響</p>
                        <p className="text-xs text-amber-800">{impactText}</p>
                      </div>

                      {/* AI 判定 prompt 按鈕（只複製，不開啟） */}
                      {mergePrompt && (
                        <>
                          <button onClick={() => handleCopyAiPrompt(mergePrompt, op.primary_rule_id)}
                            className="w-full bg-amber-500 text-white text-xs font-medium py-2.5 rounded-xl hover:bg-amber-600 active:scale-95 transition-all mb-2">
                            {copiedPromptId === op.primary_rule_id ? '✓ 已複製！' : '複製 AI 判定問題'}
                          </button>
                          {promptFallback?.id === op.primary_rule_id && (
                            <textarea readOnly value={promptFallback.text} rows={6}
                              className="w-full mb-3 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-gray-700 bg-amber-50 resize-none focus:outline-none"
                              onFocus={e => e.target.select()} />
                          )}
                        </>
                      )}

                      {/* 決策按鈕 */}
                      <div className="space-y-2">
                        <button
                          onClick={() => oldRule && handleDeactivateRule(oldRule.rule_id, oldRule.rule_name, op)}
                          disabled={!hasTwoRules}
                          className="w-full bg-blue-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-40">
                          保留新規則，停用舊規則
                        </button>
                        <button
                          onClick={() => newRule && handleDeactivateRule(newRule.rule_id, newRule.rule_name, op)}
                          disabled={!hasTwoRules}
                          className="w-full bg-blue-400 text-white text-xs font-medium py-2 rounded-xl hover:bg-blue-500 active:scale-95 transition-all disabled:opacity-40">
                          保留舊規則，停用新規則
                        </button>
                        <button onClick={() => handleBothKeepPendingReview(op)}
                          className="w-full bg-white border border-gray-300 text-gray-700 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 active:scale-95 transition-all">
                          兩筆都保留，標記待確認
                        </button>
                        <button onClick={() => skipOp(op.primary_rule_id)}
                          className="w-full bg-white border border-gray-200 text-gray-400 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                          略過此次審核
                        </button>
                        <p className="text-xs text-gray-400 text-center">{SKIP_NOTE}</p>
                      </div>
                    </div>
                  )
                }

                // ── flag_conflict ─────────────────────────────
                if (op.operation_type === 'flag_conflict') {
                  const conflictType = detectConflictType(op)
                  const sortedAB = sortRulesByAge(op._allRules)
                  const ruleA = sortedAB[0]
                  const ruleB = sortedAB[1]
                  const hasTwoRules = sortedAB.length >= 2
                  const newOld = determineNewOld(op._allRules)
                  const isTypeA = conflictType === 'A'
                  const conflictLabel = isTypeA ? '疑似新版取代舊版' : '總回饋與加碼回饋需確認'
                  const conflictBorder = isTypeA ? 'border-orange-200 bg-orange-50' : 'border-yellow-200 bg-yellow-50'
                  const conflictBadge = isTypeA ? 'bg-orange-100 text-orange-700' : 'bg-yellow-100 text-yellow-700'
                  const sourceUrl = ruleA?.source_url || ruleB?.source_url
                  const impactText = isTypeA
                    ? `若兩筆都啟用，App 可能重複計算同一筆${ruleA ? rewardDescLine(ruleA) : ''}回饋`
                    : '若兩筆回饋疊加，App 計算出的回饋可能高於實際可得'
                  const showTypeBKeep = typeBKeepMode[op.primary_rule_id]
                  const typeBSelectedId = typeBSelections[op.primary_rule_id] ?? ruleB?.rule_id ?? ''
                  const conflictPrompt = selectedCard && hasTwoRules && ruleA && ruleB
                    ? buildMergeJudgmentPrompt(ruleA, ruleB, selectedCard)
                    : ''

                  return (
                    <div key={op.primary_rule_id} className={`rounded-2xl border p-4 ${conflictBorder}`}>

                      {/* 1. 衝突類型標籤 + 信心度 */}
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${conflictBadge}`}>
                          ⚠ {conflictLabel}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONF_BADGE[op.confidence] ?? 'bg-gray-100 text-gray-600'}`}>
                          {CONF_LABEL[op.confidence] ?? op.confidence}
                        </span>
                      </div>

                      {/* 2. 新舊規則對比 */}
                      {hasTwoRules && newOld ? (
                        <div className="space-y-2 mb-3">
                          <div className="bg-white rounded-xl p-3 border border-orange-100">
                            <p className="text-xs font-semibold text-orange-600 mb-1">新規則</p>
                            <p className="text-sm font-medium text-gray-900">{newOld.newRule.rule_name}</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {rewardDescLine(newOld.newRule)}｜更新於 {formatDate(newOld.newRule.source_updated_at)}
                            </p>
                          </div>
                          <div className="bg-white rounded-xl p-3 border border-gray-200">
                            <p className="text-xs font-semibold text-gray-400 mb-1">舊規則</p>
                            <p className="text-sm font-medium text-gray-600">{newOld.oldRule.rule_name}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {rewardDescLine(newOld.oldRule)}｜更新於 {formatDate(newOld.oldRule.source_updated_at)}
                            </p>
                          </div>
                        </div>
                      ) : (ruleB ?? ruleA) && (
                        <div className="bg-white rounded-xl p-3 mb-3">
                          <p className="text-sm font-semibold text-gray-900">{(ruleB ?? ruleA)!.rule_name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{rewardDescLine((ruleB ?? ruleA)!)}</p>
                        </div>
                      )}

                      {/* 3. 一句話結論 */}
                      <p className="text-sm text-gray-700 leading-relaxed mb-3">{op.reason}</p>

                      {/* 4. 對推薦結果的影響 */}
                      <div className="bg-amber-50 rounded-xl px-3 py-2 mb-3">
                        <p className="text-xs font-semibold text-amber-700 mb-0.5">對推薦結果的影響</p>
                        <p className="text-xs text-amber-800">{impactText}</p>
                      </div>

                      {/* 5. 來源確認 */}
                      <div className="bg-white rounded-xl p-3 mb-3">
                        <p className="text-xs font-semibold text-gray-700 mb-2">來源確認</p>
                        {sourceUrl ? (
                          <>
                            <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-blue-600 font-medium border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50 mb-2">
                              開啟官方來源 ↗
                            </a>
                            <p className="text-xs font-medium text-gray-600 mb-1.5">建議確認重點：</p>
                            <ol className="space-y-1 list-decimal list-inside">
                              {isTypeA ? (
                                <>
                                  <li className="text-xs text-gray-600">這兩條規則是否描述同一個優惠？</li>
                                  <li className="text-xs text-gray-600">新版是否已取代舊版？</li>
                                  <li className="text-xs text-gray-600">回饋幣種是否有變更（現金 vs 點數）？</li>
                                </>
                              ) : (
                                <>
                                  <li className="text-xs text-gray-600">{ruleB ? rewardDescLine(ruleB) : '此回饋'} 是總回饋還是加碼部分？</li>
                                  <li className="text-xs text-gray-600">加碼是否需要疊加基本回饋才成立？</li>
                                  <li className="text-xs text-gray-600">兩筆規則是否可以同時存在？</li>
                                </>
                              )}
                            </ol>
                          </>
                        ) : (
                          <>
                            <p className="text-xs text-gray-500 mb-2">此規則缺少官方來源，可信度較低</p>
                            <button
                              onClick={() => handleCopySearchKeyword(
                                `${selectedCard?.card_name ?? ''} ${ruleA ? ruleA.rule_name.slice(0, 15) : op._primaryRuleName.slice(0, 15)} 官方條款`
                              )}
                              className="text-xs text-gray-600 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 active:scale-95 transition-all">
                              複製搜尋關鍵字
                            </button>
                          </>
                        )}
                      </div>

                      {/* AI 判定 prompt 按鈕（只複製，不開啟） */}
                      {conflictPrompt && (
                        <>
                          <button onClick={() => handleCopyAiPrompt(conflictPrompt, op.primary_rule_id)}
                            className="w-full bg-amber-500 text-white text-xs font-medium py-2.5 rounded-xl hover:bg-amber-600 active:scale-95 transition-all mb-3">
                            {copiedPromptId === op.primary_rule_id ? '✓ 已複製！' : '複製 AI 判定問題'}
                          </button>
                          {promptFallback?.id === op.primary_rule_id && (
                            <textarea readOnly value={promptFallback.text} rows={6}
                              className="w-full mb-3 border border-amber-200 rounded-xl px-3 py-2.5 text-xs text-gray-700 bg-amber-50 resize-none focus:outline-none"
                              onFocus={e => e.target.select()} />
                          )}
                        </>
                      )}

                      {/* 決策按鈕 */}
                      {isTypeA ? (
                        <div className="space-y-2">
                          <button
                            onClick={() => ruleA && handleDeleteSingleRule(ruleA.rule_id, op)}
                            disabled={!hasTwoRules}
                            className="w-full bg-red-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-red-700 active:scale-95 transition-all disabled:opacity-40">
                            保留新規則，刪除舊規則
                          </button>
                          <button
                            onClick={() => ruleB && handleDeleteSingleRule(ruleB.rule_id, op)}
                            disabled={!hasTwoRules}
                            className="w-full bg-orange-500 text-white text-xs font-medium py-2 rounded-xl hover:bg-orange-600 active:scale-95 transition-all disabled:opacity-40">
                            保留舊規則，刪除新規則
                          </button>
                          <button onClick={() => handleBothKeepPendingReview(op)}
                            className="w-full bg-white border border-gray-300 text-gray-700 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 active:scale-95 transition-all">
                            兩筆都保留，標記待確認
                          </button>
                          <button onClick={() => skipOp(op.primary_rule_id)}
                            className="w-full bg-white border border-gray-200 text-gray-400 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                            略過此次審核
                          </button>
                          <p className="text-xs text-gray-400 text-center">{SKIP_NOTE}</p>
                        </div>
                      ) : showTypeBKeep ? (
                        <div>
                          <p className="text-xs font-semibold text-gray-700 mb-2">保留哪一筆？</p>
                          <div className="space-y-2 mb-3">
                            {sortedAB.map((rule, idx) => (
                              <label key={rule.rule_id} className={`flex items-center gap-2.5 p-2.5 rounded-xl cursor-pointer border transition-all ${
                                typeBSelectedId === rule.rule_id ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-white hover:border-gray-300'
                              }`}>
                                <input type="radio" name={`typeb-${op.primary_rule_id}`} value={rule.rule_id}
                                  checked={typeBSelectedId === rule.rule_id}
                                  onChange={() => setTypeBSelections(prev => ({ ...prev, [op.primary_rule_id]: rule.rule_id }))}
                                  className="accent-blue-600" />
                                <div>
                                  <p className="text-xs font-medium text-gray-800">{rule.rule_name}</p>
                                  <p className="text-xs text-gray-500">{rewardDescLine(rule)}｜{idx === 0 ? '較舊' : '較新'}</p>
                                </div>
                              </label>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => handleTypeBKeepOne(op)}
                              className="flex-1 bg-red-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-red-700 active:scale-95 transition-all">
                              確認保留選取的，刪除另一筆
                            </button>
                            <button onClick={() => setTypeBKeepMode(prev => ({ ...prev, [op.primary_rule_id]: false }))}
                              className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <button onClick={() => handleMarkNonStackable(op)}
                            className="w-full bg-yellow-500 text-white text-xs font-medium py-2 rounded-xl hover:bg-yellow-600 active:scale-95 transition-all">
                            標記兩筆不可自動疊加
                          </button>
                          <button onClick={() => setTypeBKeepMode(prev => ({ ...prev, [op.primary_rule_id]: true }))}
                            className="w-full bg-white border border-gray-300 text-gray-700 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 active:scale-95 transition-all">
                            保留其中一筆
                          </button>
                          <button onClick={() => skipOp(op.primary_rule_id)}
                            className="w-full bg-white border border-gray-200 text-gray-400 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                            略過此次審核
                          </button>
                          <p className="text-xs text-gray-400 text-center">{SKIP_NOTE}</p>
                        </div>
                      )}

                      {/* 展開原始欄位差異（預設收合） */}
                      {hasTwoRules && ruleA && ruleB && (
                        <details className="mt-3">
                          <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 select-none">
                            展開原始欄位差異
                          </summary>
                          <div className="mt-2 bg-white rounded-xl p-3 overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-gray-400">
                                  <th className="text-left py-1 pr-2 font-medium w-1/4">欄位</th>
                                  <th className="text-left py-1 pr-2 font-medium">舊規則</th>
                                  <th className="text-left py-1 font-medium">新規則</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-50">
                                {[
                                  { label: '名稱', a: ruleA.rule_name, b: ruleB.rule_name },
                                  { label: '回饋', a: rewardDescLine(ruleA), b: rewardDescLine(ruleB) },
                                  { label: '適用分類', a: categoryZh(ruleA.category), b: categoryZh(ruleB.category) },
                                  { label: '有效期間', a: `${formatDate(ruleA.valid_from)}~${formatDate(ruleA.valid_to)}`, b: `${formatDate(ruleB.valid_from)}~${formatDate(ruleB.valid_to)}` },
                                  { label: '需登錄', a: ruleA.requires_registration === 'yes' ? '是' : '否', b: ruleB.requires_registration === 'yes' ? '是' : '否' },
                                  { label: '回饋上限', a: ruleA.reward_cap_amount != null ? `NT$${ruleA.reward_cap_amount}` : '—', b: ruleB.reward_cap_amount != null ? `NT$${ruleB.reward_cap_amount}` : '—' },
                                  { label: '最低消費', a: ruleA.min_spending != null ? `NT$${ruleA.min_spending}` : '—', b: ruleB.min_spending != null ? `NT$${ruleB.min_spending}` : '—' },
                                ].map(row => {
                                  const isDiff = row.a !== row.b
                                  return (
                                    <tr key={row.label} className={isDiff ? 'text-orange-700 font-medium' : 'text-gray-600'}>
                                      <td className="py-1.5 pr-2">{row.label}</td>
                                      <td className="py-1.5 pr-2 break-all">{row.a}</td>
                                      <td className="py-1.5 break-all">{row.b}</td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      )}
                    </div>
                  )
                }

                // ── no_action ─────────────────────────────────
                if (op.operation_type === 'no_action') {
                  const rule = cardRules.find(r => r.rule_id === op.primary_rule_id)
                  return (
                    <div key={op.primary_rule_id} className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">無問題</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONF_BADGE[op.confidence] ?? 'bg-gray-100 text-gray-600'}`}>
                          {CONF_LABEL[op.confidence] ?? op.confidence}
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-gray-900">{op._primaryRuleName}</p>
                      {rule && <p className="text-xs text-gray-500 mt-0.5">{humanSummaryLine(rule)}</p>}
                      <p className="text-xs text-gray-600 mt-2 leading-relaxed">{op.reason}</p>
                      <div className="flex gap-2 mt-3">
                        <button onClick={() => applyOp(op)}
                          className="flex-1 bg-gray-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-gray-700 active:scale-95 transition-all">
                          標記已確認
                        </button>
                        <button onClick={() => skipOp(op.primary_rule_id)}
                          className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                          略過
                        </button>
                      </div>
                    </div>
                  )
                }

                // ── mark_expired 及其他 fallback ─────────────
                {
                  const rule = cardRules.find(r => r.rule_id === op.primary_rule_id)
                  const badgeMap: Record<string, string> = {
                    mark_expired: 'bg-purple-100 text-purple-700',
                  }
                  const labelMap: Record<string, string> = {
                    mark_expired: '疑似已過期',
                  }
                  return (
                    <div key={op.primary_rule_id} className="rounded-2xl border border-gray-200 bg-white p-4">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badgeMap[op.operation_type] ?? 'bg-gray-100 text-gray-600'}`}>
                          {labelMap[op.operation_type] ?? op.operation_type}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CONF_BADGE[op.confidence] ?? 'bg-gray-100 text-gray-600'}`}>
                          {CONF_LABEL[op.confidence] ?? op.confidence}
                        </span>
                        {op.requires_human_review && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">需人工確認</span>}
                      </div>
                      <p className="text-sm font-semibold text-gray-900">{op._primaryRuleName}</p>
                      {rule && <p className="text-xs text-gray-500 mt-0.5">{humanSummaryLine(rule)}</p>}
                      {op._affectedRuleNames.length > 0 && (
                        <p className="text-xs text-gray-500 mt-1.5">相關規則：{op._affectedRuleNames.join('、')}</p>
                      )}
                      <p className="text-xs text-gray-600 mt-2 leading-relaxed">{op.reason}</p>
                      <div className="flex gap-2 mt-3">
                        <button onClick={() => applyOp(op)}
                          className="flex-1 bg-amber-500 text-white text-xs font-medium py-2 rounded-xl hover:bg-amber-600 active:scale-95 transition-all">
                          套用標記
                        </button>
                        <button onClick={() => skipOp(op.primary_rule_id)}
                          className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                          略過
                        </button>
                      </div>
                    </div>
                  )
                }
              })}
            </div>
          </div>
        )}

        {applyCount > 0 && reviewOps.length === 0 && (
          <div className="rounded-xl px-4 py-3 text-sm font-medium mb-4 bg-green-50 text-green-700">
            已套用 {applyCount} 條建議，可至規則健康度查看標記結果
          </div>
        )}
      </div>
    </main>
  )
}
