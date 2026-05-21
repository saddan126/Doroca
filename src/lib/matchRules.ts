import { supabase } from './supabase'

type RawCard = {
  card_name: string
  banks: { bank_name: string } | null
} | null

export type MatchedRule = {
  rule_id: string
  card_id: string
  card_name: string
  bank_name: string
  rule_name: string
  reward_type: string
  reward_rate: number
  reward_fixed_amount: number
  reward_cap_amount: number | null
  reward_cap_cycle: string
  requires_registration: string
  requires_new_customer: string
  excludes_third_party_payment: string
  new_customer_definition_text: string | null
  new_customer_check_mode: string
  extra_conditions_json: Record<string, unknown> | null
  min_spending: number
  applicable_merchants: string | null
  source_url: string | null
  valid_from: string | null
  valid_to: string | null
  source_updated_at: string | null
}

export type ConfirmItem = {
  type: 'registration' | 'cap' | 'new_customer' | 'no_third_party' | 'extra'
  message: string
}

export type ScoredRule = {
  rule_id: string
  card_id: string
  card_name: string
  bank_name: string
  rule_name: string
  reward_type: string
  theoreticalRewardTwd: number
  effectiveRewardRate: number
  capNeedsUserConfirmation: boolean
  requiresRegistration: boolean
  requiresNewCustomer: boolean
  conditionComplexity: 'low' | 'medium' | 'high'
  // 保留原始欄位供後續 Step 4 使用
  reward_cap_amount: number | null
  reward_cap_cycle: string
  excludes_third_party_payment: string
  new_customer_definition_text: string | null
  new_customer_check_mode: string
  extra_conditions_json: Record<string, unknown> | null
  applicable_merchants: string | null
  source_url: string | null
  valid_from: string | null
  valid_to: string | null
  source_updated_at: string | null
  confirmItems: ConfirmItem[]
}

// ── Step 2：篩選符合規則 ─────────────────────────────────────

export async function matchRules(
  category: string,
  amount: number,
  date: Date = new Date()
): Promise<MatchedRule[]> {
  const today = date.toISOString().split('T')[0]

  const { data: holdings, error: holdingsError } = await supabase
    .from('user_card_holdings')
    .select('card_id')
    .eq('user_id', 'me')
    .eq('holding_status', 'holding')

  if (holdingsError || !holdings || holdings.length === 0) {
    console.error('無法讀取持卡資料', holdingsError)
    return []
  }

  const heldCardIds = holdings.map((h) => h.card_id)

  const { data: rules, error: rulesError } = await supabase
    .from('offer_rules')
    .select(`
      rule_id, card_id, rule_name, category,
      reward_type, reward_rate, reward_fixed_amount,
      reward_cap_amount, reward_cap_cycle,
      requires_registration, requires_new_customer,
      excludes_third_party_payment,
      new_customer_definition_text, new_customer_check_mode,
      extra_conditions_json, min_spending,
      applicable_merchants, source_url,
      valid_from, valid_to, source_updated_at,
      cards ( card_name, banks ( bank_name ) )
    `)
    .in('card_id', heldCardIds)

  if (rulesError || !rules) {
    console.error('無法讀取優惠規則', rulesError)
    return []
  }

  return rules
    .filter((rule) => {
      if (rule.valid_to && rule.valid_to < today) return false
      if (rule.min_spending && amount < rule.min_spending) return false
      const cats = rule.category
        ? rule.category.split(',').map((c: string) => c.trim())
        : []
      if (!cats.includes(category)) return false
      return true
    })
    .map((rule) => ({
      rule_id: rule.rule_id,
      card_id: rule.card_id,
      card_name: (rule.cards as RawCard)?.card_name ?? '',
      bank_name: (rule.cards as RawCard)?.banks?.bank_name ?? '',
      rule_name: rule.rule_name,
      reward_type: rule.reward_type,
      reward_rate: rule.reward_rate ?? 0,
      reward_fixed_amount: rule.reward_fixed_amount ?? 0,
      reward_cap_amount: rule.reward_cap_amount ?? null,
      reward_cap_cycle: rule.reward_cap_cycle ?? 'none',
      requires_registration: rule.requires_registration ?? 'no',
      requires_new_customer: rule.requires_new_customer ?? 'no',
      excludes_third_party_payment: rule.excludes_third_party_payment ?? 'unknown',
      new_customer_definition_text: rule.new_customer_definition_text ?? null,
      new_customer_check_mode: rule.new_customer_check_mode ?? 'unknown',
      extra_conditions_json: rule.extra_conditions_json ?? null,
      min_spending: rule.min_spending ?? 0,
      applicable_merchants: rule.applicable_merchants ?? null,
      source_url: rule.source_url ?? null,
      valid_from: rule.valid_from ?? null,
      valid_to: rule.valid_to ?? null,
      source_updated_at: rule.source_updated_at ?? null,
    }))
}

