'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// ── Types ────────────────────────────────────────────────────────

type CardOption = { card_id: string; card_name: string; bank_name: string }

type ExistingRule = {
  rule_id: string; rule_name: string; category: string | null
  reward_type: string; reward_rate: number | null; reward_fixed_amount: number | null
  min_spending: number | null; reward_cap_amount: number | null
  valid_from: string | null; valid_to: string | null; confidence: string | null
}

type ExtractedRule = {
  temp_id: string; rule_name: string; category: string
  applicable_merchants: string | null; applicable_payment_methods: string | null
  reward_type: string; reward_rate: number | null; reward_fixed_amount: number | null
  min_spending: number | null; reward_cap_amount: number | null; reward_cap_cycle: string | null
  requires_registration: string | null; requires_new_customer: string | null
  new_customer_definition_text: string | null; new_customer_check_mode: string | null
  excludes_third_party_payment: string | null
  valid_from: string | null; valid_to: string | null
  confidence: string | null; evidence_snippets: string[]
}

type ComparisonItem = {
  new_temp_id: string; existing_rule_id: string | null
  relationship: 'duplicate' | 'possible_update' | 'conflict' | 'unrelated'
  confidence: string; reason: string
  recommended_action: 'create_new' | 'update_existing' | 'mark_duplicate' | 'needs_review'
}

type Warning = { type: string; message: string }

type ReviewRule = ExtractedRule & {
  _risk: 'low' | 'medium' | 'high'
  _comparison: ComparisonItem | null
  _duplicate: boolean
  _existingRule: ExistingRule | null
  _status: 'pending' | 'saved' | 'skipped'
}

// ── Constants ────────────────────────────────────────────────────

const ALLOWED_WARNING_TYPES = new Set(['missing_info', 'ambiguous_condition', 'possible_exclusion', 'date_unclear'])

const CATEGORIES = [
  { value: 'travel', label: '旅遊' },       { value: 'flight', label: '機票' },
  { value: 'hotel', label: '飯店' },         { value: 'online_shopping', label: '網購' },
  { value: 'restaurant', label: '餐廳' },    { value: 'food_delivery', label: '外送' },
  { value: 'convenience_store', label: '超商' }, { value: 'supermarket', label: '超市' },
  { value: 'department_store', label: '百貨' }, { value: 'mobile_payment', label: '行動支付' },
  { value: 'foreign_currency', label: '海外/外幣' }, { value: 'general', label: '一般消費' },
  { value: 'new_customer_bonus', label: '新戶活動' }, { value: 'easycard_auto_reload', label: '悠遊卡' },
  { value: 'subscription', label: '訂閱' },  { value: 'ai_service', label: 'AI服務' },
]

const CATEGORY_ABBR: Record<string, string> = {
  travel: 'trv', flight: 'flt', hotel: 'htl', online_shopping: 'os',
  restaurant: 'rst', food_delivery: 'fd', convenience_store: 'cvs',
  supermarket: 'sup', department_store: 'dep', mobile_payment: 'mp',
  foreign_currency: 'fx', general: 'gen', new_customer_bonus: 'ncb',
  easycard_auto_reload: 'ear', subscription: 'sub', ai_service: 'ai',
}

const RISK_STYLE = {
  low:    { border: 'border-green-200 bg-green-50',   badge: 'bg-green-100 text-green-700',   label: '低風險' },
  medium: { border: 'border-yellow-200 bg-yellow-50', badge: 'bg-yellow-100 text-yellow-700', label: '中風險' },
  high:   { border: 'border-red-200 bg-red-50',       badge: 'bg-red-100 text-red-700',       label: '高風險' },
}

const CLAUDE_TAIL = `請只輸出 JSON，不要使用 Markdown code block，不要加入解釋文字。
如果條款資訊不足，請在欄位填 null。`

