'use client'

import { useState, useEffect } from 'react'
import {
  matchRules,
  matchNewCardRules,
  matchMarketCardRules,
  scoreRules,
  generateRecommendations,
  Recommendation,
  ScoredRule,
  MergedRec,
} from '@/lib/matchRules'
import { generatePrompt } from '@/lib/generatePrompt'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'

const CATEGORIES = [
  { value: 'travel',            label: '旅遊平台 / 訂房（Klook、KKday、Agoda 等）' },
  { value: 'online_shopping',   label: '網購（蝦皮、momo、PChome 等）' },
  { value: 'restaurant',        label: '餐廳（實體餐廳用餐）' },
  { value: 'food_delivery',     label: '外送（Uber Eats、Foodpanda）' },
  { value: 'convenience_store', label: '超商（7-11、全家、萊爾富）' },
  { value: 'supermarket',       label: '超市（全聯、家樂福）' },
  { value: 'department_store',  label: '百貨（新光三越、SOGO 等）' },
  { value: 'mobile_payment',    label: '行動支付（LINE Pay、街口、Apple Pay）' },
  { value: 'foreign_currency',  label: '海外 / 外幣消費（國外刷卡或外幣結帳）' },
  { value: 'general',           label: '一般消費（不屬於以上分類的日常消費）' },
  { value: 'tax',               label: '繳稅（所得稅、地價稅、牌照稅等）' },
  { value: 'bill_payment',      label: '繳費（水電費、電話費、學費等）' },
  { value: 'insurance',         label: '保費（各類保險費用）' },
  { value: 'gas_station',       label: '加油站' },
  { value: 'subscription',      label: '訂閱服務（Netflix、Spotify 等）' },
  { value: 'ai_service',        label: 'AI 服務（ChatGPT、Claude 等）' },
  { value: 'uncertain',         label: '不確定（顯示所有規則，讓我自己判斷）' },
]

const TIMING_OPTIONS = [
  { value: 'today', label: '今天' },
  { value: 'this_week', label: '本週內' },
  { value: 'this_month', label: '本月內' },
]

const PREFERENCES = [
  { key: 'canChangePlatform', label: '可以換平台' },
  { key: 'canChangePaymentMethod', label: '可以換付款方式' },
  { key: 'willingToApplyNewCard', label: '願意辦新卡' },
  { key: 'preferSimpleConditions', label: '希望條件簡單' },
]

const PI_CHIPS: { label: string; value: number | null }[] = [
  { label: '不確定', value: null },
  { label: '0 元', value: 0 },
  { label: '5,000', value: 5000 },
  { label: '10,000', value: 10000 },
  { label: '30,000+', value: 30000 },
]

const BADGE_STYLES: Record<string, string> = {
  best_practical:      'bg-green-100 text-green-700',
  highest_theoretical: 'bg-blue-100 text-blue-700',
  most_stable:         'bg-gray-100 text-gray-600',
  new_card:            'bg-purple-100 text-purple-700',
}

function mergeRecommendations(recs: Recommendation[]): MergedRec[] {
  const merged: MergedRec[] = []
  const ruleIdMap = new Map<string, MergedRec>()

  for (const rec of recs) {
    if (!rec.rule) {
      merged.push({ types: [rec.type], labels: [rec.label], rule: null })
    } else {
      const key = rec.rule.rule_id
      if (ruleIdMap.has(key)) {
        const existing = ruleIdMap.get(key)!
        existing.types.push(rec.type)
        existing.labels.push(rec.label)
      } else {
        const item: MergedRec = { types: [rec.type], labels: [rec.label], rule: rec.rule }
        ruleIdMap.set(key, item)
        merged.push(item)
      }
    }
  }

  return merged
}

const STATUS_BADGE: Record<string, string> = {
  A: 'bg-green-100 text-green-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700',
}

const STATUS_LABEL: Record<string, string> = {
  A: '可直接使用',
  B: '需先執行動作',
  C: '需補充資訊',
}

const REC_REASON: Record<string, string> = {
  best_practical:      '回饋與條件的最佳平衡',
  highest_theoretical: '回饋金額最高',
  most_stable:         '條件最單純，直刷即可',
  new_card:            '申辦後可獲得此優惠',
}

type FormData = {
  description: string
  amount: string
  category: string
  timing: string
  canChangePlatform: boolean
  canChangePaymentMethod: boolean
  willingToApplyNewCard: boolean
  preferSimpleConditions: boolean
  piAccumulated: number | null
}

