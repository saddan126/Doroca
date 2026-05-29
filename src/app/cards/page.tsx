'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/components/AuthProvider'

type CardHolding = {
  id: string
  card_id: string
  holding_status: string
  approved_date: string | null
  note: string | null
  cards: {
    card_name: string
    banks: { bank_name: string } | null
  } | null
}

type Bank = { bank_id: string; bank_name: string }
type Card = { card_id: string; card_name: string; bank_id: string }

type BankStatus = {
  id?: string
  bank_id: string
  bank_name: string
  relationship_status: string
  note: string
}

export default function CardsPage() {
  const { user } = useAuth()
  const userId = user?.id ?? 'me'

  // ── Card list ──
  const [holdings, setHoldings] = useState<CardHolding[]>([])
  const [loading, setLoading] = useState(true)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  // ── Add modal ──
  const [showAddModal, setShowAddModal] = useState(false)
  const [banks, setBanks] = useState<Bank[]>([])
  const [allCards, setAllCards] = useState<Card[]>([])
  const [filteredCards, setFilteredCards] = useState<Card[]>([])
  const [selectedBank, setSelectedBank] = useState('')
  const [selectedCard, setSelectedCard] = useState('')
  const [approvedDate, setApprovedDate] = useState('')
  const [addNote, setAddNote] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)

  // ── Edit modal ──
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [editApprovedDate, setEditApprovedDate] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  // ── Bank status ──
  const [bankStatuses, setBankStatuses] = useState<BankStatus[]>([])
  const [bankStatusLoading, setBankStatusLoading] = useState(true)
  const [savingBankId, setSavingBankId] = useState<string | null>(null)

  // ── Fetch functions ──────────────────────────────────────────

  async function fetchHoldings() {
    const { data, error } = await supabase
      .from('user_card_holdings')
      .select(`
        id,
        card_id,
        holding_status,
        approved_date,
        note,
        cards (
          card_name,
          banks ( bank_name )
        )
      `)
      .eq('user_id', userId)

    if (error) console.error(error)
    else setHoldings((data || []) as unknown as CardHolding[])
    setLoading(false)
  }

  async function fetchBankStatuses() {
    const [{ data: banksData }, { data: statusData }] = await Promise.all([
      supabase.from('banks').select('bank_id, bank_name').order('bank_name'),
      supabase.from('user_bank_status')
        .select('id, bank_id, relationship_status, note')
        .eq('user_id', userId),
    ])

    setBanks(banksData || [])

    const merged: BankStatus[] = (banksData || []).map((bank) => {
      const existing = statusData?.find((s) => s.bank_id === bank.bank_id)
      return {
        id: existing?.id,
        bank_id: bank.bank_id,
        bank_name: bank.bank_name,
        relationship_status: existing?.relationship_status || 'unknown',
        note: existing?.note || '',
      }
    })
    setBankStatuses(merged)
    setBankStatusLoading(false)
  }

  useEffect(() => {
    fetchHoldings()
    fetchBankStatuses()
  }, [])

  // ── Add card ─────────────────────────────────────────────────

  async function openAddModal() {
    if (allCards.length === 0) {
      const { data } = await supabase
        .from('cards')
        .select('card_id, card_name, bank_id')
        .order('card_name')
      setAllCards(data || [])
    }
    setShowAddModal(true)
  }

  function handleBankChange(bankId: string) {
    setSelectedBank(bankId)
    setSelectedCard('')
    setFilteredCards(allCards.filter((c) => c.bank_id === bankId))
  }

  function closeAddModal() {
    setShowAddModal(false)
    setSelectedBank('')
    setSelectedCard('')
    setApprovedDate('')
    setAddNote('')
  }

  async function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedCard) return
    setAddSubmitting(true)

    const { error } = await supabase.from('user_card_holdings').insert({
      user_id: userId,
      card_id: selectedCard,
      holding_status: 'holding',
      approved_date: approvedDate || null,
      note: addNote || null,
    })

    if (error) {
      alert('新增失敗：' + error.message)
    } else {
      closeAddModal()
      setLoading(true)
      await fetchHoldings()
    }
    setAddSubmitting(false)
  }

  // ── Edit card ────────────────────────────────────────────────

  function openEditModal(h: CardHolding) {
    setEditingId(h.id)
    setEditApprovedDate(h.approved_date || '')
    setEditNote(h.note || '')
    setMenuOpenId(null)
    setShowEditModal(true)
  }

  function closeEditModal() {
    setShowEditModal(false)
    setEditingId('')
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault()
    setEditSubmitting(true)

    const { error } = await supabase
      .from('user_card_holdings')
      .update({
        approved_date: editApprovedDate || null,
        note: editNote || null,
      })
      .eq('id', editingId)

    if (error) {
      alert('儲存失敗：' + error.message)
    } else {
      closeEditModal()
      await fetchHoldings()
    }
    setEditSubmitting(false)
  }

  async function handleMarkCancelled(id: string) {
    setMenuOpenId(null)
    const { error } = await supabase
      .from('user_card_holdings')
      .update({ holding_status: 'cancelled' })
      .eq('id', id)

    if (error) alert('操作失敗：' + error.message)
    else await fetchHoldings()
  }

  async function handleDeleteCard(h: CardHolding) {
    const cardId = h.card_id
    const cardName = h.cards?.card_name ?? '此卡片'
    setMenuOpenId(null)

    const [{ count: ruleCount }, { data: holdingsData }] = await Promise.all([
      supabase.from('offer_rules').select('rule_id', { count: 'exact', head: true }).eq('card_id', cardId),
      supabase.from('user_card_holdings').select('id').eq('card_id', cardId),
    ])

    const n = ruleCount ?? 0
    let msg = `確定刪除「${cardName}」嗎？\n`
    if (n > 0) msg += `這張卡有 ${n} 條優惠規則，刪除後這些規則也會一起刪除。\n`
    msg += '此操作無法復原。'
    if (!window.confirm(msg)) return

    if (n > 0) {
      const { error } = await supabase.from('offer_rules').delete().eq('card_id', cardId)
      if (error) { alert(`刪除規則失敗：${error.message}`); return }
    }
    const holdingsCount = holdingsData?.length ?? 0
    if (holdingsCount > 0) {
      const { error } = await supabase.from('user_card_holdings').delete().eq('card_id', cardId)
      if (error) { alert(`刪除持卡記錄失敗：${error.message}`); return }
    }
    const { error } = await supabase.from('cards').delete().eq('card_id', cardId)
    if (error) { alert(`刪除卡片失敗：${error.message}`); return }
    await fetchHoldings()
  }

  // ── Bank status ──────────────────────────────────────────────

  function updateBankStatusLocal(
    bankId: string,
    field: 'relationship_status' | 'note',
    value: string
  ) {
    setBankStatuses((prev) =>
      prev.map((b) => (b.bank_id === bankId ? { ...b, [field]: value } : b))
    )
  }

  async function saveBankStatus(bankId: string) {
    const status = bankStatuses.find((b) => b.bank_id === bankId)
    if (!status) return
    setSavingBankId(bankId)

    let error
    if (status.id) {
      ;({ error } = await supabase
        .from('user_bank_status')
        .update({
          relationship_status: status.relationship_status,
          note: status.note || null,
        })
        .eq('id', status.id))
    } else {
      const { data, error: insertError } = await supabase
        .from('user_bank_status')
        .insert({
          user_id: userId,
          bank_id: bankId,
          relationship_status: status.relationship_status,
          note: status.note || null,
        })
        .select('id')
        .single()
      error = insertError
      if (!error && data) {
        setBankStatuses((prev) =>
          prev.map((b) => (b.bank_id === bankId ? { ...b, id: data.id } : b))
        )
      }
    }

    if (error) alert('儲存失敗：' + error.message)
    setSavingBankId(null)
  }

  // ── Render ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">載入中...</p>
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-8">

        {/* ── 我的信用卡 ── */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">我的信用卡</h1>
          <button
            onClick={openAddModal}
            className="flex items-center gap-1 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-full hover:bg-blue-700 active:scale-95 transition-all"
          >
            <span className="text-lg leading-none">+</span> 新增卡片
          </button>
        </div>

        {holdings.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-400 text-lg">尚未新增任何卡片</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {holdings.map((h) => (
              <li
                key={h.id}
                className={`bg-white rounded-2xl shadow-sm border border-gray-100 p-4 transition-opacity ${
                  h.holding_status === 'cancelled' ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-500">{h.cards?.banks?.bank_name}</p>
                    <p className="text-base font-semibold text-gray-900 mt-0.5">
                      {h.cards?.card_name}
                    </p>
                    {h.approved_date && (
                      <p className="text-xs text-gray-400 mt-1">核卡 {h.approved_date}</p>
                    )}
                    {h.note && (
                      <p className="text-xs text-gray-400 mt-0.5">{h.note}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                        h.holding_status === 'holding'
                          ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {h.holding_status === 'holding' ? '持有中' : '已剪卡'}
                    </span>
                    {/* ⋯ menu */}
                    <div className="relative">
                      <button
                        onClick={() =>
                          setMenuOpenId(menuOpenId === h.id ? null : h.id)
                        }
                        className="w-8 h-8 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 text-lg"
                      >
                        ⋯
                      </button>
                      {menuOpenId === h.id && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setMenuOpenId(null)}
                          />
                          <div className="absolute right-0 top-9 z-20 bg-white border border-gray-100 rounded-xl shadow-lg py-1 w-36">
                            <button
                              onClick={() => openEditModal(h)}
                              className="w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              編輯
                            </button>
                            {h.holding_status === 'holding' && (
                              <button
                                onClick={() => handleMarkCancelled(h.id)}
                                className="w-full text-left px-4 py-2.5 text-sm text-red-500 hover:bg-gray-50"
                              >
                                標示已剪卡
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteCard(h)}
                              className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-gray-50 border-t border-gray-100"
                            >
                              刪除卡片
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* ── 銀行新舊戶狀態 ── */}
        <div className="mt-10">
          <h2 className="text-xl font-bold text-gray-900 mb-4">銀行新舊戶狀態</h2>
          {bankStatusLoading ? (
            <p className="text-gray-400 text-sm">載入中...</p>
          ) : (
            <ul className="space-y-3">
              {bankStatuses.map((b) => (
                <li key={b.bank_id} className="bg-white rounded-2xl border border-gray-100 p-4">
                  <p className="text-sm font-semibold text-gray-800 mb-1">{b.bank_name}</p>
                  <p className="text-xs text-gray-500 mb-2.5">你是否曾經持有過 {b.bank_name} 的信用卡？</p>
                  <div className="space-y-2">
                    <select
                      value={b.relationship_status === 'cancelled_before' ? 'currently_holding' : b.relationship_status}
                      onChange={(e) =>
                        updateBankStatusLocal(b.bank_id, 'relationship_status', e.target.value)
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="never_had">從未持有（可能符合新戶優惠）</option>
                      <option value="currently_holding">曾持有或目前持有（通常不符合新戶優惠）</option>
                      <option value="unknown">不確定</option>
                    </select>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={b.note}
                        onChange={(e) =>
                          updateBankStatusLocal(b.bank_id, 'note', e.target.value)
                        }
                        placeholder="備註（選填）"
                        className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        onClick={() => saveBankStatus(b.bank_id)}
                        disabled={savingBankId === b.bank_id}
                        className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50"
                      >
                        {savingBankId === b.bank_id ? '儲存中' : '儲存'}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Add Modal ── */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={closeAddModal} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl p-6 shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-gray-900">新增信用卡</h2>
              <button onClick={closeAddModal} className="text-gray-400 text-2xl leading-none">×</button>
            </div>
            <form onSubmit={handleAddSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  銀行 <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedBank}
                  onChange={(e) => handleBankChange(e.target.value)}
                  required
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">請選擇銀行</option>
                  {banks.map((b) => (
                    <option key={b.bank_id} value={b.bank_id}>{b.bank_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  卡片 <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedCard}
                  onChange={(e) => setSelectedCard(e.target.value)}
                  required
                  disabled={!selectedBank}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                >
                  <option value="">{selectedBank ? '請選擇卡片' : '請先選擇銀行'}</option>
                  {filteredCards.map((c) => (
                    <option key={c.card_id} value={c.card_id}>{c.card_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">核卡時間（選填）</label>
                <input
                  type="month"
                  value={approvedDate}
                  onChange={(e) => setApprovedDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">備註（選填）</label>
                <input
                  type="text"
                  value={addNote}
                  onChange={(e) => setAddNote(e.target.value)}
                  placeholder="例：主要消費卡"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={addSubmitting}
                className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50"
              >
                {addSubmitting ? '新增中...' : '新增卡片'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Modal ── */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={closeEditModal} />
          <div className="relative w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-2xl p-6 shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-gray-900">編輯卡片</h2>
              <button onClick={closeEditModal} className="text-gray-400 text-2xl leading-none">×</button>
            </div>
            <form onSubmit={handleEditSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">核卡時間（選填）</label>
                <input
                  type="month"
                  value={editApprovedDate}
                  onChange={(e) => setEditApprovedDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">備註（選填）</label>
                <input
                  type="text"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  placeholder="例：主要消費卡"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={editSubmitting}
                className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 active:scale-95 transition-all disabled:opacity-50"
              >
                {editSubmitting ? '儲存中...' : '儲存'}
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}