// ── Step 3：計算理論回饋 ─────────────────────────────────────

function calcComplexity(rule: MatchedRule): 'low' | 'medium' | 'high' {
  if (
    rule.requires_new_customer === 'yes' ||
    rule.new_customer_check_mode === 'user_confirm_required'
  ) return 'high'

  // 只有 key 以 requires_ 開頭才代表真正的必要條件
  const hasRequirementConditions = rule.extra_conditions_json
    ? Object.keys(rule.extra_conditions_json).some((k) => k.startsWith('requires_'))
    : false

  if (
    rule.requires_registration === 'yes' ||
    (rule.reward_cap_amount !== null && rule.reward_cap_cycle !== 'none') ||
    hasRequirementConditions
  ) return 'medium'

  return 'low'
}

export function scoreRules(rules: MatchedRule[], amount: number): ScoredRule[] {
  return rules.map((rule) => {
    let theoretical = 0

    if (rule.reward_type === 'cashback') {
      theoretical = amount * rule.reward_rate
    } else if (rule.reward_type === 'fixed_amount') {
      theoretical = rule.reward_fixed_amount
    } else if (rule.reward_type === 'points') {
      // 點數先以面值 1:1 換算（後續可調整）
      theoretical = amount * rule.reward_rate
    }

    const capNeedsUserConfirmation =
      rule.reward_cap_amount !== null && rule.reward_cap_cycle !== 'none'

    if (rule.reward_cap_amount !== null) {
      theoretical = Math.min(theoretical, rule.reward_cap_amount)
    }

    const effectiveRewardRate = amount > 0 ? theoretical / amount : 0

    return {
      rule_id: rule.rule_id,
      card_id: rule.card_id,
      card_name: rule.card_name,
      bank_name: rule.bank_name,
      rule_name: rule.rule_name,
      reward_type: rule.reward_type,
      theoreticalRewardTwd: Math.round(theoretical),
      effectiveRewardRate: Math.round(effectiveRewardRate * 10000) / 10000,
      capNeedsUserConfirmation,
      requiresRegistration: rule.requires_registration === 'yes',
      requiresNewCustomer: rule.requires_new_customer === 'yes',
      conditionComplexity: calcComplexity(rule),
      reward_cap_amount: rule.reward_cap_amount,
      reward_cap_cycle: rule.reward_cap_cycle,
      excludes_third_party_payment: rule.excludes_third_party_payment,
      new_customer_definition_text: rule.new_customer_definition_text,
      new_customer_check_mode: rule.new_customer_check_mode,
      extra_conditions_json: rule.extra_conditions_json,
      applicable_merchants: rule.applicable_merchants,
      source_url: rule.source_url,
      valid_from: rule.valid_from,
      valid_to: rule.valid_to,
      source_updated_at: rule.source_updated_at,
      confirmItems: buildConfirmItems(rule),
    }
  })
}

// ── Step 4：標記需確認條件 ────────────────────────────────────

export function buildConfirmItems(rule: MatchedRule | ScoredRule): ConfirmItem[] {
  const items: ConfirmItem[] = []

  if (rule.requires_registration === 'yes' || (rule as MatchedRule).requires_registration === 'yes') {
    items.push({
      type: 'registration',
      message: '消費前需完成活動登錄',
    })
  }

  if (rule.reward_cap_amount !== null) {
    items.push({
      type: 'cap',
      message: `本月回饋上限 ${rule.reward_cap_amount} 元，是否已用完需自行確認`,
    })
  }

  if (rule.requires_new_customer === 'yes' || (rule as MatchedRule).requires_new_customer === 'yes') {
    const definition = rule.new_customer_definition_text
    items.push({
      type: 'new_customer',
      message: definition
        ? `限新戶適用：${definition}`
        : '限新戶適用，請確認自身是否符合資格',
    })
  }

  if (rule.excludes_third_party_payment === 'yes') {
    items.push({
      type: 'no_third_party',
      message: '請使用信用卡直刷，不適用第三方支付（如 Line Pay、街口）',
    })
  }

  if (rule.extra_conditions_json && Object.keys(rule.extra_conditions_json).length > 0) {
    const entries = Object.entries(rule.extra_conditions_json)
    for (const [key, value] of entries) {
      if (typeof value === 'string') {
        const label = key.replace(/_/g, ' ')
        items.push({ type: 'extra', message: `${label}：${value}` })
      }
    }
  }

  return items
}

// ── Step 5：產生四種推薦方案 ──────────────────────────────────

export type Recommendation = {
  type: 'best_practical' | 'highest_theoretical' | 'most_stable' | 'new_card'
  label: string
  rule: ScoredRule | null
}

export type MergedRec = {
  types: string[]
  labels: string[]
  rule: ScoredRule | null
}