function getRewardCurrencyInfo(r: ScoredRule): { label: string; isNonCash: boolean } {
  if (r.reward_type === 'cashback' || r.reward_type === 'fixed_amount') {
    return { label: '現金回饋', isNonCash: false }
  }
  if (r.reward_type === 'points') {
    const currency = (r.extra_conditions_json?.reward_currency as string) ?? '點數回饋'
    return { label: currency, isNonCash: true }
  }
  return { label: r.reward_type, isNonCash: false }
}

function MergedRecCard({ merged }: { merged: MergedRec }) {
  if (!merged.rule) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 p-4">
        <div className="flex flex-wrap gap-2 mb-3">
          {merged.types.map((type, i) => (
            <span key={type} className={`text-xs font-medium px-2.5 py-1 rounded-full ${BADGE_STYLES[type]}`}>
              {merged.labels[i]}
            </span>
          ))}
        </div>
        <p className="text-sm text-gray-400">目前沒有符合條件的方案</p>
      </div>
    )
  }

  const r = merged.rule
  const isNewCard = merged.types.includes('new_card')
  const primaryType = merged.types[0]
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {merged.types.map((type, i) => (
          <span key={type} className={`text-xs font-medium px-2.5 py-1 rounded-full ${BADGE_STYLES[type]}`}>
            {merged.labels[i]}
          </span>
        ))}
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_BADGE[r.cardStatus]}`}>
          {STATUS_LABEL[r.cardStatus]}
        </span>
      </div>

      <p className="text-xs text-gray-500">{r.bank_name}</p>
      <p className="text-base font-semibold text-gray-900 mt-0.5">{r.card_name}</p>
      <p className="text-sm text-gray-500 mt-0.5">{r.rule_name}</p>

      <div className="mt-3 bg-blue-50 rounded-xl px-3 py-2.5">
        <div className="flex items-center gap-2 mb-1">
          {(() => {
            const info = getRewardCurrencyInfo(r)
            return (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${info.isNonCash ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                {info.label}
              </span>
            )
          })()}
        </div>
        <p className="text-xl font-bold text-blue-700">
          {r.reward_type === 'points'
            ? `${r.theoreticalRewardTwd.toLocaleString()} ${(r.extra_conditions_json?.reward_currency as string) ?? '點'}`
            : `NT$ ${r.netRewardTwd.toLocaleString()} 回饋`}
        </p>
        <p className="text-xs text-blue-500 mt-0.5">
          有效回饋率 {(r.effectiveRewardRate * 100).toFixed(1)}%
          {r.capNeedsUserConfirmation && '（上限需確認）'}
        </p>
        {r.foreignFeeDeducted > 0 && (
          <p className="text-xs text-blue-400 mt-0.5">
            表定回饋 {r.theoreticalRewardTwd.toLocaleString()} 元，已扣除國外手續費 {r.foreignFeeDeducted.toLocaleString()} 元
          </p>
        )}
        {r.reward_type === 'points' && (
          r.effectiveValueTwd !== null
            ? <p className="text-xs text-blue-500 mt-1">等值參考：約 NT$ {r.effectiveValueTwd.toLocaleString()} 元</p>
            : <p className="text-xs text-amber-600 mt-1">⚠ 點數等值需自行確認</p>
        )}
      </div>

      {r.confirmItems.length > 0 && (
        <div className="mt-3 bg-amber-50 rounded-xl px-3 py-2.5">
          <p className="text-xs font-medium text-amber-700 mb-1.5">⚠ 使用前請確認</p>
          <ul className="space-y-1">
            {r.confirmItems.map((item, i) => (
              <li key={i} className="text-xs text-amber-800 flex gap-1.5">
                <span className="mt-0.5 shrink-0">•</span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.cardStatus === 'B' && r.action_label && (
        <div className="mt-3 bg-blue-50 rounded-xl px-3 py-2.5">
          <p className="text-xs font-medium text-blue-700 mb-1">刷卡前要做</p>
          <p className="text-xs text-blue-800">
            {r.exclusive_group_key === 'richart_daily_plan'
              ? r.action_label.replace('對應方案', `「${r.rule_name}」`)
              : r.action_label}
          </p>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        {REC_REASON[primaryType] ?? ''}
      </p>

      {isNewCard && (
        <div className="mt-3 bg-purple-50 rounded-xl px-3 py-2.5">
          <p className="text-xs font-medium text-purple-700 mb-1">你目前沒有這張卡，需先申辦才能使用此優惠</p>
          {r.official_card_url && (
            <a
              href={r.official_card_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-purple-600 underline"
            >
              前往官方申辦頁面
            </a>
          )}
        </div>
      )}

      {r.applicable_merchants && r.applicable_merchants !== '' && (
        <div className="mt-3">
          <p className="text-xs text-gray-400 mb-1.5">適用通路</p>
          {r.applicable_merchants === 'all' ? (
            <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">適用所有通路</span>
          ) : r.applicable_merchants === 'designated_merchants' ? (
            <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
              指定通路（
              {r.source_url
                ? <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="underline text-blue-500">請查官方活動頁</a>
                : '請查官方活動頁'
              }）
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {r.applicable_merchants.split(',').map((m) => m.trim()).filter(Boolean).map((m) => (
                <span key={m} className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{m}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function guessCategory(text: string): string | null {
  if (/稅|所得稅|地價稅|牌照稅/.test(text)) return 'tax'
  if (/保費|保險/.test(text)) return 'insurance'
  if (/水電|瓦斯|電話費|學費/.test(text)) return 'bill_payment'
  if (/加油|油站/.test(text)) return 'gas_station'
  if (/Klook|KKday|Agoda|Booking|訂房|飯店/i.test(text)) return 'travel'
  if (/機票|航空/.test(text)) return 'travel'
  if (/蝦皮|momo|PChome|網購/i.test(text)) return 'online_shopping'
  if (/餐廳|吃飯|用餐/.test(text)) return 'restaurant'
  if (/Uber Eats|Foodpanda|外送/i.test(text)) return 'food_delivery'
  if (/7-11|全家|便利商店|超商/.test(text)) return 'convenience_store'
  if (/全聯|家樂福|大潤發/.test(text)) return 'supermarket'
  if (/百貨|SOGO|新光/i.test(text)) return 'department_store'
  if (/Netflix|Spotify|訂閱/i.test(text)) return 'subscription'
  if (/ChatGPT|Claude|AI/i.test(text)) return 'ai_service'
  if (/海外|外幣|國外/.test(text)) return 'foreign_currency'
  if (/LINE Pay|街口|Apple Pay|行動支付/i.test(text)) return 'mobile_payment'
  return null
}

export default function AnalyzePage() {
  const { user } = useAuth()
  const userId = user?.id ?? 'me'

  const [form, setForm] = useState<FormData>({
    description: '',
    amount: '',
    category: '',
    timing: 'today',
    canChangePlatform: true,
    canChangePaymentMethod: true,
    willingToApplyNewCard: false,
    preferSimpleConditions: false,
    piAccumulated: null,
  })
  const [recommendations, setRecommendations] = useState<MergedRec[]>([])
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)
  const [hasPiCard, setHasPiCard] = useState(false)
  const [piShowCustom, setPiShowCustom] = useState(false)
  const [piCustom, setPiCustom] = useState('')
  const [heldCardNames, setHeldCardNames] = useState<string[]>([])
  const [marketRules, setMarketRules] = useState<ScoredRule[]>([])
  const [marketCopied, setMarketCopied] = useState(false)
  const [uncertainMode, setUncertainMode] = useState(false)
  const [autoSuggestMsg, setAutoSuggestMsg] = useState<{ type: 'success' | 'fail'; text: string } | null>(null)

  useEffect(() => {
    supabase
      .from('user_card_holdings')
      .select('card_id, cards(card_name, banks(bank_name))')
      .eq('user_id', userId)
      .eq('holding_status', 'holding')
      .then(({ data }) => {
        const holdings = (data || []) as unknown as Array<{
          card_id: string
          cards: { card_name: string; banks: { bank_name: string } | null } | null
        }>
        setHasPiCard(holdings.some(h => h.card_id === 'esun-pi'))
        setHeldCardNames(
          holdings.map(h => `${h.cards?.banks?.bank_name ?? ''} ${h.cards?.card_name ?? ''}`.trim())
        )
      })
  }, [])

  function handleToggle(key: keyof FormData) {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function handleAutoCategory() {
    if (!form.description.trim()) {
      setAutoSuggestMsg({ type: 'fail', text: '請先填寫「我要買什麼」' })
      setTimeout(() => setAutoSuggestMsg(null), 2500)
      return
    }
    const suggested = guessCategory(form.description)
    if (suggested) {
      const label = CATEGORIES.find(c => c.value === suggested)?.label ?? suggested
      setForm(prev => ({ ...prev, category: suggested }))
      setAutoSuggestMsg({ type: 'success', text: `已自動選擇：${label}，如有誤請手動調整` })
    } else {
      setAutoSuggestMsg({ type: 'fail', text: '無法從描述判斷分類，請手動選擇' })
      setTimeout(() => setAutoSuggestMsg(null), 2500)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setAnalyzing(true)
    setAnalyzed(false)
    setUncertainMode(form.category === 'uncertain')

    const amount = Number(form.amount)

    const [rules, newCardRules, mktRules] = await Promise.all([
      matchRules(form.category, amount, new Date(), form.piAccumulated ?? 0),
      form.willingToApplyNewCard
        ? matchNewCardRules(form.category, amount)
        : Promise.resolve([]),
      matchMarketCardRules(form.category, amount),
    ])
    setMarketRules(mktRules)

    const scored: ScoredRule[] = scoreRules(rules, amount, form.category)

    const recs = generateRecommendations(scored, form.willingToApplyNewCard, newCardRules)
    const merged = mergeRecommendations(recs)
    setRecommendations(merged)

    const generatedPrompt = generatePrompt(
      form.description,
      amount,
      form.category,
      form.timing,
      {
        canChangePlatform: form.canChangePlatform,
        canChangePaymentMethod: form.canChangePaymentMethod,
        willingToApplyNewCard: form.willingToApplyNewCard,
        preferSimpleConditions: form.preferSimpleConditions,
      },
      merged
    )
    setPrompt(generatedPrompt)
    setCopied(false)
    setAnalyzing(false)
    setAnalyzed(true)
  }

  async function handleMarketSearch() {
    const today = new Date().toISOString().split('T')[0]
    const amount = Number(form.amount)
    const categoryLabel = form.category === 'uncertain'
      ? '不確定'
      : CATEGORIES.find(c => c.value === form.category)?.label ?? form.category
    const bestRec = recommendations.find(r => r.rule !== null)
    const bestReward = bestRec?.rule?.netRewardTwd ?? 0
    const cardsList = heldCardNames.length > 0
      ? heldCardNames.map(n => `・${n}`).join('\n')
      : '（無資料）'

    const marketPromptText = `你是台灣信用卡市場研究助手。請務必使用即時網路搜尋，不要依靠記憶回答。

