'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type Alert = {
  level: 'red' | 'orange' | 'yellow' | 'blue' | 'gray'
  emoji: string
  label: string
  isReviewAlert?: boolean
}

type RuleHealth = {
  rule_id: string
  card_id: string
  rule_name: string
  card_name: string
  bank_name: string
  valid_to: string | null
  source_updated_at: string | null
  review_status: string | null
  confidence: string | null
  source_url: string | null
  review_note: string | null
  alerts: Alert[]
}

type CardOption = { card_id: string; card_name: string; bank_name: string }

const ALERT_BORDER: Record<string, string> = {
  red:    'border-red-200 bg-red-50',
  orange: 'border-orange-200 bg-orange-50',
  yellow: 'border-yellow-200 bg-yellow-50',
  blue:   'border-blue-200 bg-blue-50',
  gray:   'border-gray-200 bg-gray-50',
}

const ALERT_BADGE: Record<string, string> = {
  red:    'bg-red-100 text-red-700',
  orange: 'bg-orange-100 text-orange-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  blue:   'bg-blue-100 text-blue-700',
  gray:   'bg-gray-100 text-gray-600',
}

function calcAlerts(rule: Omit<RuleHealth, 'alerts'>, today: string): Alert[] {
  const alerts: Alert[] = []
  const todayDate = new Date(today)
  const in14 = new Date(today); in14.setDate(in14.getDate() + 14)
  const in30 = new Date(today); in30.setDate(in30.getDate() + 30)
  const ago60 = new Date(today); ago60.setDate(ago60.getDate() - 60)

  if (rule.valid_to) {
    const exp = new Date(rule.valid_to)
    if (exp < todayDate) {
      alerts.push({ level: 'red', emoji: '🔴', label: `已過期（${rule.valid_to}）` })
    } else if (exp <= in14) {
      alerts.push({ level: 'orange', emoji: '🟠', label: `14 天內到期（${rule.valid_to}）` })
    } else if (exp <= in30) {
      alerts.push({ level: 'yellow', emoji: '🟡', label: `30 天內到期（${rule.valid_to}）` })
    }
  }

  if (rule.source_updated_at) {
    const updated = new Date(rule.source_updated_at)
    if (updated < ago60) {
      alerts.push({ level: 'blue', emoji: '🔵', label: `資料超過 60 天未確認（${rule.source_updated_at}）` })
    }
  } else {
    alerts.push({ level: 'gray', emoji: '⚪', label: '缺少資料確認日期' })
  }

  if (rule.review_status === 'needs_review') {
    alerts.push({ level: 'gray', emoji: '⚪', label: '待審查', isReviewAlert: true })
  }

  if (rule.confidence === 'low') {
    alerts.push({ level: 'gray', emoji: '⚪', label: '低信心度，資料需確認' })
  }

  if (!rule.source_url) {
    alerts.push({ level: 'gray', emoji: '⚪', label: '缺少官方來源連結' })
  }

  return alerts
}

const LEVEL_ORDER: Record<string, number> = { red: 0, orange: 1, yellow: 2, blue: 3, gray: 4 }

function topLevel(alerts: Alert[]): string {
  if (alerts.length === 0) return 'gray'
  return alerts.reduce((best, a) =>
    LEVEL_ORDER[a.level] < LEVEL_ORDER[best] ? a.level : best
  , alerts[0].level)
}

const STATUS_OPTIONS = [
  { value: 'all',            label: '全部' },
  { value: 'needs_review',   label: '待審查' },
  { value: 'human_reviewed', label: '已確認' },
] as const

const ALERT_FILTER_OPTIONS = [
  { key: 'expired',        label: '已過期' },
  { key: '14days',         label: '14 天內到期' },
  { key: 'duplicate',      label: '疑似重複' },
  { key: 'low_confidence', label: '低信心' },
]