const CHATGPT_TAIL = `請輸出可被 JSON.parse() 直接解析的 JSON。
不要使用 Markdown code block、表格、摘要或補充說明。
所有不確定資訊請填 null，不要自行補完。`

// ── Helpers ──────────────────────────────────────────────────────

function fp(cardId: string, r: { category?: string | null; reward_type?: string | null; reward_rate?: number | null; min_spending?: number | null; reward_cap_amount?: number | null; valid_from?: string | null; valid_to?: string | null }): string {
  return [cardId, r.category ?? '', r.reward_type ?? '', String(r.reward_rate ?? ''), String(r.min_spending ?? 0), String(r.reward_cap_amount ?? ''), r.valid_from ?? '', r.valid_to ?? ''].join('|')
}

function calcRisk(rule: ExtractedRule, cmp: ComparisonItem | null, isDup: boolean): 'low' | 'medium' | 'high' {
  if (
    isDup ||
    cmp?.relationship === 'conflict' ||
    cmp?.recommended_action === 'update_existing' ||
    cmp?.recommended_action === 'mark_duplicate' ||
    rule.reward_rate === null ||
    rule.valid_to === null
  ) return 'high'
  if (
    rule.confidence === 'high' &&
    rule.applicable_merchants !== null &&
    (cmp === null || cmp.recommended_action === 'create_new')
  ) return 'low'
  return 'medium'
}

function genRuleId(cardId: string, category: string): string {
  const firstCat = (category ?? '').split(',')[0].trim()
  const abbr = CATEGORY_ABBR[firstCat] ?? (firstCat.slice(0, 3) || 'gen')
  const rand = Math.random().toString(36).slice(2, 6)
  const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '')
  return `${cardId}-${abbr}-${rand}-${yyyymm}`
}

function rewardLabel(r: ExtractedRule | ExistingRule): string {
  if (r.reward_type === 'cashback' && r.reward_rate != null) return `現金回饋 ${(r.reward_rate * 100).toFixed(1)}%`
  if (r.reward_type === 'fixed_amount' && r.reward_fixed_amount != null) return `固定回饋 NT$${r.reward_fixed_amount}`
  if (r.reward_type === 'points' && r.reward_rate != null) return `點數回饋 ${(r.reward_rate * 100).toFixed(1)}%`
  return r.reward_type ?? '—'
}

function humanSummaryLine(r: {
  reward_type: string
  reward_rate: number | null
  reward_fixed_amount: number | null
  reward_cap_amount: number | null
  requires_registration?: string | null
}): string {
  let reward = ''
  if (r.reward_type === 'cashback' && r.reward_rate != null) {
    reward = `回饋 ${(r.reward_rate * 100).toFixed(1)}%`
  } else if (r.reward_type === 'fixed_amount' && r.reward_fixed_amount != null) {
    reward = `贈 NT$${r.reward_fixed_amount.toLocaleString()}`
  } else if (r.reward_type === 'points' && r.reward_fixed_amount != null) {
    reward = `贈 ${r.reward_fixed_amount.toLocaleString()} 點`
  } else if (r.reward_type === 'points' && r.reward_rate != null) {
    reward = `點數回饋 ${(r.reward_rate * 100).toFixed(1)}%`
  } else {
    reward = r.reward_type ?? '—'
  }
  const cap = r.reward_cap_amount != null ? `上限 NT$${r.reward_cap_amount.toLocaleString()}` : '無上限'
  const parts: string[] = [reward, cap]
  if (r.requires_registration === 'yes') parts.push('需登錄')
  else if (r.requires_registration === 'no') parts.push('無需登錄')
  return parts.join('｜')
}

