'use client'

// 현장경비 입력 — 카드 1장 = 세부항목 1개 (정산서 세부 사용내역의 표 1개).
// 기존 4단계 위저드(1건 입력 후 목록 이동)를 회차 전체가 한 화면에 보이는
// 카드 목록으로 교체한다. 저장 단위는 기존과 동일한 월 × 세부항목 expense + items[].
// 상태 칩(저장됨/확인 필요/미입력)·우측 시트·증분 저장·영수증 자동 인식은 주재비 카드 패턴.

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_SUBCATEGORIES,
  type ExpenseCategory,
} from '@/lib/constants'
import type { Profile } from '@/types'
import type { SiteBudgetStatus } from '@/lib/budgetStatus'
import {
  saveSiteExpenseCard,
  attachSiteExpenseReceipt,
  detachSiteExpenseReceipt,
  type SiteExpenseCardPayload,
  type SiteExpenseReceiptTarget,
} from '@/actions/siteExpenses'
import { parseExpenseReceipt } from '@/actions/receiptParse'
import { calcItemized, calcWelfare } from '@/lib/settlement'
import { receiptFileName, receiptHref } from '@/lib/storage/receipts'

// 서버에서 복원하는 draft (월 × 세부항목 1건)
export interface SiteExpenseCardDraft {
  category: ExpenseCategory
  subcategory: string
  targetUserId: string | null
  yearMonth: string
  vatMode: 'none' | 'exclude_10'
  headcount: number
  receiptUrls: string[]
  items: { date: string; vendor: string; description: string; tag: string; amountGross: number }[]
}

interface Props {
  siteId: string
  roundLabel: string
  months: string[]        // 회차 기성기간의 연월 목록 (진행 중 회차 없으면 이번 달)
  periodStart: string
  periodEnd: string
  staff: Profile[]        // manual_person 대상자 옵션
  welfareLimit: number
  budget: SiteBudgetStatus | null
  drafts: SiteExpenseCardDraft[]
}

const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_SIZE = 10 * 1024 * 1024

type ItemRow = {
  rid: number
  date: string
  vendor: string
  description: string
  tag: string
  amountGross: string // 콤마 표기
  saved: boolean      // 서버 저장값과 일치 (행 상태 칩)
}

type CardState = {
  key: string // subcategory::targetUserId
  category: ExpenseCategory
  subcategory: string
  targetUserId: string
  vatMode: 'none' | 'exclude_10'
  headcount: string // 복리후생 상주인원
  mobileConfirmed: boolean
  items: ItemRow[]
  receiptUrls: string[]
  savedTotal: number // 서버에 저장된 인정금액 합 (저장됨 판정)
}

let ridSeq = 0
const parseNum = (v: string) => parseInt(v.replace(/,/g, ''), 10) || 0
const fmt = (n: number) => n.toLocaleString('ko-KR')

// 카드 좌측 보더·칩 색 — 비목별 (목업의 색 토큰)
const CATEGORY_ACCENT: Record<ExpenseCategory, { border: string; chip: string }> = {
  site_residence: { border: 'border-l-indigo-500', chip: 'bg-indigo-50 text-indigo-700' },
  vehicle: { border: 'border-l-blue-500', chip: 'bg-blue-50 text-blue-700' },
  business_trip: { border: 'border-l-teal-500', chip: 'bg-teal-50 text-teal-700' },
  local_staff: { border: 'border-l-rose-400', chip: 'bg-rose-50 text-rose-700' },
  printing: { border: 'border-l-emerald-500', chip: 'bg-emerald-50 text-emerald-700' },
}

// 현장주재비 세부항목은 중분류 라벨을 칩에 쓴다 (현장운영경비 등)
function categoryChipLabel(category: ExpenseCategory, subcategory: string): string {
  if (category === 'site_residence') {
    const mid = EXPENSE_SUBCATEGORIES.site_residence.find((s) => s.value === subcategory)?.midCategory
    if (mid === 'site_operation') return '현장운영경비'
  }
  return EXPENSE_CATEGORY_LABELS[category]
}

function subDef(category: ExpenseCategory, subcategory: string) {
  return EXPENSE_SUBCATEGORIES[category]?.find((s) => s.value === subcategory)
}