export default function RulesPage() {
  const [rules, setRules] = useState<RuleHealth[]>([])
  const [loading, setLoading] = useState(true)
  const [cardOptions, setCardOptions] = useState<CardOption[]>([])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'needs_review' | 'human_reviewed'>('all')
  const [alertFilters, setAlertFilters] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.from('cards').select('card_id, card_name, banks(bank_name)').eq('status', 'active').order('card_name')
      .then(({ data }) => {
        if (!data) return
        setCardOptions(
          (data as unknown as { card_id: string; card_name: string; banks: { bank_name: string } | null }[])
            .map(c => ({ card_id: c.card_id, card_name: c.card_name, bank_name: c.banks?.bank_name ?? '' }))
        )
      })
  }, [])

  useEffect(() => {
    async function load() {
      const today = new Date().toISOString().split('T')[0]

      const { data, error } = await supabase
        .from('offer_rules')
        .select(`
          rule_id, card_id, rule_name, valid_to, source_updated_at,
          review_status, confidence, source_url, review_note,
          cards ( card_name, banks ( bank_name ) )
        `)
        .order('rule_id')

      if (error || !data) {
        console.error('無法讀取規則', error)
        setLoading(false)
        return
      }

      const processed: RuleHealth[] = data.map((r) => {
        const cards = r.cards as unknown as { card_name: string; banks: { bank_name: string } | null } | null
        const base = {
          rule_id: r.rule_id,
          card_id: r.card_id,
          rule_name: r.rule_name,
          card_name: cards?.card_name ?? '',
          bank_name: cards?.banks?.bank_name ?? '',
          valid_to: r.valid_to ?? null,
          source_updated_at: r.source_updated_at ?? null,
          review_status: r.review_status ?? null,
          confidence: r.confidence ?? null,
          source_url: r.source_url ?? null,
          review_note: (r as unknown as { review_note?: string | null }).review_note ?? null,
        }
        return { ...base, alerts: calcAlerts(base, today) }
      })

      const flagged = processed.filter((r) => r.alerts.length > 0)
      flagged.sort((a, b) => LEVEL_ORDER[topLevel(a.alerts)] - LEVEL_ORDER[topLevel(b.alerts)])

      setRules(flagged)
      setLoading(false)
    }
    load()
  }, [])

  function toggleAlertFilter(key: string) {
    setAlertFilters(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const displayed = rules.filter(rule => {
    if (selectedCardId && rule.card_id !== selectedCardId) return false
    if (statusFilter !== 'all' && rule.review_status !== statusFilter) return false
    if (alertFilters.has('expired')        && !rule.alerts.some(a => a.level === 'red'))    return false
    if (alertFilters.has('14days')         && !rule.alerts.some(a => a.level === 'orange')) return false
    if (alertFilters.has('duplicate')      && !(rule.review_note?.includes('重複') ?? false)) return false
    if (alertFilters.has('low_confidence') && rule.confidence !== 'low')                    return false
    return true
  })

  const hasActiveFilters = selectedCardId || statusFilter !== 'all' || alertFilters.size > 0

  async function handleDeleteRule(ruleId: string, ruleName: string) {
    if (!window.confirm(`確定刪除「${ruleName}」嗎？此操作無法復原。`)) return
    const { error } = await supabase.from('offer_rules').delete().eq('rule_id', ruleId)
    if (error) { alert(`刪除失敗：${error.message}`); return }
    setRules(prev => prev.filter(r => r.rule_id !== ruleId))
  }

  async function handleMarkReviewed(ruleId: string) {
    const { error } = await supabase.from('offer_rules')
      .update({ review_status: 'human_reviewed', review_note: null })
      .eq('rule_id', ruleId)
    if (error) { alert(`操作失敗：${error.message}`); return }
    const today = new Date().toISOString().split('T')[0]
    setRules(prev => {
      const next = prev.map(r => {
        if (r.rule_id !== ruleId) return r
        const updated = { ...r, review_status: 'human_reviewed', review_note: null }
        return { ...updated, alerts: calcAlerts(updated, today) }
      })
      return next.filter(r => r.alerts.length > 0)
    })
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold text-gray-900">規則健康度</h1>
          <div className="flex gap-2">
            <Link
              href="/rules/healthcheck"
              className="text-sm font-medium text-amber-600 bg-amber-50 px-3 py-1.5 rounded-xl hover:bg-amber-100 transition-colors"
            >
              AI 健檢
            </Link>
            <Link
              href="/rules/import"
              className="text-sm font-medium text-blue-600 bg-blue-50 px-3 py-1.5 rounded-xl hover:bg-blue-100 transition-colors"
            >
              + 新增規則
            </Link>
          </div>
        </div>
        <p className="text-sm text-gray-500 mb-6">需要注意的優惠規則清單</p>

        {/* 篩選區 */}
        {!loading && rules.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 p-4 mb-5 space-y-4">

            {/* 卡片篩選 */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">卡片</p>
              <select
                value={selectedCardId}
                onChange={e => setSelectedCardId(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">全部卡片</option>
                {cardOptions.map(c => (
                  <option key={c.card_id} value={c.card_id}>{c.bank_name} {c.card_name}</option>
                ))}
              </select>
            </div>

            {/* 狀態篩選 */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">狀態</p>
              <div className="flex gap-2">
                {STATUS_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setStatusFilter(opt.value)}
                    className={`flex-1 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                      statusFilter === opt.value
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 警示篩選 */}
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">警示（多選，同時符合才顯示）</p>
              <div className="flex flex-wrap gap-2">
                {ALERT_FILTER_OPTIONS.map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => toggleAlertFilter(opt.key)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      alertFilters.has(opt.key)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 清除篩選 */}
            {hasActiveFilters && (
              <button
                onClick={() => { setSelectedCardId(''); setStatusFilter('all'); setAlertFilters(new Set()) }}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                清除所有篩選
              </button>
            )}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 text-center py-12">載入中...</p>
        ) : rules.length === 0 ? (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6 text-center">
            <p className="text-2xl mb-2">✅</p>
            <p className="text-sm font-medium text-green-700">所有規則狀態正常</p>
          </div>
        ) : (
          <div className="space-y-3">
            {displayed.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">沒有符合條件的規則</p>
            ) : (
              displayed.map((rule) => {
                const top = topLevel(rule.alerts)
                return (
                  <div key={rule.rule_id} className={`rounded-2xl border p-4 ${ALERT_BORDER[top]}`}>
                    <p className="text-xs text-gray-500">{rule.bank_name}</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">{rule.card_name}</p>
                    <p className="text-sm text-gray-700 mt-0.5">{rule.rule_name}</p>

                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {rule.alerts
                        .filter(a => !a.isReviewAlert)
                        .map((alert, i) => (
                          <span
                            key={i}
                            className={`text-xs px-2.5 py-1 rounded-full font-medium ${ALERT_BADGE[alert.level]}`}
                          >
                            {alert.emoji} {alert.label}
                          </span>
                        ))}
                    </div>

                    {rule.review_status === 'needs_review' && (
                      <p className="text-xs text-amber-700 font-medium mt-2">
                        ⚠️ 待審查{rule.review_note ? `：${rule.review_note}` : ''}
                      </p>
                    )}

                    {rule.source_url && (
                      <a
                        href={rule.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-block text-xs text-blue-600 underline"
                      >
                        查看官方來源
                      </a>
                    )}
                    <div className="flex items-center gap-2 mt-3">
                      {rule.review_status === 'needs_review' && (
                        <button
                          onClick={() => handleMarkReviewed(rule.rule_id)}
                          className="flex-1 bg-green-600 text-white text-xs font-medium py-2 rounded-xl hover:bg-green-700 active:scale-95 transition-all"
                        >
                          標記為已確認
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteRule(rule.rule_id, rule.rule_name)}
                        className="px-3 py-2 bg-white border border-red-200 text-red-400 text-xs rounded-xl hover:bg-red-50 active:scale-95 transition-all"
                        title="刪除規則"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </main>
  )
}