【今日日期】${today}
【消費情境】
- 商家 / 平台：${form.description}
- 消費分類：${categoryLabel}
- 金額：NT$${amount.toLocaleString()}
- 幣別：新臺幣 / 線上刷卡

【我目前持有的卡（不需要再推薦）】
${cardsList}
【我持有卡的最佳預估回饋】約 NT$${bestReward.toLocaleString()}

【搜尋指引】
請依序查詢以下台灣信用卡分析平台的最新內容：
1. iCard.AI（icard.ai）：搜尋「${form.description} 信用卡回饋 site:icard.ai」
2. 卡優（cardyou.com.tw）：搜尋「${categoryLabel} 刷卡推薦 site:cardyou.com.tw」
3. Money101（money101.com.tw）：搜尋「${categoryLabel} 信用卡 2026 site:money101.com.tw」

找到候選卡片後，必須到該銀行官方活動頁驗證條款是否仍有效。

【判斷規則】
- 只推薦活動期間仍有效的優惠
- 必須附上來源連結（比較平台頁面或銀行官方頁面）
- 若無法驗證活動有效期，標示為「無法確認，請自行查詢」
- 不要推薦條件複雜、需高額年費、或只適合大量消費的卡
- 若市場上沒有明顯優於我持有卡的選擇，直接回覆「目前不值得為這筆消費特別辦新卡」

