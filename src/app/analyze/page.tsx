'use client'

import { useState } from 'react'
import {
  matchRules,
  matchNewCardRules,
  scoreRules,
  buildConfirmItems,
  generateRecommendations,
  Recommendation,
  ScoredRule,
  MergedRec,
} from '@/lib/matchRules'
import { generatePrompt } from '@/lib/generatePrompt'

const CATEGORIES = [
  { value: 'travel', label: '旅遊平台 / 訂房' },
  { value: 'flight', label: '機票' },
  { value: 'hotel', label: '飯店' },
  { value: 'online_shopping', label: '網購' },
  { value: 'restaurant', label: '餐廳' },
  { value: 'food_delivery', label: '外送' },
  { value: 'convenience_store', label: '超商' },
  { value: 'supermarket', label: '超市' },
  { value: 'department_store', label: '百貨' },
  { value: 'mobile_payment', label: '行動支付' },
  { value: 'foreign_currency', label: '海外 / 外幣' },
  { value: 'general', label: '一般消費' },
  { value: 'new_customer_bonus', label: '新戶活動' },
  { value: 'easycard_auto_reload', label: '悠遊卡自動加值' },
  { value: 'subscription', label: '訂閱服務' },
  { value: 'ai_service', label: 'AI 服務' },
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

const COMPLEXITY_STYLES: Record<string, string> = {
  low:    'bg-green-50 text-green-600',
  medium: 'bg-amber-50 text-amber-600',
  high:   'bg-red-50 text-red-600',
}

const COMPLEXITY_LABELS: Record<string, string> = {
  low: '條件簡單', medium: '條件中等', high: '條件複雜',
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
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {merged.types.map((type, i) => (
          <span key={type} className={`text-xs font-medium px-2.5 py-1 rounded-full ${BADGE_STYLES[type]}`}>
            {merged.labels[i]}
          </span>
        ))}
        <span className={`text-xs px-2.5 py-1 rounded-full ${COMPLEXITY_STYLES[r.conditionComplexity]}`}>
          {COMPLEXITY_LABELS[r.conditionComplexity]}
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
        {getRewardCurrencyInfo(r).isNonCash && (
          <p className="text-xs text-amber-600 mt-1">⚠ 非現金，請確認兌換條件</p>
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

export default function AnalyzePage() {
  const [form, setForm] = useState<FormData>({
    description: '',
    amount: '',
    category: '',
    timing: 'today',
    canChangePlatform: true,
    canChangePaymentMethod: true,
    willingToApplyNewCard: false,
    preferSimpleConditions: false,
  })
  const [recommendations, setRecommendations] = useState<MergedRec[]>([])
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState(false)

  function handleToggle(key: keyof FormData) {
    setForm((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setAnalyzing(true)
    setAnalyzed(false)

    const amount = Number(form.amount)

    const [rules, newCardRules] = await Promise.all([
      matchRules(form.category, amount),
      form.willingToApplyNewCard
        ? matchNewCardRules(form.category, amount)
        : Promise.resolve([]),
    ])

    const scored: ScoredRule[] = scoreRules(rules, amount, form.category).map((r) => ({
      ...r,
      confirmItems: buildConfirmItems(r),
    }))

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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              消費分類 <span className="text-red-500">*</span>
            </label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">請選擇分類</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
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