function buildReviewNote(rule: ReviewRule): string {
  const reasons: string[] = []

  if (rule._duplicate || rule._comparison?.recommended_action === 'mark_duplicate') {
    reasons.push('疑似與既有規則重複')
  } else if (rule._comparison?.recommended_action === 'update_existing') {
    const r = rule._comparison.reason
    reasons.push(r ? `AI 建議更新：${r}` : 'AI 建議更新既有規則')
  } else if (rule._comparison?.relationship === 'conflict') {
    reasons.push('與既有規則可能衝突')
  }

  if (rule.confidence === 'low') {
    reasons.push('AI 信心度偏低，建議確認回饋率')
  }

  if (rule.valid_to === null) {
    reasons.push('缺少有效期限')
  }

  if (rule.reward_rate === null && rule.reward_fixed_amount === null) {
    reasons.push('缺少回饋金額資訊')
  }

  return reasons.join('；') || '新增時標記待審核'
}

function buildPrompt(
  cardName: string, bankName: string, sourceUrl: string,
  existingRules: ExistingRule[], selectedCategories: string[], content: string,
): string {
  const existingJson = JSON.stringify(
    existingRules.map(r => ({
      rule_id: r.rule_id, rule_name: r.rule_name, category: r.category,
      reward_type: r.reward_type, reward_rate: r.reward_rate,
      reward_fixed_amount: r.reward_fixed_amount, min_spending: r.min_spending,
      reward_cap_amount: r.reward_cap_amount, valid_from: r.valid_from, valid_to: r.valid_to,
    })),
    null, 2
  )

  return `你是信用卡優惠資料分析助手。請分析以下信用卡的優惠規則並輸出結構化 JSON。

【卡片資訊】
卡片名稱：${cardName}
銀行：${bankName}
官方活動頁：${sourceUrl || '（未提供）'}

【現有規則（請比對，勿重複新增）】
${existingJson}

【條款內容】
${content}

【請分析】
針對以下消費情境找出優惠規則：${selectedCategories.join(', ')}

【輸出格式】
只輸出以下 JSON，不要加任何說明文字或 Markdown：

{
  "extracted_rules": [
    {
      "temp_id": "new_1",
      "rule_name": "",
      "category": "消費分類（逗號分隔，可用：${CATEGORIES.map(c => c.value).join(', ')}）",
      "applicable_merchants": "不限填 all，指定商家填清單",
      "applicable_payment_methods": "不限填 all",
      "reward_type": "cashback | points | fixed_amount",
      "reward_rate": null,
      "reward_fixed_amount": null,
      "min_spending": 0,
      "reward_cap_amount": null,
      "reward_cap_cycle": "none | monthly | monthly_statement | campaign",
      "requires_registration": "yes | no",
      "requires_new_customer": "yes | no",
      "new_customer_definition_text": null,
      "new_customer_check_mode": "user_confirm_required | system_checkable | unknown",
      "excludes_third_party_payment": "yes | no | unknown",
      "valid_from": "YYYY-MM-DD or null",
      "valid_to": "YYYY-MM-DD or null",
      "confidence": "high | medium | low",
      "evidence_snippets": ["最多3句關鍵原文依據"]
    }
  ],
  "comparison_with_existing_rules": [
    {
      "new_temp_id": "new_1",
      "existing_rule_id": "rule_xxx or null",
      "relationship": "duplicate | possible_update | conflict | unrelated",
      "confidence": "high | medium | low",
      "reason": "說明為什麼這樣判斷",
      "recommended_action": "create_new | update_existing | mark_duplicate | needs_review"
    }
  ],
  "warnings": [
    {
      "type": "missing_info | ambiguous_condition | possible_exclusion | date_unclear",
      "message": "一句話說明，不超過 30 個字，不要引用條款原文。例：此規則有多項排除條件，建議刷卡前確認官方說明。"
    }
  ]
}`
}

// ── Component ────────────────────────────────────────────────────