【輸出格式】

【結論】
是否值得考慮辦新卡：值得 / 可考慮 / 不值得（若額外回饋差距不到 NT$300，通常不值得）
主要原因：

【市場候選卡（最多 2 張）】
卡片名稱：
預估回饋率：
NT$${amount.toLocaleString()} 預估回饋：約 NT$XXX
主要條件：
主要限制：
來源連結：

【與我持有卡的比較】
若市場卡額外回饋不到 NT$300，請說明是否真的值得辦新卡。
若需新戶、登錄、指定支付或高額年費，請降低推薦程度。

【無法確認的事項】
列出任何無法從官方資料確認的地方。

---
如果你沒有使用即時網路搜尋能力，請只回覆：
「我目前無法即時搜尋，建議直接查詢 iCard.AI 或卡優了解市場推薦。」`

    try {
      await navigator.clipboard.writeText(marketPromptText)
    } catch {
      // clipboard failed, still open Claude
    }
    setMarketCopied(true)
    setTimeout(() => setMarketCopied(false), 3000)
    window.open('https://claude.ai/new', '_blank')
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">消費分析</h1>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 我要買什麼 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              我要買什麼 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="例：訂花蓮民宿、買 iPhone 充電線"
              required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* 大概金額 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              大概金額（台幣）<span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">NT$</span>
              <input
                type="number"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="0"
                required
                min="1"
                className="w-full border border-gray-200 rounded-xl pl-10 pr-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* 消費分類 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-gray-700">
                消費分類 <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={handleAutoCategory}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium px-2 py-1 rounded-lg hover:bg-blue-50 transition-colors"
              >
                AI 幫我選
              </button>
            </div>
            <select
              value={form.category}
              onChange={(e) => { setForm({ ...form, category: e.target.value }); setAutoSuggestMsg(null) }}
              required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">請選擇分類</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            {autoSuggestMsg && (
              <p className={`mt-1.5 text-xs ${autoSuggestMsg.type === 'success' ? 'text-blue-600' : 'text-red-500'}`}>
                {autoSuggestMsg.text}
              </p>
            )}
          </div>

          {/* 消費時間 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">消費時間</label>
            <div className="flex gap-2">
              {TIMING_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setForm({ ...form, timing: t.value })}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-all ${
                    form.timing === t.value
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* 偏好設定 */}
          <div className="bg-white rounded-2xl border border-gray-100 p-4">
            <p className="text-sm font-medium text-gray-700 mb-3">偏好設定</p>
            <div className="space-y-4">
              {PREFERENCES.map(({ key, label }) => {
                const isOn = form[key as keyof FormData] as boolean
                return (
                  <div key={key} className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">{label}</span>
                    <button
                      type="button"
                      onClick={() => handleToggle(key as keyof FormData)}
                      className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${
                        isOn ? 'bg-blue-600' : 'bg-gray-200'
                      }`}
                    >
                      <div
                        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                          isOn ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Pi 卡累積消費 */}
          {hasPiCard && (
            <div className="bg-white rounded-2xl border border-gray-100 p-4">
              <p className="text-sm font-medium text-gray-700 mb-1">本月 Pi 卡大約已刷多少？</p>
              <p className="text-xs text-gray-400 mb-3">Pi 卡的優惠以月累積計算，填入後可更準確判斷是否達標</p>
              <div className="flex flex-wrap gap-2 mb-2">
                {PI_CHIPS.map((chip) => (
                  <button
                    key={String(chip.value)}
                    type="button"
                    onClick={() => {
                      setForm({ ...form, piAccumulated: chip.value })
                      setPiShowCustom(false)
                    }}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-all ${
                      !piShowCustom && form.piAccumulated === chip.value
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    {chip.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPiShowCustom(true)}
                  className={`px-3 py-1.5 rounded-full text-sm border transition-all ${
                    piShowCustom
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                  }`}
                >
                  自訂
                </button>
              </div>
              {piShowCustom && (
                <input
                  type="number"
                  value={piCustom}
                  onChange={(e) => {
                    setPiCustom(e.target.value)
                    setForm({ ...form, piAccumulated: e.target.value ? Number(e.target.value) : 0 })
                  }}
                  placeholder="輸入本月已刷金額"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={analyzing}
            className="w-full bg-blue-600 text-white font-semibold py-3.5 rounded-xl hover:bg-blue-700 active:scale-95 transition-all text-base disabled:opacity-60"
          >
            {analyzing ? '分析中...' : '開始分析'}
          </button>
        </form>

        {/* 推薦結果 */}
        {analyzed && (
          <>
            <div className="mt-8">
              <h2 className="text-xl font-bold text-gray-900 mb-4">推薦方案</h2>

              {uncertainMode && (
                <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                  <p className="text-sm text-blue-800 leading-relaxed">
                    你選擇了「不確定」，以下顯示所有符合金額門檻的規則，請自行確認哪些適用你的消費情境。
                  </p>
                </div>
              )}

              {['foreign_currency', 'travel', 'flight', 'hotel'].includes(form.category) && (
                <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex gap-2">
                  <span className="shrink-0">⚠️</span>
                  <p className="text-xs text-amber-800">
                    注意：國外消費請確認各卡的國外交易手續費（通常 1.5%），實際回饋可能低於表定值。
                  </p>
                </div>
              )}

              <div className="space-y-4">
                {recommendations.map((merged, i) => (
                  <MergedRecCard key={i} merged={merged} />
                ))}
              </div>
            </div>

            {/* 市場參考新卡 */}
            {marketRules.length > 0 && (
              <div className="mt-8">
                <h2 className="text-xl font-bold text-gray-900 mb-1">市場參考新卡</h2>
                <p className="text-xs text-gray-400 mb-4">以下為手動建檔的市場參考規則，資料可靠度較低，請自行確認官方條款</p>
                <div className="space-y-3">
                  {marketRules.map(r => (
                    <div key={r.rule_id} className="bg-white rounded-2xl border border-purple-100 p-4">
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">市場參考</span>
                        <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">資料需自行確認</span>
                      </div>
                      <p className="text-xs text-gray-500">{r.bank_name}</p>
                      <p className="text-base font-semibold text-gray-900 mt-0.5">{r.card_name}</p>
                      <p className="text-sm text-gray-500 mt-0.5">{r.rule_name}</p>
                      <div className="mt-2 bg-blue-50 rounded-xl px-3 py-2">
                        <p className="text-lg font-bold text-blue-700">
                          {r.reward_type === 'points'
                            ? `${r.theoreticalRewardTwd.toLocaleString()} ${(r.extra_conditions_json?.reward_currency as string) ?? '點'}`
                            : `NT$ ${r.netRewardTwd.toLocaleString()} 回饋`}
                        </p>
                        <p className="text-xs text-blue-500">有效回饋率 {(r.effectiveRewardRate * 100).toFixed(1)}%</p>
                      </div>
                      {r.source_url && (
                        <a href={r.source_url} target="_blank" rel="noopener noreferrer"
                          className="mt-2 inline-block text-xs text-blue-600 underline">
                          查看官方來源
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 市場搜尋 Prompt */}
            <div className="mt-8 bg-purple-50 border border-purple-100 rounded-2xl p-4">
              <p className="text-sm font-semibold text-gray-900 mb-1">想知道市場上是否有更好的選擇？</p>
              <p className="text-xs text-gray-500 mb-3">產生 AI 搜尋 prompt，讓 Claude 即時查詢台灣信用卡市場推薦</p>
              <button
                onClick={handleMarketSearch}
                className="w-full bg-purple-600 text-white text-sm font-medium py-3 rounded-xl hover:bg-purple-700 active:scale-95 transition-all"
              >
                {marketCopied ? '✓ 已複製，請貼到 Claude！' : '搜尋市場推薦'}
              </button>
            </div>

            {/* Prompt 區塊 */}
            <div className="mt-8">
              <h2 className="text-xl font-bold text-gray-900 mb-1">AI 提問 Prompt</h2>
              <p className="text-sm text-gray-500 mb-3">
                複製後貼入 Claude 或 ChatGPT，取得更詳細的建議
              </p>

              <textarea
                readOnly
                value={prompt}
                rows={12}
                className="w-full border border-gray-200 rounded-xl px-3 py-3 text-xs text-gray-700 bg-gray-50 resize-none focus:outline-none"
              />

              <div className="flex gap-3 mt-3">
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(prompt)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  }}
                  className="flex-1 bg-blue-600 text-white text-sm font-medium py-3 rounded-xl hover:bg-blue-700 active:scale-95 transition-all"
                >
                  {copied ? '✓ 已複製！' : '複製 Prompt'}
                </button>
                <a
                  href="https://claude.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center bg-white border border-gray-200 text-gray-700 text-sm font-medium py-3 rounded-xl hover:bg-gray-50 active:scale-95 transition-all"
                >
                  開啟 Claude
                </a>
                <a
                  href="https://chatgpt.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center bg-white border border-gray-200 text-gray-700 text-sm font-medium py-3 rounded-xl hover:bg-gray-50 active:scale-95 transition-all"
                >
                  開啟 ChatGPT
                </a>
              </div>

              <p className="text-xs text-gray-400 text-center mt-2">
                開啟後請將 prompt 貼入對話框並送出
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