export function SiteExpenseBoard({
  siteId, roundLabel, months, periodStart, periodEnd, staff, welfareLimit, budget, drafts,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // 서버 draft(월 단위)를 카드(세부항목 단위)로 묶어 복원
  function seedCards(): CardState[] {
    const byKey = new Map<string, CardState>()
    for (const d of drafts) {
      const key = `${d.subcategory}::${d.targetUserId ?? ''}`
      let card = byKey.get(key)
      if (!card) {
        card = {
          key,
          category: d.category,
          subcategory: d.subcategory,
          targetUserId: d.targetUserId ?? '',
          vatMode: d.vatMode,
          headcount: String(d.headcount || 1),
          mobileConfirmed: true, // 저장돼 있던 카드는 이미 확인된 것으로 본다
          items: [],
          receiptUrls: [],
          savedTotal: 0,
        }
        byKey.set(key, card)
      }
      card.receiptUrls = [...new Set([...card.receiptUrls, ...d.receiptUrls])]
      if (d.vatMode === 'exclude_10') card.vatMode = 'exclude_10'
      if (d.headcount > 1) card.headcount = String(d.headcount)
      for (const i of d.items) {
        card.items.push({
          rid: ++ridSeq,
          date: i.date,
          vendor: i.vendor,
          description: i.description,
          tag: i.tag,
          amountGross: i.amountGross > 0 ? fmt(i.amountGross) : '',
          saved: true,
        })
      }
    }
    // 저장된 인정금액 합 (미리보기 계산과 동일 규칙으로 복원 시점에 계산)
    for (const card of byKey.values()) {
      card.savedTotal = computeCardTotal(card)
      card.items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))
    }
    return [...byKey.values()]
  }

  // 카드 인정금액 (미리보기 — 서버가 동일 규칙으로 재계산)
  function computeCardTotal(card: Pick<CardState, 'category' | 'subcategory' | 'vatMode' | 'headcount' | 'items'>): number {
    const isWelfare = subDef(card.category, card.subcategory)?.limitType === 'welfare'
    const byMonth = groupByMonth(card.items)
    let total = 0
    for (const [, rows] of byMonth) {
      const items = rows.filter((r) => parseNum(r.amountGross) > 0).map((r) => ({ amountGross: parseNum(r.amountGross) }))
      if (items.length === 0) continue
      const itemized = calcItemized(items, card.vatMode, { applyPerItem: isWelfare })
      if (isWelfare) {
        const w = calcWelfare({
          residentHeadcount: parseInt(card.headcount, 10) || 1,
          monthlyLimit: welfareLimit,
          evidenceAmount: itemized.appliedTotal,
        })
        total += w.approvedAmount
      } else {
        total += itemized.appliedTotal
      }
    }
    return total
  }

  // 내역을 연월로 묶는다 — 회차 밖 날짜·미지정은 회차 시작 월로 귀속 (조용히 버리지 않는다)
  function monthOf(date: string): string {
    const ym = date.slice(0, 7)
    return months.includes(ym) ? ym : months[0]
  }
  function groupByMonth(items: ItemRow[]): [string, ItemRow[]][] {
    const map = new Map<string, ItemRow[]>()
    for (const it of items) {
      const ym = monthOf(it.date)
      if (!map.has(ym)) map.set(ym, [])
      map.get(ym)!.push(it)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }

  const [cards, setCards] = useState<CardState[]>(seedCards)
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set(cards.map((c) => c.key)))
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [saveState, setSaveState] = useState<Record<string, 'saving' | 'saved' | undefined>>({})
  const [notice, setNotice] = useState<Record<string, { kind: 'ok' | 'warn'; text: string } | undefined>>({})
  const [uploading, setUploading] = useState<Set<string>>(new Set())
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  // ── 우측 시트: 항목 상세 (필수 증빙·계상 잔액·복리후생 산출 근거) ──
  const [sheetKey, setSheetKey] = useState<string | null>(null)
  useEffect(() => {
    if (!sheetKey) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheetKey(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetKey])

  function patchCard(key: string, patch: Partial<CardState>, markDirty = true) {
    setCards((p) => p.map((c) => (c.key === key ? { ...c, ...patch } : c)))
    if (markDirty) {
      setDirty((p) => new Set(p).add(key))
      setSaveState((p) => ({ ...p, [key]: undefined }))
    }
  }

  function patchItem(key: string, rid: number, patch: Partial<ItemRow>) {
    setCards((p) => p.map((c) => c.key === key
      ? { ...c, items: c.items.map((it) => (it.rid === rid ? { ...it, ...patch, saved: false } : it)) }
      : c))
    setDirty((p) => new Set(p).add(key))
    setSaveState((p) => ({ ...p, [key]: undefined }))
  }

  function addItem(key: string, seed?: Partial<ItemRow>) {
    const isWelfare = (() => { const c = cards.find((x) => x.key === key); return c ? subDef(c.category, c.subcategory)?.limitType === 'welfare' : false })()
    setCards((p) => p.map((c) => c.key === key
      ? { ...c, items: [...c.items, { rid: ++ridSeq, date: '', vendor: '', description: '', tag: isWelfare ? '식대' : '', amountGross: '', saved: false, ...seed }] }
      : c))
    setDirty((p) => new Set(p).add(key))
    setSaveState((p) => ({ ...p, [key]: undefined }))
  }

  function removeItem(key: string, rid: number) {
    setCards((p) => p.map((c) => (c.key === key ? { ...c, items: c.items.filter((it) => it.rid !== rid) } : c)))
    setDirty((p) => new Set(p).add(key))
    setSaveState((p) => ({ ...p, [key]: undefined }))
  }

  function toggleOpen(key: string) {
    setOpenCards((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n })
  }

  // 닫기 확인은 화면 안에서 받는다 — window.confirm은 미리보기 패널 등 일부 환경에서
  // 대화상자 없이 즉시 false를 반환해 "눌러도 아무 일 없는" 상태가 된다.
  // (출근부 화면 인원 제외와 같은 방식 — 카드 아래 빨간 띠로 확인)
  const [closeConfirmKey, setCloseConfirmKey] = useState<string | null>(null)

  function requestRemoveCard(key: string) {
    const card = cards.find((c) => c.key === key)
    if (!card) return
    // 저장된 내역·첨부가 있으면 "화면에서만 닫힌다"는 점을 먼저 알린다
    if (card.savedTotal > 0 || card.receiptUrls.length > 0) {
      setCloseConfirmKey(key)
      return
    }
    removeCard(key)
  }

  function removeCard(key: string) {
    setCloseConfirmKey(null)
    setCards((p) => p.filter((c) => c.key !== key))
    setSheetKey((p) => (p === key ? null : p))
  }

  // ── 영수증: 첨부 즉시 업로드 + 금액·일자 자동 인식 → 내역 행 제안 ──
  function receiptTarget(card: CardState): SiteExpenseReceiptTarget {
    return {
      siteId,
      category: card.category,
      subcategory: card.subcategory,
      targetUserId: card.targetUserId || null,
      anchorYearMonth: months[0],
    }
  }

  function handleFiles(key: string, files: File[]) {
    const card = cards.find((c) => c.key === key)
    if (!card) return
    const valid = files.filter((f) => f.size > 0 && f.size <= MAX_SIZE)
    if (valid.length < files.length) setNotice((p) => ({ ...p, [key]: { kind: 'warn', text: '10MB를 초과하는 파일은 제외했습니다.' } }))
    if (valid.length === 0) return

    setUploading((p) => new Set(p).add(key))
    setNotice((p) => ({ ...p, [key]: undefined }))

    const fd = new FormData()
    fd.set('target', JSON.stringify(receiptTarget(card)))
    for (const f of valid) fd.append('files', f)

    const parseFd = new FormData()
    for (const f of valid) parseFd.append('files', f)

    startTransition(async () => {
      // 업로드(즉시 저장)와 인식(제안)을 함께 — 인식 실패해도 첨부는 남는다
      const [up, parsed] = await Promise.all([attachSiteExpenseReceipt(fd), parseExpenseReceipt(parseFd)])
      setUploading((p) => { const n = new Set(p); n.delete(key); return n })

      if ('error' in up) { setNotice((p) => ({ ...p, [key]: { kind: 'warn', text: up.error } })); return }
      setCards((p) => p.map((c) => c.key === key ? { ...c, receiptUrls: [...new Set([...c.receiptUrls, ...up.added])] } : c))

      if ('error' in parsed) {
        setNotice((p) => ({ ...p, [key]: { kind: 'warn', text: `영수증 ${up.added.length}장 저장됨. ${parsed.error}` } }))
        return
      }
      const suggestions = parsed.items.filter((i) => i.amountGross > 0)
      for (const s of suggestions) {
        addItem(key, { date: s.date, vendor: s.vendor, description: s.description, amountGross: fmt(s.amountGross) })
      }
      setNotice((p) => ({
        ...p,
        [key]: suggestions.length > 0
          ? { kind: 'ok', text: `영수증 ${up.added.length}장 저장됨 · 내역 ${suggestions.length}건 자동 인식 — 확인 후 저장하세요.` }
          : { kind: 'ok', text: `영수증 ${up.added.length}장 저장됨. (금액 인식 없음 — 내역을 직접 입력하세요)` },
      }))
    })
  }

  function removeReceipt(key: string, url: string) {
    const card = cards.find((c) => c.key === key)
    if (!card) return
    const fd = new FormData()
    fd.set('target', JSON.stringify(receiptTarget(card)))
    fd.set('url', url)
    startTransition(async () => {
      const res = await detachSiteExpenseReceipt(fd)
      if ('error' in res) { setNotice((p) => ({ ...p, [key]: { kind: 'warn', text: res.error } })); return }
      setCards((p) => p.map((c) => c.key === key ? { ...c, receiptUrls: c.receiptUrls.filter((u) => u !== url) } : c))
    })
  }

  // ── 저장 (카드 단위) ──
  function saveCard(key: string) {
    const card = cards.find((c) => c.key === key)
    if (!card) return
    const def = subDef(card.category, card.subcategory)
    if (!def) return
    setError(null)
    if (def.entryType === 'manual_person' && !card.targetUserId) { setError(`${def.label}: 대상자를 선택하세요.`); return }
    if (card.subcategory === 'communication' && !card.mobileConfirmed) { setError('통신비: 개인 휴대폰 요금이 아님을 확인해주세요.'); return }

    const isWelfare = def.limitType === 'welfare'
    const itemsByMonth: Record<string, { date: string; vendor: string; description: string; tag: string; amountGross: number }[]> = {}
    for (const [ym, rows] of groupByMonth(card.items)) {
      const valid = rows.filter((r) => parseNum(r.amountGross) > 0)
      if (valid.length === 0) continue
      itemsByMonth[ym] = valid.map((r) => ({
        date: r.date, vendor: r.vendor, description: r.description, tag: r.tag, amountGross: parseNum(r.amountGross),
      }))
    }

    const payload: SiteExpenseCardPayload = {
      siteId,
      category: card.category,
      subcategory: card.subcategory,
      vatMode: card.vatMode,
      targetUserId: card.targetUserId || null,
      welfare: isWelfare ? { residentHeadcount: parseInt(card.headcount, 10) || 1, monthlyLimit: welfareLimit } : null,
      months,
      itemsByMonth,
    }

    const fd = new FormData()
    fd.set('payload', JSON.stringify(payload))
    setSaveState((p) => ({ ...p, [key]: 'saving' }))
    startTransition(async () => {
      const res = await saveSiteExpenseCard(fd)
      if ('error' in res) {
        setSaveState((p) => ({ ...p, [key]: undefined }))
        setError(res.error as string)
        return
      }
      const savedTotal = Object.values(res.savedAmounts).reduce((s, v) => s + v, 0)
      setCards((p) => p.map((c) => c.key === key
        ? { ...c, savedTotal, items: c.items.map((it) => ({ ...it, saved: parseNum(it.amountGross) > 0 })) }
        : c))
      setDirty((p) => { const n = new Set(p); n.delete(key); return n })
      setSaveState((p) => ({ ...p, [key]: 'saved' }))
      router.refresh()
    })
  }

  function saveAll() {
    for (const c of cards) if (dirty.has(c.key)) saveCard(c.key)
  }

  // ── + 항목 추가 피커 ──
  const [pickerCategory, setPickerCategory] = useState<ExpenseCategory>('site_residence')
  const pickerSubs = (EXPENSE_SUBCATEGORIES[pickerCategory] ?? []).filter(
    (s) => s.entryType === 'manual_site' || s.entryType === 'manual_person',
  )
  function addCard(category: ExpenseCategory, subcategory: string) {
    const key = `${subcategory}::`
    if (cards.some((c) => c.subcategory === subcategory && !c.targetUserId)) {
      setOpenCards((p) => new Set(p).add(key))
      return
    }
    const def = subDef(category, subcategory)
    setCards((p) => [...p, {
      key,
      category,
      subcategory,
      targetUserId: '',
      vatMode: def?.entryType === 'manual_site' ? 'exclude_10' : 'none',
      headcount: '1',
      mobileConfirmed: false,
      items: [],
      receiptUrls: [],
      savedTotal: 0,
    }])
    setOpenCards((p) => new Set(p).add(key))
  }

  // ── 상태 칩 ──
  function cardStatus(card: CardState): 'saved' | 'pending' | 'empty' {
    const hasValue = card.items.some((it) => parseNum(it.amountGross) > 0)
    if (dirty.has(card.key)) return hasValue || card.savedTotal > 0 ? 'pending' : 'empty'
    if (card.savedTotal > 0) return 'saved'
    return hasValue ? 'pending' : 'empty'
  }
  const STATUS_CHIP: Record<'saved' | 'pending' | 'empty', [string, string]> = {
    saved: ['bg-green-50 text-green-700', '✓ 저장됨'],
    pending: ['bg-amber-50 text-amber-700', '확인 필요'],
    empty: ['bg-gray-100 text-gray-400', '미입력'],
  }

  // 비목별 계상 잔액 (카드 캡션·시트)
  function categoryRemaining(category: ExpenseCategory): number | null {
    const b = budget?.byCategory[category]
    if (!b || b.budget <= 0) return null
    return b.budget - b.used
  }

  const grandTotal = cards.reduce((s, c) => s + computeCardTotal(c), 0)
  const sheetCard = sheetKey ? cards.find((c) => c.key === sheetKey) : undefined
  const sheetDef = sheetCard ? subDef(sheetCard.category, sheetCard.subcategory) : undefined

  // 직접경비 총액 초과 미리보기 — 발주청 정산(매 기성·준공)에서 총액 초과분은 청구 불가(미지급)이므로
  // 저장 전에 경고한다. 서버 집계(totalUsed, draft 포함·현장 전체)에 아직 저장 안 된 입력분을 얹는다.
  const unsavedDelta = cards.reduce((s, c) => s + (computeCardTotal(c) - c.savedTotal), 0)
  const projectedTotalRemaining =
    budget && budget.totalBudget > 0 ? budget.totalBudget - budget.totalUsed - unsavedDelta : null
  const overTotalAmount = projectedTotalRemaining !== null && projectedTotalRemaining < 0 ? -projectedTotalRemaining : 0

  // ── 카드 렌더 (렌더 함수 호출 — JSX 태그로 쓰면 렌더마다 리마운트되어 포커스가 유실된다) ──
  function renderCard(card: CardState) {
    const def = subDef(card.category, card.subcategory)
    if (!def) return null
    const isOpen = openCards.has(card.key)
    const isWelfare = def.limitType === 'welfare'
    const accent = CATEGORY_ACCENT[card.category]
    const status = cardStatus(card)
    const [chipCls, chipLabel] = STATUS_CHIP[status]
    const total = computeCardTotal(card)
    const remaining = categoryRemaining(card.category)
    const validCount = card.items.filter((it) => parseNum(it.amountGross) > 0).length
    const n = notice[card.key]
    const st = saveState[card.key]
    const headcountNum = parseInt(card.headcount, 10) || 1

    // 복리후생 월별 초과 합계 (배너)
    let welfareOverTotal = 0
    if (isWelfare) {
      for (const [, rows] of groupByMonth(card.items)) {
        const items = rows.filter((r) => parseNum(r.amountGross) > 0).map((r) => ({ amountGross: parseNum(r.amountGross) }))
        if (items.length === 0) continue
        const itemized = calcItemized(items, card.vatMode, { applyPerItem: true })
        welfareOverTotal += calcWelfare({ residentHeadcount: headcountNum, monthlyLimit: welfareLimit, evidenceAmount: itemized.appliedTotal }).overLimitAmount
      }
    }

    const groups = groupByMonth(card.items)
    const gridCols = isWelfare
      ? 'grid-cols-[104px_1fr_1.3fr_74px_110px_110px_76px_28px]'
      : 'grid-cols-[104px_1fr_1.5fr_110px_110px_76px_28px]'

    return (
      <article key={card.key} className={`overflow-hidden rounded-xl border border-gray-200 border-l-4 ${accent.border} bg-white shadow-sm`}>
        {/* 요약 행 */}
        <div
          className="flex cursor-pointer select-none flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 hover:bg-gray-50/70"
          onClick={(e) => { if ((e.target as HTMLElement).closest('input,select,button,a,label')) return; toggleOpen(card.key) }}
        >
          <span className="text-[15px] font-bold text-gray-900">{def.label}</span>
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${accent.chip}`}>
            {categoryChipLabel(card.category, card.subcategory)}
          </span>
          {validCount > 0 && (
            <span className="whitespace-nowrap rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">{validCount}건</span>
          )}
          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${chipCls}`}>{chipLabel}</span>
          {/* 금액은 있는데 증빙이 없으면 발주청 삭감 1순위 — 저장 전에 보이게 한다 */}
          {validCount > 0 && card.receiptUrls.length === 0 && def.requireDocs.length > 0 && (
            <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
              ⚠ 증빙 없음
            </span>
          )}
          {isWelfare && welfareOverTotal > 0 && (
            <span className="whitespace-nowrap rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">
              한도 초과 {fmt(welfareOverTotal)}원 불인정
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <div className="text-right">
              <div className="text-[15px] font-bold text-gray-900">{total > 0 ? `${fmt(total)}원` : '—'}</div>
              <div className="text-[10px] text-gray-400">
                {remaining !== null
                  ? remaining < 0
                    ? <span className="font-semibold text-red-500">계상 초과 {fmt(-remaining)}원</span>
                    : `계상 잔액 ${fmt(remaining)}원`
                  : '인정금액'}
              </div>
            </div>
            <button type="button" onClick={() => toggleOpen(card.key)} aria-expanded={isOpen} aria-label="상세 접기/펼치기"
              className={`rounded p-1 text-gray-400 transition-transform hover:bg-gray-100 ${isOpen ? 'rotate-180' : ''}`}>▾</button>
            <button type="button" onClick={() => requestRemoveCard(card.key)} title="카드 닫기"
              className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500">✕</button>
          </div>
        </div>

        {/* 닫기 확인 띠 — 저장된 값은 지워지지 않는다는 점이 오해 지점이라 문장으로 남긴다 */}
        {closeConfirmKey === card.key && (
          <div className="flex flex-wrap items-center gap-2 border-t border-red-100 bg-red-50 px-4 py-2.5">
            <span className="text-xs text-red-700">
              저장된 내역·첨부가 있는 항목입니다. <b>화면에서만 닫습니다</b> — 저장된 값을 지우려면 내역을 비우고 저장하세요.
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => removeCard(card.key)}
                className="rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700">닫기</button>
              <button type="button" onClick={() => setCloseConfirmKey(null)}
                className="rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50">취소</button>
            </div>
          </div>
        )}

        {isOpen && (
          <>
            {/* 조건 바 — VAT·한도 기준·대상자는 카드당 한 번 */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5 text-xs text-gray-500">
              {isWelfare && (
                <span className="flex items-center gap-1.5">
                  월별 정산기준: 상주
                  <input type="number" min={1} value={card.headcount}
                    onChange={(e) => patchCard(card.key, { headcount: e.target.value })}
                    className="w-14 rounded border border-gray-300 bg-white px-1.5 py-1 text-center text-xs focus:border-blue-500 focus:outline-none" />
                  명 × 월한도 {fmt(welfareLimit)}원 = <b className="text-gray-700">{fmt(headcountNum * welfareLimit)}원/월</b>
                </span>
              )}
              {def.entryType === 'manual_person' && (
                <label className="flex items-center gap-1.5">대상자
                  <select value={card.targetUserId}
                    onChange={(e) => patchCard(card.key, { targetUserId: e.target.value })}
                    className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none">
                    <option value="">선택하세요</option>
                    {staff.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-gray-600">
                <input type="checkbox" checked={card.vatMode === 'exclude_10'}
                  onChange={(e) => patchCard(card.key, { vatMode: e.target.checked ? 'exclude_10' : 'none' })}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600" />
                적용금액 VAT 제외 (÷1.1)
              </label>
              {card.subcategory === 'communication' && (
                <label className="flex items-center gap-1.5 text-yellow-800">
                  <input type="checkbox" checked={card.mobileConfirmed}
                    onChange={(e) => patchCard(card.key, { mobileConfirmed: e.target.checked })}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600" />
                  개인 휴대폰 요금이 아님을 확인 (개인분은 불인정)
                </label>
              )}
              <button type="button" onClick={() => setSheetKey(card.key)}
                className="text-xs font-semibold text-blue-600 hover:underline">
                📎 항목 상세 (증빙 기준·계상 잔액)
              </button>
            </div>

            {/* 복리후생 한도 배너 */}
            {isWelfare && welfareOverTotal > 0 && (
              <div className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                증빙이 월 산출금액({fmt(headcountNum * welfareLimit)}원)을 넘는 달이 있습니다 —
                초과분 합계 <b>{fmt(welfareOverTotal)}원은 불인정</b>(발주청 미청구)됩니다.
              </div>
            )}

            {/* 건별 내역 — 월별 그룹 */}
            {card.items.length > 0 && (
              <div className="overflow-x-auto border-t border-gray-100">
                <div className="min-w-[820px]">
                  <div className={`grid ${gridCols} items-center gap-2 px-4 pt-2 pb-1 text-[10.5px] font-semibold text-gray-400`}>
                    <span>사용일자</span>
                    <span>구매처</span>
                    <span>내용</span>
                    {isWelfare && <span>구분</span>}
                    <span className="text-right">금액</span>
                    <span className="text-right">적용금액</span>
                    <span className="text-center">상태</span>
                    <span />
                  </div>
                  {groups.map(([ym, rows]) => {
                    const monthValid = rows.filter((r) => parseNum(r.amountGross) > 0)
                    const itemized = calcItemized(monthValid.map((r) => ({ amountGross: parseNum(r.amountGross) })), card.vatMode, { applyPerItem: isWelfare })
                    const w = isWelfare && monthValid.length > 0
                      ? calcWelfare({ residentHeadcount: headcountNum, monthlyLimit: welfareLimit, evidenceAmount: itemized.appliedTotal })
                      : null
                    return (
                      <div key={ym}>
                        <div className="flex items-center gap-2 px-4 pt-1.5 pb-0.5 text-[11px] font-bold tracking-wide text-gray-400">
                          {ym}
                          {monthValid.length > 0 && (
                            <span className="ml-auto font-semibold">
                              {w
                                ? <>증빙 {fmt(w.evidenceAmount)} → 인정 <b className="text-gray-600">{fmt(w.approvedAmount)}원</b>{w.overLimitAmount > 0 && <span className="text-red-500"> · 초과 {fmt(w.overLimitAmount)}</span>}</>
                                : <>월 소계 <b className="text-gray-600">{fmt(itemized.appliedTotal)}원</b></>}
                            </span>
                          )}
                        </div>
                        {rows.map((it) => {
                          const gross = parseNum(it.amountGross)
                          const applied = card.vatMode === 'exclude_10' ? Math.round(gross / 1.1) : gross
                          return (
                            <div key={it.rid} className={`grid ${gridCols} items-center gap-2 border-t border-gray-50 px-4 py-1.5 text-xs hover:bg-gray-50/60`}>
                              <input type="date" value={it.date} min={periodStart} max={periodEnd}
                                onChange={(e) => patchItem(card.key, it.rid, { date: e.target.value })}
                                className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              <input type="text" value={it.vendor} placeholder="구매처"
                                onChange={(e) => patchItem(card.key, it.rid, { vendor: e.target.value })}
                                className="w-full rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              <input type="text" value={it.description} placeholder={def.label}
                                onChange={(e) => patchItem(card.key, it.rid, { description: e.target.value })}
                                className="w-full rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                              {isWelfare && (
                                <select value={it.tag} onChange={(e) => patchItem(card.key, it.rid, { tag: e.target.value })}
                                  className="rounded border border-gray-300 px-1 py-1 text-xs focus:outline-none">
                                  <option value="식대">식대</option>
                                  <option value="음료">음료</option>
                                  <option value="기타">기타</option>
                                </select>
                              )}
                              <input type="text" inputMode="numeric" value={it.amountGross} placeholder="0"
                                onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); patchItem(card.key, it.rid, { amountGross: r ? fmt(parseInt(r, 10)) : '' }) }}
                                className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                              <span className="text-right text-gray-600">{gross > 0 ? fmt(applied) : '—'}</span>
                              <span className="text-center">
                                {gross > 0 && (
                                  it.saved
                                    ? <span className="whitespace-nowrap rounded-full bg-green-50 px-2 py-0.5 text-[10.5px] font-semibold text-green-700">저장됨</span>
                                    : <span className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700">확인 필요</span>
                                )}
                              </span>
                              <button type="button" onClick={() => removeItem(card.key, it.rid)} aria-label="내역 삭제"
                                className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* 하단: 내역 추가 · 증빙 스트립 · 저장 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5">
              <button type="button" onClick={() => addItem(card.key)}
                className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600">
                + 내역 추가
              </button>
              <span className="text-xs font-semibold text-gray-500">증빙 {card.receiptUrls.length}</span>
              {card.receiptUrls.map((url) => (
                <span key={url} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs">
                  <a href={receiptHref(url)} target="_blank" rel="noreferrer" title={receiptFileName(url)}
                    className="max-w-[180px] truncate text-blue-600 hover:underline">
                    {receiptFileName(url)}
                  </a>
                  <button type="button" onClick={() => removeReceipt(card.key, url)} aria-label="첨부 제거"
                    className="text-gray-300 hover:text-red-500">✕</button>
                </span>
              ))}
              <input ref={(el) => { fileInputs.current[card.key] = el }} type="file" accept={ACCEPT} multiple className="hidden"
                onChange={(e) => { handleFiles(card.key, Array.from(e.target.files ?? [])); e.target.value = '' }} />
              <button type="button" onClick={() => fileInputs.current[card.key]?.click()} disabled={uploading.has(card.key)}
                className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-500 hover:border-blue-400 hover:text-blue-600 disabled:opacity-50">
                {uploading.has(card.key) ? '업로드 중…' : '+ 영수증 추가 (금액 자동 인식)'}
              </button>
              <div className="ml-auto flex items-center gap-2">
                {st === 'saved' && !dirty.has(card.key) && <span className="text-xs font-medium text-green-700">✓ 저장됨</span>}
                <button type="button" onClick={() => saveCard(card.key)} disabled={isPending || st === 'saving'}
                  className="rounded-lg border border-blue-500 px-3 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                  {st === 'saving' ? '저장 중…' : `${def.label} 저장`}
                </button>
              </div>
            </div>
            {n && (
              <p className={`border-t border-gray-100 px-4 py-1.5 text-xs ${n.kind === 'ok' ? 'text-green-700' : 'text-amber-600'}`}>
                {n.kind === 'ok' ? '✓ ' : '⚠ '}{n.text}
              </p>
            )}
          </>
        )}
      </article>
    )
  }

  const addedSubs = new Set(cards.map((c) => c.subcategory))

  return (
    <div className="space-y-4">
      {/* 컨텍스트 바 */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
        <span className="text-sm text-gray-500">기성회차</span>
        <span className="text-sm font-semibold text-gray-800">{roundLabel}</span>
        <span className="ml-auto rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
          이번 회차 현장경비 {fmt(grandTotal)}원
        </span>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {/* 총액 초과 경고 — 기성 확정 전에 알아야 증빙·계상 협의로 대응할 수 있다 */}
      {overTotalAmount > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          ⚠️ 직접경비 총액 잔액을 초과합니다 — 초과분 <b>{fmt(overTotalAmount)}원은 발주청에 청구할 수 없어
          미지급될 수 있습니다.</b> 저장은 가능하지만 기성 확정 전에 본사 정산 담당자와 확인하세요.
        </div>
      )}

      <div className="space-y-3">
        {cards.map((c) => renderCard(c))}
        {cards.length === 0 && (
          <p className="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-400">
            입력된 항목이 없습니다. 아래에서 항목을 추가하세요.
          </p>
        )}
      </div>

      {/* + 항목 추가 피커 — 기존 4단계 위저드 대체 */}
      <section className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-4">
        <p className="mb-2.5 text-sm font-semibold text-gray-600">+ 항목 추가 — 세부항목을 고르면 위에 카드가 생깁니다</p>
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {(Object.values(EXPENSE_CATEGORIES) as ExpenseCategory[]).map((cat) => (
            <button key={cat} type="button" onClick={() => setPickerCategory(cat)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                pickerCategory === cat ? CATEGORY_ACCENT[cat].chip + ' ring-1 ring-current' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}>
              {EXPENSE_CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {pickerSubs.map((s) => {
            const added = addedSubs.has(s.value)
            return (
              <button key={s.value} type="button" onClick={() => addCard(pickerCategory, s.value)} disabled={added}
                className="rounded-lg border border-gray-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-400 hover:bg-blue-50/50 disabled:opacity-45">
                <span className="block font-medium text-gray-700">{s.label}</span>
                <span className="mt-0.5 block text-[11px] text-gray-400">{added ? '이미 추가됨' : s.notes ?? (s.requireDocs[0] ?? '')}</span>
              </button>
            )
          })}
          {pickerSubs.length === 0 && (
            <p className="col-span-full text-xs text-gray-400">이 비목의 항목은 주재비·출장비 화면에서 입력합니다.</p>
          )}
        </div>
      </section>

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={() => router.push('/expenses')}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          입력 내역 목록으로
        </button>
        <button type="button" onClick={saveAll} disabled={isPending || dirty.size === 0}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending ? '저장 중...' : dirty.size > 0 ? `전체 임시저장 (${dirty.size}개 항목)` : '전체 임시저장'}
        </button>
      </div>

      {/* 우측 시트 — 항목 상세 */}
      {sheetCard && sheetDef && (
        <>
          <div className="fixed inset-0 z-40 bg-gray-900/40" onClick={() => setSheetKey(null)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label={`${sheetDef.label} 상세`}
            className="fixed inset-y-0 right-0 z-50 flex w-[min(430px,92vw)] flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">{sheetDef.label} — 항목 상세</h3>
                <p className="mt-0.5 text-xs text-gray-500">{roundLabel}</p>
              </div>
              <button type="button" onClick={() => setSheetKey(null)} aria-label="닫기"
                className="rounded-lg bg-gray-100 px-2.5 py-1 text-sm text-gray-500 hover:bg-gray-200">✕</button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {/* 필수 증빙 */}
              <div className="rounded-lg border border-gray-200 p-3.5">
                <p className="mb-2 text-xs font-semibold text-gray-500">필수 증빙</p>
                {sheetDef.requireDocs.length > 0 ? (
                  <ul className="space-y-1 text-sm text-gray-700">
                    {sheetDef.requireDocs.map((doc, i) => (
                      <li key={i} className="flex items-start gap-1.5"><span className="mt-0.5 text-gray-300">•</span>{doc}</li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-gray-400">별도 증빙 불필요</p>}
                {sheetDef.notes && <p className="mt-2 text-xs text-gray-500">{sheetDef.notes}</p>}
              </div>

              {/* 복리후생 산출 근거 */}
              {sheetDef.limitType === 'welfare' && (
                <div className="rounded-lg border border-gray-200 p-3.5 text-sm">
                  <p className="mb-2 text-xs font-semibold text-gray-500">인정금액 산출 (월별 min(인원×한도, 증빙))</p>
                  <div className="flex justify-between py-0.5"><span className="text-gray-500">상주인원</span><b>{parseInt(sheetCard.headcount, 10) || 1}명</b></div>
                  <div className="flex justify-between py-0.5"><span className="text-gray-500">1인 월한도</span><b>{fmt(welfareLimit)}원</b></div>
                  <div className="flex justify-between py-0.5"><span className="text-gray-500">월 산출금액</span><b>{fmt((parseInt(sheetCard.headcount, 10) || 1) * welfareLimit)}원</b></div>
                  <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                    {groupByMonth(sheetCard.items).map(([ym, rows]) => {
                      const items = rows.filter((r) => parseNum(r.amountGross) > 0).map((r) => ({ amountGross: parseNum(r.amountGross) }))
                      if (items.length === 0) return null
                      const itemized = calcItemized(items, sheetCard.vatMode, { applyPerItem: true })
                      const w = calcWelfare({ residentHeadcount: parseInt(sheetCard.headcount, 10) || 1, monthlyLimit: welfareLimit, evidenceAmount: itemized.appliedTotal })
                      return (
                        <div key={ym} className="flex justify-between text-xs">
                          <span className="text-gray-500">{ym}</span>
                          <span>증빙 {fmt(w.evidenceAmount)} → 인정 <b>{fmt(w.approvedAmount)}</b>{w.overLimitAmount > 0 && <span className="text-red-500"> (초과 {fmt(w.overLimitAmount)})</span>}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 계상 대비 */}
              <div className="rounded-lg border border-gray-200 p-3.5 text-sm">
                <p className="mb-2 text-xs font-semibold text-gray-500">계상 대비</p>
                {(() => {
                  const rem = categoryRemaining(sheetCard.category)
                  const totalRem = budget ? budget.totalBudget - budget.totalUsed : null
                  return (
                    <>
                      <div className="flex justify-between py-0.5">
                        <span className="text-gray-500">{EXPENSE_CATEGORY_LABELS[sheetCard.category]} 잔액</span>
                        {rem !== null
                          ? <b className={rem < 0 ? 'text-red-600' : ''}>{fmt(rem)}원</b>
                          : <span className="text-gray-400">계상 미입력</span>}
                      </div>
                      <div className="flex justify-between py-0.5">
                        <span className="text-gray-500">직접경비 총액 잔액</span>
                        {totalRem !== null && budget && budget.totalBudget > 0
                          ? <b className={totalRem < 0 ? 'text-red-600' : ''}>{fmt(totalRem)}원</b>
                          : <span className="text-gray-400">계상 미입력</span>}
                      </div>
                      <p className="mt-2 text-xs text-gray-400">
                        항목 초과는 직접경비 총액 내에서 흡수 가능하지만, 총액 잔액까지 초과한 금액은 발주청에 청구할 수 없습니다.
                      </p>
                    </>
                  )
                })()}
              </div>
            </div>
            <div className="border-t border-gray-200 px-5 py-3.5">
              <button type="button" onClick={() => { saveCard(sheetCard.key); setSheetKey(null) }}
                className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">
                {sheetDef.label} 저장
              </button>
            </div>
          </aside>
        </>
      )}
    </div>
  )
}
