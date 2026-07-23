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
import { createExpense } from '@/actions/expenses'

interface Props {
  sites: Site[]
  paramsMap: Record<string, SiteParameters>
  userId: string
  staffBySite: Record<string, Profile[]>
}

function today() {
  return new Date().toISOString().split('T')[0]
}

function currentYearMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function ExpenseForm({ sites, paramsMap, staffBySite }: Props) {
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

  const params = paramsMap[siteId]
  const welfareLimit = params?.welfare_monthly_limit ?? 50000
  const staffOptions = staffBySite[siteId] ?? []

  // 인원별 주재비 화면(자동계산·개인별 실비 recurring)에서 다루는 항목은 여기서 제외해 중복 입력을 막는다.
  const subcategories = category
    ? EXPENSE_SUBCATEGORIES[category].filter((s) => s.entryType !== 'auto_recurring' && s.entryType !== 'manual_recurring')
    : []
  const selectedSub = subcategories.find((s) => s.value === subcategory)

  // 한도 계산
  const amountNum = parseInt(amount.replace(/,/g, ''), 10) || 0
  const headcountNum = parseInt(headcount, 10) || 1

  let limitWarning = ''
  let isOverLimit = false
  let overLimitAmount = 0

  if (selectedSub?.limitType === 'welfare') {
    const maxAllowed = welfareLimit * headcountNum
    if (amountNum > maxAllowed) {
      isOverLimit = true
      overLimitAmount = amountNum - maxAllowed
      limitWarning = `복리후생비 한도 초과! 1인 1월 ${welfareLimit.toLocaleString()}원 × ${headcountNum}명 = ${maxAllowed.toLocaleString()}원 / 초과분 ${overLimitAmount.toLocaleString()}원은 불인정 처리됩니다.`
    }
  }

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
    files.forEach((f) => formData.append('receipts', f))

    const result = await createExpense(formData)
    setLoading(false)

    if (result.error) {
      setError(result.error)
    } else {
      router.push('/expenses')
    }
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

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              금액 <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={amount}
                onChange={handleAmountChange}
                placeholder="0"
                className={`w-full rounded-lg border px-3 py-2 pr-8 text-right text-sm focus:outline-none focus:ring-2 ${
                  isOverLimit ? 'border-red-400 bg-red-50 focus:ring-red-300' : 'border-gray-300 focus:ring-blue-300'
                }`}
              />
              <span className="absolute right-3 top-2 text-sm text-gray-400">원</span>
            </div>
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

          {selectedSub?.limitType === 'welfare' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">인원 수</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  min="1"
                  value={headcount}
                  onChange={(e) => setHeadcount(e.target.value)}
                  className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
                <span className="text-sm text-gray-500">명</span>
              </div>
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