export default function ImportPage() {
  const [cards, setCards] = useState<CardOption[]>([])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>(CATEGORIES.map(c => c.value))
  const [mode, setMode] = useState<'url' | 'text'>('text')
  const [urlInput, setUrlInput] = useState('')
  const [textInput, setTextInput] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [existingRules, setExistingRules] = useState<ExistingRule[]>([])

  const [prompt, setPrompt] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [jsonInput, setJsonInput] = useState('')
  const [parseError, setParseError] = useState('')
  const [warnings, setWarnings] = useState<Warning[]>([])
  const [reviewRules, setReviewRules] = useState<ReviewRule[]>([])
  const [saveCount, setSaveCount] = useState(0)
  const saveResultRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    supabase.from('cards').select('card_id, card_name, banks(bank_name)').eq('status', 'active').order('card_name')
      .then(({ data }) => {
        if (!data) return
        setCards((data as unknown as { card_id: string; card_name: string; banks: { bank_name: string } | null }[])
          .map(c => ({ card_id: c.card_id, card_name: c.card_name, bank_name: c.banks?.bank_name ?? '' })))
      })
  }, [])

  useEffect(() => {
    if (!selectedCardId) { setExistingRules([]); return }
    supabase.from('offer_rules')
      .select('rule_id, rule_name, category, reward_type, reward_rate, reward_fixed_amount, min_spending, reward_cap_amount, valid_from, valid_to, confidence')
      .eq('card_id', selectedCardId)
      .then(({ data }) => setExistingRules((data || []) as ExistingRule[]))
  }, [selectedCardId])

  const selectedCard = cards.find(c => c.card_id === selectedCardId)

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 3000)
  }

  function toggleCategory(val: string) {
    setSelectedCategories(prev => prev.includes(val) ? prev.filter(c => c !== val) : [...prev, val])
  }

  async function handleGenerate() {
    if (!selectedCard) return
    let content = ''
    if (mode === 'url') {
      if (!urlInput.trim()) return
      setFetching(true); setFetchError('')
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = await fetch('/api/fetch-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ url: urlInput.trim() }),
        })
        const json = await res.json() as { content?: string; error?: string }
        if (json.error) { setFetchError(`抓取失敗：${json.error}。請改用「貼條款文字」模式。`); setFetching(false); return }
        content = json.content ?? ''
      } catch { setFetchError('網路錯誤，請改用「貼條款文字」模式。'); setFetching(false); return }
      setFetching(false)
    } else {
      content = textInput.trim()
      if (!content) return
    }
    setPrompt(buildPrompt(selectedCard.card_name, selectedCard.bank_name, mode === 'url' ? urlInput.trim() : '', existingRules, selectedCategories, content))
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
    setParseError(''); setWarnings([]); setReviewRules([]); setSaveCount(0)
    let parsed: unknown
    try { parsed = JSON.parse(jsonInput) } catch (e) { setParseError(`JSON 解析失敗：${String(e)}`); return }
    const p = parsed as { extracted_rules?: unknown; comparison_with_existing_rules?: unknown; warnings?: unknown }
    if (!Array.isArray(p.extracted_rules)) { setParseError('格式錯誤：缺少 extracted_rules 陣列'); return }

    const extractedRules = p.extracted_rules as ExtractedRule[]
    const comparisons = Array.isArray(p.comparison_with_existing_rules) ? p.comparison_with_existing_rules as ComparisonItem[] : []
    const warnList = Array.isArray(p.warnings)
      ? (p.warnings as Warning[]).filter(w => ALLOWED_WARNING_TYPES.has(w.type))
      : []

    const compMap = new Map<string, ComparisonItem>()
    for (const c of comparisons) if (c.new_temp_id) compMap.set(c.new_temp_id, c)

    const existingMap = new Map<string, ExistingRule>()
    for (const r of existingRules) existingMap.set(r.rule_id, r)

    const existingFps = new Set(existingRules.map(r => fp(selectedCardId, r)))

    const reviews: ReviewRule[] = extractedRules.map(rule => {
      const cmp = compMap.get(rule.temp_id) ?? null
      const isDup = existingFps.has(fp(selectedCardId, rule))
      const existingRule = cmp?.existing_rule_id ? existingMap.get(cmp.existing_rule_id) ?? null : null
      return { ...rule, _risk: calcRisk(rule, cmp, isDup), _comparison: cmp, _duplicate: isDup, _existingRule: existingRule, _status: 'pending' as const }
    })

    setWarnings(warnList)
    setReviewRules(reviews)
  }

  async function saveRule(rule: ReviewRule) {
    if (!selectedCardId) return
    const today = new Date().toISOString().split('T')[0]
    const ruleId = genRuleId(selectedCardId, rule.category)
    const { error } = await supabase.from('offer_rules').insert({
      rule_id: ruleId, card_id: selectedCardId,
      rule_name: rule.rule_name, category: rule.category ?? '',
      applicable_merchants: rule.applicable_merchants ?? null,
      applicable_payment_methods: rule.applicable_payment_methods ?? null,
      reward_type: rule.reward_type ?? 'cashback',
      reward_rate: rule.reward_rate ?? 0, reward_fixed_amount: rule.reward_fixed_amount ?? 0,
      min_spending: rule.min_spending ?? 0, reward_cap_amount: rule.reward_cap_amount ?? null,
      reward_cap_cycle: rule.reward_cap_cycle ?? 'none',
      requires_registration: rule.requires_registration ?? 'no',
      requires_new_customer: rule.requires_new_customer ?? 'no',
      new_customer_definition_text: rule.new_customer_definition_text ?? null,
      new_customer_check_mode: rule.new_customer_check_mode ?? 'unknown',
      excludes_third_party_payment: rule.excludes_third_party_payment ?? 'unknown',
      requires_user_action: false, action_label: null, exclusive_group_key: null,
      calculation_basis: 'calendar_month',
      valid_from: rule.valid_from ?? null, valid_to: rule.valid_to ?? null,
      extra_conditions_json: null,
      notes: rule.evidence_snippets?.join(' | ') ?? null,
      confidence: rule.confidence ?? 'medium',
      review_status: rule._risk === 'low' || rule._risk === 'medium' ? 'human_reviewed' : 'needs_review', source_updated_at: today,
      review_note: rule._risk === 'low' || rule._risk === 'medium' ? null : buildReviewNote(rule),
      source_url: mode === 'url' ? urlInput.trim() : null,
    })
    if (error) { alert(`儲存失敗：${error.message}`); return }
    setReviewRules(prev => prev.map(r => r.temp_id === rule.temp_id ? { ...r, _status: 'saved' as const } : r))
    setSaveCount(prev => prev + 1)
    setTimeout(() => {
      setReviewRules(prev => prev.filter(r => r.temp_id !== rule.temp_id))
    }, 1500)
  }

  async function saveAndDeactivateExisting(rule: ReviewRule) {
    if (!rule._existingRule) { await saveRule(rule); return }
    const { error } = await supabase.from('offer_rules')
      .update({ review_status: 'deactivated', review_note: 'AI 輔助匯入：被新版規則取代，已停用' })
      .eq('rule_id', rule._existingRule.rule_id)
    if (error) { alert(`停用舊規則失敗：${error.message}`); return }
    await saveRule(rule)
  }

  function skipRule(tempId: string) {
    setReviewRules(prev => prev.map(r => r.temp_id === tempId ? { ...r, _status: 'skipped' as const } : r))
  }

  const pendingCount = reviewRules.filter(r => r._status === 'pending').length
  const canGenerate = !!selectedCard && selectedCategories.length > 0 && (mode === 'url' ? !!urlInput.trim() : !!textInput.trim())

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">

        <div className="flex items-center gap-3 mb-6">
          <Link href="/rules" className="text-gray-400 hover:text-gray-600 text-sm">← 規則健康度</Link>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-1">AI 輔助新增規則</h1>
        <p className="text-sm text-gray-500 mb-6">產生分析 Prompt，貼給 Claude 或 ChatGPT，再把 JSON 回填存入資料庫</p>

        {/* Toast */}
        {toast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg whitespace-nowrap">
            {toast}
          </div>
        )}

        {/* Step 1: Card + Categories */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 1　選擇卡片與消費情境</p>
          <select
            value={selectedCardId}
            onChange={e => { setSelectedCardId(e.target.value); setReviewRules([]); setSaveCount(0) }}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3"
          >
            <option value="">請選擇要新增規則的卡片</option>
            {cards.map(c => <option key={c.card_id} value={c.card_id}>{c.bank_name} {c.card_name}</option>)}
          </select>
          {selectedCardId && (
            <p className="text-xs text-gray-400 mb-3">此卡片目前有 {existingRules.length} 條規則（將附在 Prompt 中供 AI 比對）</p>
          )}

          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 font-medium">分析消費情境</p>
            <button type="button"
              onClick={() => setSelectedCategories(prev => prev.length === CATEGORIES.length ? [] : CATEGORIES.map(c => c.value))}
              className="text-xs text-blue-500 hover:text-blue-700">
              {selectedCategories.length === CATEGORIES.length ? '取消全選' : '全選'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map(c => (
              <button key={c.value} type="button" onClick={() => toggleCategory(c.value)}
                className={`px-2.5 py-1 rounded-full text-xs border transition-all ${selectedCategories.includes(c.value) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500 border-gray-200 hover:border-blue-300'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Step 2: Input */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 2　輸入條款來源</p>
          <div className="flex gap-2 mb-4">
            <button type="button" onClick={() => { setMode('text'); setFetchError('') }}
              className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-all ${mode === 'text' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}>
              貼條款文字
            </button>
            <button type="button" onClick={() => { setMode('url'); setFetchError('') }}
              className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-all ${mode === 'url' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}>
              貼活動頁 URL
            </button>
          </div>
          {mode === 'text' ? (
            <textarea value={textInput} onChange={e => setTextInput(e.target.value)}
              placeholder="將銀行官方活動頁的條款文字複製貼入此處..." rows={8}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          ) : (
            <div className="space-y-2">
              <input type="url" value={urlInput} onChange={e => { setUrlInput(e.target.value); setFetchError('') }}
                placeholder="https://..."
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <p className="text-xs text-gray-400">注意：部分銀行頁面使用 JavaScript 動態載入，若抓取失敗請改用「貼條款文字」模式</p>
              {fetchError && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{fetchError}</p>}
            </div>
          )}
        </div>

        {/* Step 3: Generate + 3 buttons */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 3　產生 Prompt 並送給 AI</p>
          <button type="button" onClick={handleGenerate} disabled={!canGenerate || fetching}
            className="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl hover:bg-blue-700 active:scale-95 transition-all text-sm disabled:opacity-50 mb-3">
            {fetching ? '抓取網頁中...' : '產生分析 Prompt'}
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

        {/* Step 4: JSON + validate */}
        <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">步驟 4　貼回 JSON，確認並存入</p>
          {!selectedCardId ? (
            <p className="text-sm text-gray-400 text-center py-4">請先完成步驟 1 選擇卡片</p>
          ) : (
            <>
              <textarea value={jsonInput} onChange={e => { setJsonInput(e.target.value); setParseError('') }}
                placeholder={'將 AI 回傳的 JSON 貼入此處...\n{\n  "extracted_rules": [...],\n  "comparison_with_existing_rules": [...],\n  "warnings": [...]\n}'}
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

        {/* Review rules */}
        {reviewRules.length > 0 && (
          <div className="mb-4">
            <p className="text-sm font-semibold text-gray-700 mb-0.5">解析到 {reviewRules.length} 條規則</p>
            <p className="text-xs text-gray-400 mb-3">待確認 {pendingCount} 條・已存入 {saveCount} 條</p>
            <div className="space-y-3">
              {reviewRules.map(rule => {
                if (rule._status === 'saved') return (
                  <div key={rule.temp_id} className="rounded-2xl border border-green-100 bg-green-50 px-4 py-3 flex items-center gap-2">
                    <span className="text-green-600">✓</span>
                    <p className="text-sm text-green-700 font-medium flex-1">{rule.rule_name}</p>
                    <span className="text-xs text-green-500">已存入</span>
                  </div>
                )
                if (rule._status === 'skipped') return (
                  <div key={rule.temp_id} className="rounded-2xl border border-gray-100 bg-gray-50 px-4 py-3 flex items-center gap-2 opacity-50">
                    <p className="text-sm text-gray-400 line-through flex-1">{rule.rule_name}</p>
                    <span className="text-xs text-gray-400">已略過</span>
                  </div>
                )

                const isDupCase = rule._duplicate || rule._comparison?.recommended_action === 'mark_duplicate'

                if (isDupCase) {
                  const existingR = rule._existingRule
                  return (
                    <div key={rule.temp_id} className="rounded-2xl border border-orange-200 bg-orange-50 p-4">
                      <p className="text-sm font-semibold text-orange-800 mb-3">⚠️ 疑似重複</p>
                      <p className="text-xs text-gray-600 mb-3">這條規則可能已經存在：</p>
                      <div className="bg-white rounded-xl p-3 mb-3 space-y-3">
                        <div>
                          <p className="text-xs font-semibold text-gray-500 mb-1">【新規則】</p>
                          <p className="text-sm font-medium text-gray-900">{rule.rule_name}</p>
                          <p className="text-xs text-gray-600 mt-0.5">{humanSummaryLine(rule)}</p>
                        </div>
                        <div className="border-t border-gray-100 pt-3">
                          <p className="text-xs font-semibold text-gray-500 mb-1">【可能重複的規則】</p>
                          {existingR ? (
                            <>
                              <p className="text-sm font-medium text-gray-900">{existingR.rule_name}</p>
                              <p className="text-xs text-gray-600 mt-0.5">{humanSummaryLine(existingR)}</p>
                            </>
                          ) : (
                            <p className="text-xs text-gray-500 italic">（同上，內容完全相同）</p>
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-orange-700 mb-3">建議：這條規則已存在，不需要重複新增。</p>
                      <div className="flex gap-2">
                        <button onClick={() => skipRule(rule.temp_id)}
                          className="flex-1 bg-orange-100 text-orange-700 text-xs font-medium py-2 rounded-xl hover:bg-orange-200 active:scale-95 transition-all">
                          略過，不新增
                        </button>
                        <button onClick={() => saveRule(rule)}
                          className="flex-1 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 active:scale-95 transition-all">
                          仍要新增為獨立規則
                        </button>
                      </div>
                    </div>
                  )
                }

                const rs = RISK_STYLE[rule._risk]
                const isUpdate = rule._comparison?.recommended_action === 'update_existing'

                return (
                  <div key={rule.temp_id} className={`rounded-2xl border p-4 ${rs.border}`}>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${rs.badge}`}>{rs.label}</span>
                      {rule.confidence && <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${rule.confidence === 'high' ? 'bg-green-100 text-green-700' : rule.confidence === 'low' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}`}>信心度 {rule.confidence}</span>}
                    </div>

                    <p className="text-sm font-semibold text-gray-900">{rule.rule_name}</p>
                    <p className="text-xs text-blue-700 font-medium mt-0.5">{rewardLabel(rule)}</p>

                    <div className="mt-2 space-y-0.5 text-xs text-gray-600">
                      {rule.min_spending ? <p>最低消費：NT${(rule.min_spending ?? 0).toLocaleString()}</p> : null}
                      {(rule.valid_from || rule.valid_to) && <p>活動期間：{rule.valid_from ?? '—'} ～ {rule.valid_to ?? '—'}</p>}
                      {rule.applicable_merchants && <p>適用通路：{rule.applicable_merchants}</p>}
                      {rule.requires_registration === 'yes' && <p>需活動登錄：是</p>}
                      {rule.excludes_third_party_payment === 'yes' && <p>排除第三方支付：是</p>}
                    </div>

                    <div className="flex flex-wrap gap-1 mt-2">
                      {(rule.category ?? '').split(',').map(c => c.trim()).filter(Boolean).map(c => (
                        <span key={c} className="text-xs bg-white bg-opacity-60 text-gray-500 px-2 py-0.5 rounded-full">{c}</span>
                      ))}
                    </div>

                    {/* High risk: update diff */}
                    {rule._risk === 'high' && isUpdate && rule._existingRule && (
                      <div className="mt-3 bg-white bg-opacity-70 rounded-xl p-3 text-xs">
                        <p className="font-medium text-red-700 mb-1">AI 建議更新既有規則</p>
                        <p className="text-gray-600">原規則：{rule._existingRule.rule_name}・{rewardLabel(rule._existingRule)}・到期 {rule._existingRule.valid_to ?? '—'}</p>
                        <p className="text-gray-600 mt-0.5">新版本：{rule.rule_name}・{rewardLabel(rule)}・到期 {rule.valid_to ?? '—'}</p>
                        {rule._comparison?.reason && <p className="text-gray-400 mt-1 italic">{rule._comparison.reason}</p>}
                      </div>
                    )}

                    {/* Evidence */}
                    {(rule.evidence_snippets?.length ?? 0) > 0 && (
                      <p className="text-xs text-gray-500 mt-2 italic">「{rule.evidence_snippets[0]}」</p>
                    )}

                    {/* Warnings（摺疊） */}
                    {warnings.length > 0 && (
                      <details className="mt-2">
                        <summary className="text-xs text-amber-600 cursor-pointer select-none hover:text-amber-800">
                          ⚠ AI 標注此規則有注意事項
                        </summary>
                        <ul className="mt-1.5 space-y-0.5 pl-1">
                          {warnings.map((w, i) => (
                            <li key={i} className="text-xs text-amber-700">• {w.message}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {/* Action buttons */}
                    <div className="flex gap-2 mt-3">
                      {rule._risk === 'low' && (
                        <button onClick={() => saveRule(rule)}
                          className="flex-1 bg-green-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-green-700 active:scale-95 transition-all">
                          一鍵採納
                        </button>
                      )}
                      {rule._risk === 'medium' && (
                        <button onClick={() => saveRule(rule)}
                          className="flex-1 bg-blue-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-blue-700 active:scale-95 transition-all">
                          確認新增
                        </button>
                      )}
                      {rule._risk === 'high' && isUpdate && (
                        <>
                          <button onClick={() => saveAndDeactivateExisting(rule)}
                            className="flex-1 bg-orange-500 text-white text-xs font-medium py-2 rounded-xl hover:bg-orange-600 active:scale-95 transition-all">
                            確認更新
                          </button>
                          <button onClick={() => saveRule(rule)}
                            className="flex-1 bg-gray-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-gray-700 active:scale-95 transition-all">
                            改為新增
                          </button>
                        </>
                      )}
                      {rule._risk === 'high' && !isUpdate && (
                        <button onClick={() => saveRule(rule)}
                          className="flex-1 bg-orange-500 text-white text-xs font-medium py-2 rounded-xl hover:bg-orange-600 active:scale-95 transition-all">
                          確認存入
                        </button>
                      )}
                      <button onClick={() => skipRule(rule.temp_id)}
                        className="px-4 bg-white border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-xl hover:bg-gray-50 transition-all">
                        略過
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Save result */}
        {saveCount > 0 && (
          <div ref={saveResultRef} className="rounded-xl px-4 py-3 text-sm font-medium mb-4 bg-green-50 text-green-700">
            ✅ 已存入 {saveCount} 條規則，標記為「待審核」
          </div>
        )}
      </div>
    </main>
  )
}
