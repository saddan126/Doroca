import { MergedRec } from './matchRules'

const CATEGORY_LABELS: Record<string, string> = {
  travel: '旅遊平台 / 訂房',
  flight: '機票',
  hotel: '飯店',
  online_shopping: '網購',
  restaurant: '餐廳',
  food_delivery: '外送',
  convenience_store: '超商',
  supermarket: '超市',
  department_store: '百貨',
  mobile_payment: '行動支付',
  foreign_currency: '海外 / 外幣',
  general: '一般消費',
  new_customer_bonus: '新戶活動',
  easycard_auto_reload: '悠遊卡自動加值',
  subscription: '訂閱服務',
  ai_service: 'AI 服務',
}

const TIMING_LABELS: Record<string, string> = {
  today: '今天',
  this_week: '本週內',
  this_month: '本月內',
}

type Preferences = {
  canChangePlatform: boolean
  canChangePaymentMethod: boolean
  willingToApplyNewCard: boolean
  preferSimpleConditions: boolean
}

export function generatePrompt(
  description: string,
  amount: number,
  category: string,
  timing: string,
  preferences: Preferences,
  recommendations: MergedRec[]
): string {
  const categoryLabel = CATEGORY_LABELS[category] ?? category
  const timingLabel = TIMING_LABELS[timing] ?? timing
  const amountFormatted = amount.toLocaleString()

  // 只取有規則的方案
  const validRecs = recommendations.filter((r) => r.rule !== null)

  let rankSection = ''
  validRecs.forEach((rec, i) => {
    const r = rec.rule!
    const rank = i + 1
    const labelsText = rec.labels.join(' / ')
    const rateText = (r.effectiveRewardRate * 100).toFixed(1)

    rankSection += `▍第 ${rank} 名｜${labelsText}\n`
    rankSection += `${r.bank_name} ${r.card_name}\n`
    rankSection += `優惠：${r.rule_name}\n`
    rankSection += `理論回饋：最高 ${r.theoreticalRewardTwd.toLocaleString()} 元（${rateText}%）`

    if (r.capNeedsUserConfirmation) {
      rankSection += `（回饋上限需自行確認）`
    }
    rankSection += '\n'

    if (r.valid_from || r.valid_to) {
      const from = r.valid_from ?? '不限'
      const to = r.valid_to ?? '不限'
      rankSection += `活動期間：${from} ~ ${to}\n`
    }

    if (r.confirmItems.length > 0) {
      rankSection += `⚠ 需確認：\n`
      r.confirmItems.forEach((item, j) => {
        rankSection += `  ${j + 1}. ${item.message}\n`
      })
    }

    rankSection += '\n'
  })

  if (validRecs.length === 0) {
    rankSection = '目前持有的卡片中，沒有找到符合條件的優惠規則。\n\n'
  }

  // 取最舊的 source_updated_at 作為資料截止日（最保守）
  const sourceDate = validRecs
    .map((r) => r.rule!.source_updated_at)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null

  const prefLines = [
    `・可以換平台：${preferences.canChangePlatform ? '是' : '否'}`,
    `・可以換付款方式：${preferences.canChangePaymentMethod ? '是' : '否'}`,
    `・願意辦新卡：${preferences.willingToApplyNewCard ? '是' : '否'}`,
    `・希望條件簡單：${preferences.preferSimpleConditions ? '是' : '否'}`,
  ].join('\n')

  const sourceNote = sourceDate
    ? `\n※ 以上優惠資料截至 ${sourceDate}，請以銀行官方公告為準`
    : ''

  return `【App 初步計算結果】
針對「${description}」${amountFormatted} 元（分類：${categoryLabel}，消費時間：${timingLabel}），以下是根據持卡資料的初步推薦：

${rankSection}【使用者偏好】
${prefLines}

【請 AI 協助】
1. 用容易理解的方式說明上述方案的優缺點
2. 補充我可能忽略的風險（例如：回饋限制、刷卡方式、活動截止日等）
3. 消費前需要做哪些事，請列成清單
4. 如果第 1 名條件太麻煩，第 2 名值得選嗎？${preferences.willingToApplyNewCard ? '\n5. 使用者願意辦新卡，請針對新申辦者的專屬條件（例如試用期優惠、首刷活動、核卡後 N 天內條件）補充說明，並指出哪張新卡最值得辦。' : ''}${sourceNote}`
}