export function generateRecommendations(
  scored: ScoredRule[],
  willingToApplyNewCard: boolean,
  newCardRules: ScoredRule[] = []
): Recommendation[] {
  const recs: Recommendation[] = []

  // 1. 最佳實用方案：回饋最高，且複雜度不是 high
  const practical =
    [...scored]
      .filter((r) => r.conditionComplexity !== 'high')
      .sort((a, b) => b.theoreticalRewardTwd - a.theoreticalRewardTwd)[0] ?? null
  recs.push({ type: 'best_practical', label: '最佳實用方案', rule: practical })

  // 2. 理論最高方案：回饋絕對最高，不管複雜度
  const highest =
    [...scored].sort((a, b) => b.theoreticalRewardTwd - a.theoreticalRewardTwd)[0] ?? null
  recs.push({ type: 'highest_theoretical', label: '理論最高方案', rule: highest })

  // 3. 最穩定方案：無需登錄、無回饋上限、且條件簡單（low），回饋最高
  const stable =
    [...scored]
      .filter((r) => !r.requiresRegistration && r.reward_cap_amount === null && r.conditionComplexity === 'low')
      .sort((a, b) => b.theoreticalRewardTwd - a.theoreticalRewardTwd)[0] ?? null
  recs.push({ type: 'most_stable', label: '最穩定方案', rule: stable })

  // 4. 新卡方案：僅在願意辦新卡時顯示
  if (willingToApplyNewCard) {
    const newCard =
      [...newCardRules].sort((a, b) => b.theoreticalRewardTwd - a.theoreticalRewardTwd)[0] ?? null
    recs.push({ type: 'new_card', label: '新卡方案', rule: newCard })
  }

  return recs
}

// 取得非持有卡的符合規則（新卡方案用）
export async function matchNewCardRules(
  category: string,
  amount: number,
  date: Date = new Date()
): Promise<ScoredRule[]> {
  const today = date.toISOString().split('T')[0]

  const { data: holdings } = await supabase
    .from('user_card_holdings')
    .select('card_id')
    .eq('user_id', 'me')
    .eq('holding_status', 'holding')

  const heldCardIds = (holdings || []).map((h) => h.card_id)

  const { data: allCards } = await supabase
    .from('cards')
    .select('card_id')
    .eq('status', 'active')

  const newCardIds = (allCards || [])
    .map((c) => c.card_id)
    .filter((id) => !heldCardIds.includes(id))

  if (newCardIds.length === 0) return []

  const { data: rules } = await supabase
    .from('offer_rules')
    .select(`
      rule_id, card_id, rule_name, category,
      reward_type, reward_rate, reward_fixed_amount,
      reward_cap_amount, reward_cap_cycle,
      requires_registration, requires_new_customer,
      excludes_third_party_payment,
      new_customer_definition_text, new_customer_check_mode,
      extra_conditions_json, min_spending,
      applicable_merchants, source_url,
      valid_from, valid_to, source_updated_at,
      cards ( card_name, banks ( bank_name ) )
    `)
    .in('card_id', newCardIds)

  if (!rules) return []

  const matched: MatchedRule[] = rules
    .filter((rule) => {
      if (rule.valid_to && rule.valid_to < today) return false
      if (rule.min_spending && amount < rule.min_spending) return false
      const cats = rule.category
        ? rule.category.split(',').map((c: string) => c.trim())
        : []
      if (!cats.includes(category)) return false
      return true
    })
    .map((rule) => ({
      rule_id: rule.rule_id,
      card_id: rule.card_id,
      card_name: (rule.cards as RawCard)?.card_name ?? '',
      bank_name: (rule.cards as RawCard)?.banks?.bank_name ?? '',
      rule_name: rule.rule_name,
      reward_type: rule.reward_type,
      reward_rate: rule.reward_rate ?? 0,
      reward_fixed_amount: rule.reward_fixed_amount ?? 0,
      reward_cap_amount: rule.reward_cap_amount ?? null,
      reward_cap_cycle: rule.reward_cap_cycle ?? 'none',
      requires_registration: rule.requires_registration ?? 'no',
      requires_new_customer: rule.requires_new_customer ?? 'no',
      excludes_third_party_payment: rule.excludes_third_party_payment ?? 'unknown',
      new_customer_definition_text: rule.new_customer_definition_text ?? null,
      new_customer_check_mode: rule.new_customer_check_mode ?? 'unknown',
      extra_conditions_json: rule.extra_conditions_json ?? null,
      min_spending: rule.min_spending ?? 0,
      applicable_merchants: rule.applicable_merchants ?? null,
      source_url: rule.source_url ?? null,
      valid_from: rule.valid_from ?? null,
      valid_to: rule.valid_to ?? null,
      source_updated_at: rule.source_updated_at ?? null,
    }))

  return scoreRules(matched, amount).map((r) => ({
    ...r,
    confirmItems: buildConfirmItems(r),
  }))
}
