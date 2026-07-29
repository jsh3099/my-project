'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_SUBCATEGORIES,
  type ExpenseCategory,
} from '@/lib/constants'
import type { Site, SiteParameters, Profile } from '@/types'
import type { SiteBudgetStatus } from '@/lib/budgetStatus'
import { createExpense } from '@/actions/expenses'
import { applyVatExclusion, calcItemized, calcWelfare } from '@/lib/settlement'

// 건별 사용내역 (정산서 1-4~ / 3-1 서식: 구매일시·구매처·구매내용·금액)
export type ExpenseItemInput = { date: string; vendor: string; description: string; tag: string; amountGross: string }

interface Props {
  sites: Site[]
  paramsMap: Record<string, SiteParameters>
  userId: string
  staffBySite: Record<string, Profile[]>
  /** 현장별 항목별 계상 잔액 (잔액 안내·초과 경고용, 미전달 시 안내 생략) */
  budgetBySite?: Record<string, SiteBudgetStatus>
}

function today() {
  return new Date().toISOString().split('T')[0]
}

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function ExpenseForm({ sites, paramsMap, staffBySite, budgetBySite }: Props) {
  const router = useRouter()

  const [siteId, setSiteId] = useState(sites[0]?.id ?? '')
  const [category, setCategory] = useState<ExpenseCategory | ''>('')
  const [subcategory, setSubcategory] = useState('')
  const [amount, setAmount] = useState('')
  const [expenseDate, setExpenseDate] = useState(today())
  const [headcount, setHeadcount] = useState('1')
  const [targetUserId, setTargetUserId] = useState('')
  const [memo, setMemo] = useState('')
  const [mobileConfirmed, setMobileConfirmed] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // 건별 사용내역 + VAT 제외 (현장운영경비·도서인쇄 등 실비 항목)
  const [items, setItems] = useState<ExpenseItemInput[]>([])
  const [vatExclude, setVatExclude] = useState(true)

  const params = paramsMap[siteId]
  const welfareLimit = params?.welfare_monthly_limit ?? 50000
  const staffOptions = staffBySite[siteId] ?? []

  // 인원별 주재비 화면(자동계산·개인별 실비 recurring)과 기술지원 출장비 화면에서 다루는 항목은 여기서 제외해 중복 입력을 막는다.
  const subcategories = category
    ? EXPENSE_SUBCATEGORIES[category].filter((s) => s.entryType !== 'auto_recurring' && s.entryType !== 'manual_recurring' && s.entryType !== 'auto_trip')
    : []
  const selectedSub = subcategories.find((s) => s.value === subcategory)
  const isWelfare = selectedSub?.limitType === 'welfare'
  // 건별 내역 입력을 지원하는 항목 (현장 단위 실비)
  const supportsItems = selectedSub?.entryType === 'manual_site'

  const headcountNum = parseInt(headcount, 10) || 1
  const validItems = items.filter((i) => (parseInt(i.amountGross.replace(/,/g, ''), 10) || 0) > 0)
    .map((i) => ({ ...i, amountGrossNum: parseInt(i.amountGross.replace(/,/g, ''), 10) || 0 }))
  const hasItems = validItems.length > 0

  // 금액 산정 (미리보기 — 서버가 동일 규칙으로 재계산)
  // - 복리후생: 건별 VAT제외 합(증빙) vs 인원×한도(산출) → min이 인정금액
  // - 그 외 건별: 합계에서 VAT제외
  // - 건별 없이 단일 금액: 입력액에 VAT 토글 적용
  const manualAmountNum = parseInt(amount.replace(/,/g, ''), 10) || 0
  const grossTotal = hasItems ? validItems.reduce((s, i) => s + i.amountGrossNum, 0) : manualAmountNum
  const itemized = calcItemized(
    hasItems ? validItems.map((i) => ({ amountGross: i.amountGrossNum })) : [{ amountGross: manualAmountNum }],
    vatExclude ? 'exclude_10' : 'none',
    { applyPerItem: isWelfare },
  )
  const welfare = isWelfare
    ? calcWelfare({ residentHeadcount: headcountNum, monthlyLimit: welfareLimit, evidenceAmount: itemized.appliedTotal })
    : null

  const amountNum = welfare ? welfare.approvedAmount : itemized.appliedTotal
  const isOverLimit = (welfare?.overLimitAmount ?? 0) > 0
  const overLimitAmount = welfare?.overLimitAmount ?? 0
  const limitWarning = isOverLimit && welfare
    ? `복리후생비 한도 초과: 산출 ${welfare.computedAmount.toLocaleString()}원(${headcountNum}명 × ${welfareLimit.toLocaleString()}) < 증빙 ${welfare.evidenceAmount.toLocaleString()}원 → 인정 ${welfare.approvedAmount.toLocaleString()}원, 초과분 ${overLimitAmount.toLocaleString()}원 불인정`
    : ''

  // ── 항목별 계상 잔액 안내·초과 경고 ──────────────────────────
  // 잔액 = 계상금액 - 누계 사용(확정 청구 + 미편입 인정액). 항목 초과는 직접경비
  // 총액 내에서 흡수 가능하지만, 총액 잔액까지 초과하면 청구할 수 없다.
  const siteBudget = budgetBySite?.[siteId]
  const hasBudgetInfo = !!siteBudget && Object.values(siteBudget.byCategory).some((c) => c.budget > 0)
  const catBudget = category && siteBudget ? siteBudget.byCategory[category] : undefined
  const catRemaining = catBudget ? catBudget.budget - catBudget.used : null
  const totalRemaining = siteBudget ? siteBudget.totalBudget - siteBudget.totalUsed : null
  const overTotalAmount =
    hasBudgetInfo && totalRemaining !== null && amountNum > 0 ? Math.max(0, amountNum - Math.max(0, totalRemaining)) : 0
  const overCategoryOnly =
    overTotalAmount === 0 &&
    !!catBudget && catBudget.budget > 0 && catRemaining !== null && amountNum > 0 && amountNum > Math.max(0, catRemaining)

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    const valid = selected.filter((f) => f.size <= 10 * 1024 * 1024)
    if (valid.length < selected.length) {
      setError('10MB를 초과하는 파일은 제외됩니다.')
    }
    setFiles((prev) => [...prev, ...valid])
  }, [])

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx))

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '')
    setAmount(raw ? parseInt(raw, 10).toLocaleString('ko-KR') : '')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!category || !subcategory) { setError('비목과 세부항목을 선택해주세요.'); return }
    if (!amountNum) { setError('금액을 입력해주세요.'); return }
    if (selectedSub?.entryType === 'manual_person' && !targetUserId) { setError('대상자를 선택해주세요.'); return }
    if (subcategory === 'communication' && !mobileConfirmed) { setError('개인 휴대폰 요금이 아님을 확인해주세요.'); return }

    setLoading(true)
    setError('')

    const formData = new FormData()
    formData.append('site_id', siteId)
    formData.append('year_month', currentYearMonth())
    formData.append('category', category)
    formData.append('subcategory', subcategory)
    formData.append('amount', String(amountNum))
    formData.append('expense_date', expenseDate)
    formData.append('headcount', headcount)
    if (selectedSub?.entryType === 'manual_person' && targetUserId) {
      formData.append('target_user_id', targetUserId)
    }
    formData.append('memo', memo)
    formData.append('is_over_limit', String(isOverLimit))
    formData.append('over_limit_amount', String(overLimitAmount))
    // 건별 내역·VAT·복리후생 정산 파라미터 — 서버가 동일 규칙으로 재계산해 확정
    formData.append('vat_mode', vatExclude ? 'exclude_10' : 'none')
    if (hasItems) {
      formData.append('items', JSON.stringify(validItems.map((i) => ({
        date: i.date || expenseDate, vendor: i.vendor, description: i.description || selectedSub?.label || '', tag: i.tag, amountGross: i.amountGrossNum,
      }))))
    } else if (manualAmountNum > 0) {
      formData.append('items', JSON.stringify([{ date: expenseDate, vendor: '', description: selectedSub?.label ?? '', tag: '', amountGross: manualAmountNum }]))
    }
    if (isWelfare) {
      formData.append('welfare', JSON.stringify({ residentHeadcount: headcountNum, monthlyLimit: welfareLimit }))
    }
    files.forEach((f) => formData.append('receipts', f))

    const result = await createExpense(formData)
    setLoading(false)

    if (result.error) {
      setError(result.error)
    } else {
      router.push('/expenses')
    }
  }

  function updItem(idx: number, patch: Partial<ExpenseItemInput>) {
    setItems((p) => p.map((it, i) => i === idx ? { ...it, ...patch } : it))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* STEP 1: 현장 선택 */}
      {sites.length > 1 && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <label className="mb-2 block text-sm font-semibold text-gray-700">
            현장 선택 <span className="text-red-500">*</span>
          </label>
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* STEP 2: 비목 선택 */}
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="mb-3 text-sm font-semibold text-gray-700">
          비목 선택 <span className="text-red-500">*</span>
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(Object.keys(EXPENSE_CATEGORIES) as (keyof typeof EXPENSE_CATEGORIES)[]).map((key) => {
            const val = EXPENSE_CATEGORIES[key]
            const b = siteBudget?.byCategory[val]
            const remaining = b && b.budget > 0 ? b.budget - b.used : null
            return (
              <button
                key={val}
                type="button"
                onClick={() => { setCategory(val); setSubcategory(''); setTargetUserId('') }}
                className={`rounded-lg border-2 px-3 py-2.5 text-sm font-medium transition-all ${
                  category === val
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50'
                }`}
              >
                {EXPENSE_CATEGORY_LABELS[val]}
                {remaining !== null && (
                  <span className={`mt-0.5 block text-xs font-normal ${remaining < 0 ? 'text-red-500' : 'opacity-60'}`}>
                    {remaining < 0 ? `계상 초과 ${(-remaining).toLocaleString()}원` : `잔액 ${remaining.toLocaleString()}원`}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* STEP 3: 세부항목 */}
      {category && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="mb-3 text-sm font-semibold text-gray-700">
            세부항목 <span className="text-red-500">*</span>
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {subcategories.map((sub) => (
              <button
                key={sub.value}
                type="button"
                onClick={() => setSubcategory(sub.value)}
                className={`rounded-lg border-2 px-3 py-2.5 text-left text-sm transition-all ${
                  subcategory === sub.value
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 text-gray-600 hover:border-blue-300 hover:bg-blue-50'
                }`}
              >
                <span className="font-medium">{sub.label}</span>
                {sub.notes && <span className="mt-0.5 block text-xs opacity-70">{sub.notes}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 필수 증빙 안내 */}
      {selectedSub && selectedSub.requireDocs.length > 0 && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="mb-2 flex items-center gap-1 text-sm font-semibold text-blue-700">
            📋 필수 증빙자료
          </p>
          <ul className="space-y-1">
            {selectedSub.requireDocs.map((doc, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-blue-700">
                <span className="mt-0.5 text-blue-400">•</span>
                {doc}
              </li>
            ))}
          </ul>
          {selectedSub.notes && (
            <p className="mt-2 text-xs text-blue-600">{selectedSub.notes}</p>
          )}
        </div>
      )}

      {/* STEP 4: 금액·날짜·인원·메모 */}
      {subcategory && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <p className="text-sm font-semibold text-gray-700">상세 입력</p>

          {/* 건별 사용내역 (현장 단위 실비 — 정산서 세부 사용내역 서식) */}
          {supportsItems && (
            <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50/60 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-600">🧾 건별 사용내역 (구매일시·구매처·구매내용·금액)</p>
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  <input type="checkbox" checked={vatExclude} onChange={(e) => setVatExclude(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600" />
                  적용금액 VAT 제외 (÷1.1)
                </label>
              </div>
              {items.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="py-1 text-left">사용일자</th>
                      <th className="py-1 text-left">구매처</th>
                      <th className="py-1 text-left">내용</th>
                      {isWelfare && <th className="py-1 text-left">구분</th>}
                      <th className="py-1 text-right">금액</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={idx}>
                        <td className="py-1 pr-1.5">
                          <input type="date" value={it.date} onChange={(e) => updItem(idx, { date: e.target.value })}
                            className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </td>
                        <td className="py-1 pr-1.5">
                          <input type="text" value={it.vendor} onChange={(e) => updItem(idx, { vendor: e.target.value })}
                            placeholder="쿠팡" className="w-full rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </td>
                        <td className="py-1 pr-1.5">
                          <input type="text" value={it.description} onChange={(e) => updItem(idx, { description: e.target.value })}
                            placeholder="사무용품(종이컵)" className="w-full rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                        </td>
                        {isWelfare && (
                          <td className="py-1 pr-1.5">
                            <select value={it.tag} onChange={(e) => updItem(idx, { tag: e.target.value })}
                              className="rounded border border-gray-300 px-1 py-1 text-xs focus:outline-none">
                              <option value="식대">식대</option>
                              <option value="음료">음료</option>
                              <option value="기타">기타</option>
                            </select>
                          </td>
                        )}
                        <td className="py-1 w-28">
                          <input type="text" inputMode="numeric" value={it.amountGross}
                            onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); updItem(idx, { amountGross: r ? parseInt(r).toLocaleString('ko-KR') : '' }) }}
                            className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                        </td>
                        <td className="py-1 pl-1">
                          <button type="button" onClick={() => setItems((p) => p.filter((_, i) => i !== idx))}
                            className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button type="button" onClick={() => setItems((p) => [...p, { date: expenseDate, vendor: '', description: '', tag: isWelfare ? '식대' : '', amountGross: '' }])}
                className="rounded border border-dashed border-gray-400 px-2.5 py-1 text-xs text-gray-600 hover:border-blue-400 hover:text-blue-600">
                + 내역 추가
              </button>
              {hasItems && (
                <p className="text-xs text-gray-600">
                  합계 <b>{grossTotal.toLocaleString()}원</b>
                  {vatExclude && <> → 적용금액(VAT제외) <b className="text-blue-700">{itemized.appliedTotal.toLocaleString()}원</b></>}
                </p>
              )}
            </div>
          )}

          {/* 복리후생비 월별 정산기준 (인정금액 = min(인원×한도, 증빙)) */}
          {isWelfare && (
            <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
              <p className="text-xs font-semibold text-amber-800">복리후생비 월별 정산기준</p>
              <div className="flex items-center gap-2 text-xs text-gray-700">
                <span>상주인원</span>
                <input
                  type="number" min="1" value={headcount} onChange={(e) => setHeadcount(e.target.value)}
                  className="w-16 rounded border border-gray-300 px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
                <span>명 × 월한도 {welfareLimit.toLocaleString()}원 = 산출금액 <b>{(welfare?.computedAmount ?? 0).toLocaleString()}원</b></span>
              </div>
              <p className="text-xs text-gray-700">
                증빙금액(건별 VAT제외 합) <b>{(welfare?.evidenceAmount ?? 0).toLocaleString()}원</b>
                {' '}→ 인정금액 <b className="text-amber-800">{(welfare?.approvedAmount ?? 0).toLocaleString()}원</b>
              </p>
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {isWelfare ? '인정금액 (자동)' : hasItems ? '적용금액 (자동)' : '금액'} {!hasItems && !isWelfare && <span className="text-red-500">*</span>}
            </label>
            <div className="relative">
              <input
                type="text"
                value={hasItems || isWelfare ? (amountNum > 0 ? amountNum.toLocaleString('ko-KR') : '') : amount}
                onChange={handleAmountChange}
                readOnly={hasItems || isWelfare}
                placeholder="0"
                className={`w-full rounded-lg border px-3 py-2 pr-8 text-right text-sm focus:outline-none focus:ring-2 ${
                  isOverLimit ? 'border-red-400 bg-red-50 focus:ring-red-300' : 'border-gray-300 focus:ring-blue-300'
                } ${hasItems || isWelfare ? 'bg-gray-50 text-gray-600' : ''}`}
              />
              <span className="absolute right-3 top-2 text-sm text-gray-400">원</span>
            </div>
            {!hasItems && !isWelfare && supportsItems && vatExclude && manualAmountNum > 0 && (
              <p className="mt-1 text-xs text-gray-500">적용금액(VAT제외): {applyVatExclusion(manualAmountNum).toLocaleString()}원으로 저장됩니다</p>
            )}
          </div>

          {subcategory === 'communication' && (
            <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3">
              <input
                id="mobileConfirmed"
                type="checkbox"
                checked={mobileConfirmed}
                onChange={(e) => setMobileConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              <label htmlFor="mobileConfirmed" className="text-sm text-yellow-800">
                개인 휴대폰 요금이 아닌 회사·현장 공용 통신비임을 확인합니다.
                <span className="mt-0.5 block text-xs text-yellow-600">개인 휴대폰 이용금액은 불인정 처리되어 저장이 제한됩니다.</span>
              </label>
            </div>
          )}

          {selectedSub?.entryType === 'manual_person' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                대상자 <span className="text-red-500">*</span>
              </label>
              <select
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              >
                <option value="">선택하세요</option>
                {staffOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">메모 (선택)</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={2}
              placeholder="용도, 장소 등 간단히 메모"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          {/* 한도 경고 */}
          {limitWarning && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              ⚠️ {limitWarning}
            </div>
          )}

          {/* 계상 잔액 안내·초과 경고 */}
          {hasBudgetInfo && catBudget && catBudget.budget > 0 && amountNum === 0 && (
            <p className="text-xs text-gray-500">
              이 항목 계상 잔액 {Math.max(0, catRemaining ?? 0).toLocaleString()}원 · 직접경비 총액 잔액{' '}
              {Math.max(0, totalRemaining ?? 0).toLocaleString()}원
            </p>
          )}
          {overCategoryOnly && (
            <div className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-700">
              이 금액을 저장하면 <b>{EXPENSE_CATEGORY_LABELS[category as ExpenseCategory]}</b> 항목의 계상 잔액
              ({Math.max(0, catRemaining ?? 0).toLocaleString()}원)을 초과합니다. 직접경비 총액 잔액
              ({Math.max(0, totalRemaining ?? 0).toLocaleString()}원) 내이므로 타 항목 잔액에서 흡수 가능하지만,
              본사 정산 담당자와 협의하세요.
            </div>
          )}
          {overTotalAmount > 0 && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              ⚠️ 직접경비 총액 잔액({Math.max(0, totalRemaining ?? 0).toLocaleString()}원)을 초과합니다 —
              초과분 <b>{overTotalAmount.toLocaleString()}원은 발주청에 청구할 수 없어 미지급될 수 있습니다.</b>{' '}
              저장은 가능하지만 본사 정산 담당자에게 확인하세요.
            </div>
          )}
        </div>
      )}

      {/* 영수증 첨부 */}
      {subcategory && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            영수증 첨부 {selectedSub && selectedSub.requireDocs.length > 0 && <span className="text-red-500">*</span>}
          </label>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.pdf"
            multiple
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
          />
          {files.length > 0 && (
            <ul className="space-y-1.5">
              {files.map((f, i) => (
                <li key={i} className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm">
                  <span className="truncate text-gray-700">{f.name}</span>
                  <button type="button" onClick={() => removeFile(i)} className="ml-2 shrink-0 text-xs text-red-500 hover:text-red-700">
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-gray-400">JPG·PNG·PDF · 10MB 이하</p>
        </div>
      )}

      {/* 에러 메시지 */}
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 제출 버튼 */}
      {subcategory && (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            취소
          </button>
          <button
            type="submit"
            disabled={loading || (subcategory === 'communication' && !mobileConfirmed)}
            className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? '저장 중...' : isOverLimit ? '저장 (초과분 불인정)' : '저장'}
          </button>
        </div>
      )}
    </form>
  )
}
