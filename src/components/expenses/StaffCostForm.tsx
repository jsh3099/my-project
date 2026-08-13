'use client'

import { useState, useTransition, useRef, useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  createStaffCosts,
  attachStaffCostReceipt,
  detachStaffCostReceipt,
  saveStaffCostItem,
  reparseStaffCostReceipts,
  type StaffCostRow,
  type StaffCostCommuteCalc,
  type StaffCostItemTarget,
} from '@/actions/expenses'
import type { AttendanceRecord, SiteStaffMember, LodgingCalcDetail } from '@/types'
import { receiptFileName, receiptHref } from '@/lib/storage/receipts'
import { calcWorkDays } from '@/lib/korean-holidays'
import {
  SPECIALTIES,
  RESIDENCE_TYPES,
  RESIDENCE_TYPE_LABELS,
  RESIDENCE_TYPE_ICONS,
  RESIDENCE_TYPE_SHORT,
  residenceToCommuteMode,
  commuteModeToResidence,
  type CommuteMode,
  type ResidenceType,
  type VehicleFuelType,
} from '@/lib/constants'
import { applyVatExclusion, convertJeonseToMonthly } from '@/lib/settlement'
import { CommuteCalcPanel, type CommuteApplyParams } from './CommuteCalcPanel'
import { parseReceiptAmounts } from '@/actions/receiptParse'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  members: SiteStaffMember[]   // 현장 기술인 명부 — 정산 인원의 단일 원천 (출근부 화면에서 등록)
  attendance: AttendanceRecord[] // 회차 기준 집계 — work_days는 기성기간 출근일수 합계
  /** 이미 저장된 draft 주재비 — 금액·건별 내역·첨부 복원용 */
  existingDrafts?: StaffCostDraftItem[]
  /** 진행 중 회차의 기성기간 — 근무기간 기본값 */
  defaultPeriodStart?: string | null
  defaultPeriodEnd?: string | null
  mealDailyLimit?: number
  applyCommuteRegulation?: boolean
  commuteTripsDefault?: number
  siteAddress?: string | null
  myUserId?: string
  myHomeAddress?: string | null
  myFuelType?: string | null
  /** 현장주재비 비목의 계상 잔액 (계상 미입력이면 null) — 삭감 위험 사전 인지용 */
  categoryRemaining?: number | null
}

const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

function parseNum(v: string) { return parseInt(v.replace(/,/g, ''), 10) || 0 }
function fmt(n: number) { return n > 0 ? n.toLocaleString('ko-KR') : '-' }

function NumInput({ value, onChange, disabled, readOnly }: { value: string; onChange?: (v: string) => void; disabled?: boolean; readOnly?: boolean }) {
  return (
    <div className="relative">
      <input type="text" inputMode="numeric" value={value} disabled={disabled} readOnly={readOnly}
        onChange={(e) => { if (!onChange) return; const r = e.target.value.replace(/[^0-9]/g, ''); onChange(r ? parseInt(r).toLocaleString('ko-KR') : '') }}
        className={`w-full rounded border border-gray-300 px-2 py-1.5 pr-6 text-right text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-400 ${readOnly ? 'bg-gray-50 text-gray-500' : ''}`} />
      <span className="absolute right-1.5 top-1.5 text-xs text-gray-400">원</span>
    </div>
  )
}

// 정산서가 실제로 쓰는 첨부만 받는다.
//  숙소임대비·관리비 → 1-1 붙임(숙소계약서·이체확인증·관리비 사용내역)
//  교통비 경로캡처   → 1-3 교통비 산출서에 임베드되는 지도 캡처 이미지(collectCalcSheetImages).
//                     유가·거리·통행료는 시스템이 계산하므로 영수증이 아니라 캡처가 온다.
// 식대는 출근부 일수 × 단가 자동 계산이고 1-2의 붙임은 '출근부 1부'뿐이라, 식비 영수증은
// 정산서 어디에도 쓰이지 않는다 — 칸을 두면 쓰이지 않을 증빙을 모으게 되어 뺐다.
const RECEIPT_CATEGORIES = ['숙소임대비', '관리비', '교통비 경로캡처'] as const
type ReceiptCategory = typeof RECEIPT_CATEGORIES[number]
const CATEGORY_COLORS: Record<ReceiptCategory, string> = {
  '숙소임대비':      'bg-purple-100 text-purple-700',
  '관리비':          'bg-orange-100 text-orange-700',
  '교통비 경로캡처': 'bg-blue-100 text-blue-700',
}
// 칩 아래 한 줄 설명 — 무엇을 붙이는 자리인지 이름만으로는 안 보인다
const CATEGORY_HINTS: Record<ReceiptCategory, string> = {
  '숙소임대비':      '이체확인증·숙소계약서 (PDF는 금액 자동 인식)',
  '관리비':          '전기·가스 납입확인서 (PDF는 건별 자동 인식)',
  '교통비 경로캡처': '지도 경로 캡처 이미지 — 교통비 산출서에 실립니다',
}

// 파일명에서 비목 자동 인식 (일괄 업로드 자동 분류) — 관리비 키워드를 먼저 본다
// ("관리비_납입확인서"가 이체·숙소 키워드와 겹치지 않도록)
function detectCategory(filename: string): ReceiptCategory | null {
  if (/관리비|전기|가스|납입확인/.test(filename)) return '관리비'
  if (/숙소|임대|월세|이체확인/.test(filename)) return '숙소임대비'
  if (/경로|지도|캡처|통행료|하이패스|교통/.test(filename)) return '교통비 경로캡처'
  return null
}
// 영수증 비목 라벨 → expenses.subcategory 값 매핑 (서버 액션에 전달할 때 사용)
const CATEGORY_TO_SUBCATEGORY: Record<ReceiptCategory, string> = {
  '숙소임대비':      'lodging_rent',
  '관리비':          'lodging_maintenance',
  '교통비 경로캡처': 'commute',
}
// 자가 출퇴근자는 숙소비 비대상 — 서버(attachStaffCostReceipt)도 같은 기준으로 막는다
const LODGING_CATEGORIES: ReceiptCategory[] = ['숙소임대비', '관리비']

// 이미 저장된 draft 주재비 — 서버에서 복원해 폼 초기값으로 쓴다
export type StaffCostDraftItem = {
  identity: string              // target_user_name (명부 인원은 계정이 없어 이름으로 식별)
  subcategory: string           // lodging_rent | lodging_maintenance | meal | commute
  amount: number
  periodStart: string | null
  periodEnd: string | null
  receiptUrls: string[]
  calcDetail: LodgingCalcDetail | null
  maintItems: { date: string; tag: string; amountGross: number }[]
  commute: {
    mode: CommuteMode
    homeAddress: string | null
    distanceOnewayKm: number
    fuelType: VehicleFuelType
    fuelEfficiency: number
    fuelPrice: number
    fuelPriceDate: string | null
    tollRoundtrip: number
    multiplier: number
  } | null
}

// 비목별 저장된 첨부 URL: savedReceipts[rowId][subcategory] = url[]
type SavedReceipts = Record<string, Record<string, string[]>>

type MaintItem = { date: string; tag: string; amountGross: string }

type Row = {
  periodStart: string
  periodEnd: string
  workDays: string
  specialty: string
  // 숙소임대비: 월세 직접 입력 or 전세 환산 (보증금 × 전환율% ÷ 12)
  lodgingContract: 'monthly' | 'jeonse'
  lodgingRent: string
  deposit: string
  conversionRate: string
  // 관리비: 건별 내역 (입금일자·전기/가스·금액) — 합계에서 VAT 제외한 적용금액만 인정
  maintItems: MaintItem[]
  // 교통비: 1회 왕복비 × (숙박형: 주말 왕복 횟수 / 출퇴근형: 근무일수)
  commuteMode: CommuteMode
  commuteRoundtrip: string
  commuteTrips: string
  commuteCalc: StaffCostCommuteCalc | null
}
type ExtraRow = Row & { id: string; name: string }

function makeDefaultRow(
  yearMonth: string,
  specialty: string,
  tripsDefault: number,
  periodStart?: string | null,
  periodEnd?: string | null,
  // 거주 형태(명부 기본값)가 교통비 유형의 초기값을 정한다
  residenceType: ResidenceType = RESIDENCE_TYPES.LODGING,
): Row {
  return {
    periodStart: periodStart ?? `${yearMonth}-01`, periodEnd: periodEnd ?? '', workDays: '0', specialty,
    lodgingContract: 'monthly', lodgingRent: '', deposit: '', conversionRate: '5.5',
    maintItems: [],
    commuteMode: residenceToCommuteMode(residenceType), commuteRoundtrip: '', commuteTrips: String(tripsDefault), commuteCalc: null,
  }
}

// 자가 출퇴근자는 숙소임대비·관리비를 계상하지 않는다 (예본 「1-1 숙소비 사용내역」 비대상)
const isCommuter = (r: Row) => r.commuteMode === 'daily_commute'

// 행별 파생값 계산 (미리보기용 — 저장 시 서버가 동일 규칙으로 재계산)
function deriveRow(r: Row, mealDailyLimit: number) {
  const wd = parseInt(r.workDays) || 0
  const meal = wd * mealDailyLimit
  const rentInput = r.lodgingContract === 'jeonse'
    ? convertJeonseToMonthly(parseNum(r.deposit), parseFloat(r.conversionRate) || 0)
    : parseNum(r.lodgingRent)
  const maintInput = r.maintItems.reduce((s, i) => s + parseNum(i.amountGross), 0)
  // 자가 출퇴근자는 입력값이 남아 있어도 계상하지 않는다 (서버도 같은 규칙으로 0 처리)
  const lodgingRent = isCommuter(r) ? 0 : rentInput
  const maintGross = isCommuter(r) ? 0 : maintInput
  const maintApplied = maintGross > 0 ? applyVatExclusion(maintGross) : 0
  // 출퇴근형인데 숙소비 입력이 남아 있으면 알려준다 (저장 시 정리됨)
  const staleLodging = isCommuter(r) ? rentInput + maintInput : 0
  const multiplier = r.commuteMode === 'daily_commute' ? wd : (parseInt(r.commuteTrips) || 0)
  const commuteTotal = parseNum(r.commuteRoundtrip) * multiplier
  return { wd, meal, lodgingRent, maintGross, maintApplied, multiplier, commuteTotal, staleLodging, subtotal: meal + lodgingRent + maintApplied + commuteTotal }
}

let extraIdSeq = 0

// ── 영수증 패널 ─────────────────────────────────────────────
// 첨부는 드롭하는 즉시 업로드된다 (금액은 확인 후 별도 저장) — 스캔 파일을 다시 구하는 비용이
// 크고, 브라우저 메모리에만 두면 새로고침 한 번에 사라지기 때문.
function ReceiptPanel({ savedByCategory, onAdd, onRemoveSaved, uploading, maxFiles, notice, onDone, maintPendingCount, rentPendingAmount, saving, onReparse, reparsing, disabledCategories, disabledReason }: {
  savedByCategory: Record<string, string[]>
  onAdd: (files: File[], category: ReceiptCategory) => void
  onRemoveSaved: (category: ReceiptCategory, url: string) => void
  uploading: boolean
  maxFiles: number
  notice?: { kind: 'ok' | 'warn'; text: string } | null
  /** 확인을 마치고 주재비 화면으로 — 인식된 관리비 건별 내역이 있으면 함께 저장한다 */
  onDone: () => void
  /** 자동 인식으로 표에 채워진 관리비 건수 (0이면 저장할 것이 없어 닫기만 한다) */
  maintPendingCount: number
  /** 인식·입력된 숙소임대비 금액 — 0보다 크면 완료 버튼이 함께 저장한다 */
  rentPendingAmount: number
  saving: boolean
  /** 이미 저장된 PDF 첨부를 다시 읽어 금액을 채운다 */
  onReparse: () => void
  reparsing: boolean
  /** 이 사람에게 해당 없는 비목 (자가 출퇴근자의 숙소임대비·관리비) */
  disabledCategories: ReceiptCategory[]
  disabledReason: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const enabled = RECEIPT_CATEGORIES.filter((c) => !disabledCategories.includes(c))
  // 해당 없는 비목이 처음부터 선택돼 있으면 붙일 수 없는 곳에 끌어다 놓게 된다
  const [selectedCategory, setSelectedCategory] = useState<ReceiptCategory>(enabled[0] ?? RECEIPT_CATEGORIES[0])

  // 저장된 첨부를 비목별로 펼쳐 화면 표시용 목록으로 만든다
  const saved = RECEIPT_CATEGORIES.flatMap((cat) =>
    (savedByCategory[CATEGORY_TO_SUBCATEGORY[cat]] ?? []).map((url) => ({ cat, url })),
  )

  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const room = maxFiles - saved.length
    const valid: { file: File; category: ReceiptCategory }[] = []
    for (const f of Array.from(incoming)) {
      if (valid.length >= room) break
      if (f.size > MAX_SIZE) { alert(`${f.name}: 파일 크기는 10MB 이하만 가능합니다.`); continue }
      // 파일명에서 비목이 읽히면 그것을, 아니면 위에서 선택한 비목을 쓴다.
      // 이 사람에게 해당 없는 비목으로 읽혔으면 무시하고 선택한 비목에 붙인다
      const detected = detectCategory(f.name)
      const category = detected && !disabledCategories.includes(detected) ? detected : selectedCategory
      valid.push({ file: f, category })
    }
    // 비목별로 묶어 한 번씩 업로드
    for (const cat of RECEIPT_CATEGORIES) {
      const group = valid.filter((v) => v.category === cat).map((v) => v.file)
      if (group.length) onAdd(group, cat)
    }
  }

  return (
    <div className="border-t border-blue-100 bg-blue-50/40 px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-600 whitespace-nowrap">비목 선택</span>
        <div className="flex flex-wrap gap-1.5">
          {RECEIPT_CATEGORIES.map((cat) => {
            const off = disabledCategories.includes(cat)
            return (
              <button
                key={cat}
                type="button"
                disabled={off}
                title={off ? disabledReason : CATEGORY_HINTS[cat]}
                onClick={() => setSelectedCategory(cat)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                  off
                    ? 'cursor-not-allowed border border-gray-200 bg-gray-100 text-gray-300 line-through'
                    : selectedCategory === cat
                      ? CATEGORY_COLORS[cat] + ' ring-2 ring-offset-1 ring-current'
                      : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-400'
                }`}
              >
                {cat}
              </button>
            )
          })}
        </div>
      </div>

      {/* 이름만으로는 무엇을 붙이는 자리인지 안 보인다 — 선택한 비목의 설명을 한 줄로 */}
      <p className="text-xs text-gray-500">
        {disabledCategories.length > 0 && (
          <span className="mr-1 font-semibold text-amber-700">{disabledReason} —</span>
        )}
        {CATEGORY_HINTS[selectedCategory]}
      </p>

      {saved.length < maxFiles && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
          onClick={() => inputRef.current?.click()}
          className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed py-2.5 text-xs transition-colors ${
            dragging ? 'border-blue-400 bg-blue-100 text-blue-600' : 'border-gray-300 text-gray-400 hover:border-blue-400 hover:text-blue-500'
          }`}
        >
          📎 <span><span className={`font-semibold ${CATEGORY_COLORS[selectedCategory].split(' ')[1]}`}>{selectedCategory}</span> 영수증 선택 또는 끌어다 놓기</span>
          <input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        </div>
      )}

      {uploading && <p className="text-xs text-blue-600">⏳ 업로드 중...</p>}

      {saved.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {saved.map(({ cat, url }) => (
            <div key={url} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 shadow-sm">
              <div className="flex h-8 w-8 items-center justify-center rounded bg-green-50 text-xs font-bold text-green-600">저장</div>
              <a href={receiptHref(url)} target="_blank" rel="noreferrer" title={receiptFileName(url)}
                className="max-w-[130px] truncate text-xs font-medium text-blue-600 hover:underline">
                {receiptFileName(url)}
              </a>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[cat]}`}>{cat}</span>
              <button type="button" onClick={() => onRemoveSaved(cat, url)}
                className="rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <p className={`text-xs ${notice.kind === 'ok' ? 'text-green-700' : 'text-amber-600'}`}>
          {notice.kind === 'ok' ? '✓ ' : '⚠ '}
          {notice.text}
        </p>
      )}
      <p className="text-xs text-gray-400">첨부는 올리는 즉시 저장됩니다 · 최대 {maxFiles}개 · JPG·PNG·PDF · 10MB 이하 · 파일명에 항목(숙소비·관리비 등)이 있으면 자동 분류 · 이체확인증·관리비 PDF는 금액 자동 인식</p>

      {/* 첨부만 하고 이 패널을 닫는 방법이 우측 상단 ✕뿐이라 "다음에 뭘 해야 하나"가 끊겼다.
          인식된 금액(숙소임대비·관리비)은 여기서 바로 확정하고 주재비 화면으로 돌려보낸다.
          [전체 임시저장]까지 미루면 그 사이 화면을 벗어났을 때 0원으로 되돌아간 채 저장된다. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-blue-100 pt-2.5">
        {/* 자동 인식은 업로드 직후 한 번만 돌아간다 — 저장 전에 화면을 벗어나면 첨부만 남고
            금액이 사라져서, 첨부를 지웠다 다시 올리는 것 말고는 되살릴 방법이 없었다 */}
        {saved.some(({ url }) => url.split('#')[0].toLowerCase().endsWith('.pdf')) && (
          <button type="button" onClick={onReparse} disabled={uploading || reparsing || saving}
            title="이미 첨부된 PDF를 다시 읽어 숙소임대비·관리비 금액을 채웁니다"
            className="whitespace-nowrap rounded-lg border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-50">
            {reparsing ? '인식 중…' : '🔍 금액 재인식'}
          </button>
        )}
        {(maintPendingCount > 0 || rentPendingAmount > 0) && (
          <span className="text-xs text-gray-500">
            {[
              rentPendingAmount > 0 ? `숙소임대비 ${rentPendingAmount.toLocaleString('ko-KR')}원` : null,
              maintPendingCount > 0 ? `관리비 ${maintPendingCount}건` : null,
            ].filter(Boolean).join(' · ')}이 채워졌습니다
          </span>
        )}
        <button type="button" onClick={onDone} disabled={uploading || saving}
          className="ml-auto whitespace-nowrap rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {saving
            ? '저장 중...'
            : maintPendingCount > 0 || rentPendingAmount > 0
              ? '금액 저장하고 주재비 화면으로'
              : '주재비 화면으로 돌아가기'}
        </button>
      </div>
    </div>
  )
}

// ── 관리비 건별 내역 패널 (정산서 1-1 관리비 사용내역 — 합계에서 VAT 제외) ──
// 비목 단위 저장 버튼 — 자동 인식값을 확인한 뒤 이 비목만 확정한다
function ItemSaveButton({ label, onSave, saveState, tone }: {
  label: string
  onSave: () => void
  saveState?: 'saving' | 'saved'
  tone: 'orange' | 'purple'
}) {
  const colors = tone === 'orange'
    ? 'bg-orange-600 hover:bg-orange-700'
    : 'bg-purple-600 hover:bg-purple-700'
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onSave} disabled={saveState === 'saving'}
        className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${colors}`}>
        {saveState === 'saving' ? '저장 중...' : label}
      </button>
      {saveState === 'saved' && <span className="text-xs font-medium text-green-700">✓ 저장됨</span>}
    </div>
  )
}

function MaintenancePanel({ items, onChange, onSave, saveState }: {
  items: MaintItem[]
  onChange: (items: MaintItem[]) => void
  onSave: () => void
  saveState?: 'saving' | 'saved'
}) {
  const gross = items.reduce((s, i) => s + parseNum(i.amountGross), 0)
  const applied = gross > 0 ? applyVatExclusion(gross) : 0

  function upd(idx: number, field: keyof MaintItem, val: string) {
    onChange(items.map((it, i) => i === idx ? { ...it, [field]: val } : it))
  }

  return (
    <div className="border-t border-orange-100 bg-orange-50/40 px-4 py-3 space-y-2 text-sm">
      <p className="text-xs font-semibold text-gray-600">🧾 관리비(전기세·가스비) 건별 내역 — 합계에서 부가세를 제외한 적용금액만 인정됩니다</p>
      {items.length > 0 && (
        <table className="w-full max-w-xl text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="py-1 text-left">입금일자</th>
              <th className="py-1 text-left">구분</th>
              <th className="py-1 text-right">금액 (VAT 포함)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx}>
                <td className="py-1 pr-2">
                  <input type="date" value={it.date} onChange={(e) => upd(idx, 'date', e.target.value)}
                    className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
                </td>
                <td className="py-1 pr-2">
                  <select value={it.tag} onChange={(e) => upd(idx, 'tag', e.target.value)}
                    className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none">
                    <option value="전기">전기세</option>
                    <option value="가스">가스비</option>
                    <option value="기타">기타</option>
                  </select>
                </td>
                <td className="py-1 pr-2 w-32">
                  <input type="text" inputMode="numeric" value={it.amountGross}
                    onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); upd(idx, 'amountGross', r ? parseInt(r).toLocaleString('ko-KR') : '') }}
                    className="w-full rounded border border-gray-300 px-1.5 py-1 text-right text-xs focus:border-blue-500 focus:outline-none" />
                </td>
                <td className="py-1">
                  <button type="button" onClick={() => onChange(items.filter((_, i) => i !== idx))}
                    className="rounded p-0.5 text-gray-300 hover:text-red-500">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => onChange([...items, { date: '', tag: '전기', amountGross: '' }])}
          className="rounded border border-dashed border-orange-300 px-2.5 py-1 text-xs text-orange-600 hover:bg-orange-100">
          + 내역 추가
        </button>
        {gross > 0 && (
          <span className="text-xs text-gray-600">
            합계 <b>{gross.toLocaleString()}원</b> → 적용금액(VAT제외) <b className="text-orange-700">{applied.toLocaleString()}원</b>
          </span>
        )}
        <div className="ml-auto">
          <ItemSaveButton label="관리비 저장" onSave={onSave} saveState={saveState} tone="orange" />
        </div>
      </div>
    </div>
  )
}

// ── 숙소임대비 패널 (월세 / 전세 환산) ──────────────────────────
// 저장 버튼을 두지 않는다: 월세일 때 금액은 이 패널이 아니라 표의 칸에 있어서
// "숙소임대비 저장"이 화면에 보이지도 않는 값을 저장하는 버튼이 됐다
// (금액 0원인 채로 눌러 0원짜리 항목이 만들어지는 것도 막히지 않았다).
// 선택은 표에 즉시 반영되고, 확정은 하단 [전체 임시저장] 한 곳에서만 한다.
function LodgingPanel({ r, onChange }: {
  r: Row
  onChange: (patch: Partial<Row>) => void
}) {
  const converted = convertJeonseToMonthly(parseNum(r.deposit), parseFloat(r.conversionRate) || 0)
  return (
    <div className="border-t border-purple-100 bg-purple-50/40 px-4 py-3 space-y-2 text-sm">
      <div className="flex items-center gap-3">
        <p className="text-xs font-semibold text-gray-600">🏠 숙소 계약 형태</p>
        <div className="flex gap-1">
          {(['monthly', 'jeonse'] as const).map((ct) => (
            <button key={ct} type="button" onClick={() => onChange({ lodgingContract: ct })}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${r.lodgingContract === ct ? 'bg-purple-100 text-purple-700 ring-2 ring-offset-1 ring-current' : 'bg-white text-gray-500 border border-gray-200'}`}>
              {ct === 'monthly' ? '월세' : '전세 (환산)'}
            </button>
          ))}
        </div>
      </div>
      {r.lodgingContract === 'jeonse' && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-0.5 block text-xs text-gray-500">전세보증금</label>
            <input type="text" inputMode="numeric" value={r.deposit}
              onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ''); onChange({ deposit: v ? parseInt(v).toLocaleString('ko-KR') : '' }) }}
              placeholder="예: 50,000,000"
              className="w-40 rounded border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <div>
            <label className="mb-0.5 block text-xs text-gray-500">전월세 전환율 (연 %)</label>
            <input type="text" inputMode="decimal" value={r.conversionRate}
              onChange={(e) => onChange({ conversionRate: e.target.value.replace(/[^0-9.]/g, '') })}
              className="w-20 rounded border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none" />
          </div>
          <p className="pb-1.5 text-xs text-gray-600">
            환산 월세 = 보증금 × 전환율 ÷ 12 = <b className="text-purple-700">{converted.toLocaleString()}원</b>
          </p>
        </div>
      )}
      {r.lodgingContract === 'monthly' && (
        // 이 패널에 첨부 버튼이 없어 "첨부할 곳이 없다"고 읽혔다 — 어디서 붙이는지 여기서 알려준다
        <p className="text-xs text-gray-500">
          월세 금액을 표의 숙소임대비 칸에 직접 입력하세요. 이체확인증(PDF)을 행 아래
          <b className="text-amber-700"> 📎 영수증 첨부</b>로 올리면 기성기간 이체금액을 합산해 자동으로 채웁니다.
        </p>
      )}
      <p className="border-t border-purple-100 pt-2 text-[11px] text-gray-400">
        선택은 표에 바로 반영됩니다 — 저장은 화면 맨 아래 <b className="text-gray-500">[전체 임시저장]</b>에서 한 번에 합니다.
      </p>
    </div>
  )
}

// 표에 뜨는 기본 인원: 명부 인원(key=m_{memberId})
type BasePerson = { key: string; name: string; defaultSpecialty: string | null; residenceType: ResidenceType }

export function StaffCostForm({ siteId, siteName, yearMonth, members, attendance, existingDrafts = [], defaultPeriodStart, defaultPeriodEnd, mealDailyLimit = 25000, applyCommuteRegulation = true, commuteTripsDefault = 4, siteAddress, myUserId, myHomeAddress, myFuelType, categoryRemaining = null }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 출근부 일수 — 명부 인원 member_id 기준
  const attendanceMap = Object.fromEntries(
    attendance.map((a) => [a.user_id ?? `m_${a.member_id}`, a.work_days]),
  )

  const basePersons: BasePerson[] = members.map((m) => ({
    key: `m_${m.id}`, name: m.name, defaultSpecialty: m.specialty,
    residenceType: m.residence_type ?? RESIDENCE_TYPES.LODGING,
  }))

  // 명부 자택주소 — 출근부 화면에서 거주지 증빙으로 채운 값이 자차 산출 출발지로 자동 매핑된다
  const memberHomeAddress: Record<string, string | undefined> = Object.fromEntries(
    members.map((m) => [`m_${m.id}`, m.home_address ?? undefined]),
  )

  // 기성기간 개월수 — 첨부 한도·주말 왕복 기본 횟수의 기준
  const periodMonths =
    defaultPeriodStart && defaultPeriodEnd
      ? Math.max(
          1,
          (parseInt(defaultPeriodEnd.slice(0, 4), 10) * 12 + parseInt(defaultPeriodEnd.slice(5, 7), 10)) -
            (parseInt(defaultPeriodStart.slice(0, 4), 10) * 12 + parseInt(defaultPeriodStart.slice(5, 7), 10)) +
            1,
        )
      : 1
  // 숙박형 주말 왕복은 기성기간 전체 횟수로 입력한다 (월 4회 원칙 × 개월수).
  // 회차가 5개월이면 20회 — 월 단위로 받으면 회차 전체 금액이 개월수만큼 모자란다.
  const roundTripsDefault = commuteTripsDefault * periodMonths
  // 상한은 기성기간에 비례해 열어둔다 (주 1회+여유 = 월 8회분)
  const maxRoundTrips = Math.max(10, periodMonths * 8)

  // 저장된 draft를 이름 기준으로 묶어둔다 (명부 인원은 계정이 없어 이름이 식별자)
  const draftsByName = new Map<string, Map<string, StaffCostDraftItem>>()
  for (const d of existingDrafts) {
    if (!draftsByName.has(d.identity)) draftsByName.set(d.identity, new Map())
    draftsByName.get(d.identity)!.set(d.subcategory, d)
  }

  // 저장된 draft 값을 기본 행에 덮어씌운다 — 없는 비목은 기본값 유지
  function seedRow(base: Row, name: string): Row {
    const saved = draftsByName.get(name)
    if (!saved) return base
    const lodging = saved.get('lodging_rent')
    const maint = saved.get('lodging_maintenance')
    const commute = saved.get('commute')
    const jeonse = lodging?.calcDetail?.contractType === 'jeonse' ? lodging.calcDetail : null
    const period = lodging ?? maint ?? commute
    return {
      ...base,
      periodStart: period?.periodStart ?? base.periodStart,
      periodEnd: period?.periodEnd ?? base.periodEnd,
      lodgingContract: jeonse ? 'jeonse' : 'monthly',
      deposit: jeonse ? (jeonse.deposit ?? 0).toLocaleString('ko-KR') : base.deposit,
      conversionRate: jeonse ? String(jeonse.conversionRatePct ?? '') : base.conversionRate,
      lodgingRent: lodging && !jeonse ? lodging.amount.toLocaleString('ko-KR') : base.lodgingRent,
      maintItems: maint
        ? maint.maintItems.map((i) => ({ date: i.date, tag: i.tag, amountGross: i.amountGross.toLocaleString('ko-KR') }))
        : base.maintItems,
      commuteMode: commute?.commute?.mode ?? base.commuteMode,
      commuteTrips: commute?.commute ? String(commute.commute.multiplier) : base.commuteTrips,
      commuteRoundtrip: commute && commute.commute
        ? Math.round(commute.amount / Math.max(1, commute.commute.multiplier)).toLocaleString('ko-KR')
        : base.commuteRoundtrip,
      commuteCalc: commute?.commute
        ? {
            homeAddress: commute.commute.homeAddress ?? '',
            distanceOnewayKm: commute.commute.distanceOnewayKm,
            fuelType: commute.commute.fuelType,
            fuelEfficiency: commute.commute.fuelEfficiency,
            fuelPrice: commute.commute.fuelPrice,
            fuelPriceDate: commute.commute.fuelPriceDate,
            tollRoundtrip: commute.commute.tollRoundtrip,
          }
        : base.commuteCalc,
    }
  }

  const [rows, setRows] = useState<Record<string, Row>>(
    Object.fromEntries(basePersons.map((p, i) => [p.key, seedRow({
      ...makeDefaultRow(
        yearMonth,
        p.defaultSpecialty && (SPECIALTIES as readonly string[]).includes(p.defaultSpecialty)
          ? p.defaultSpecialty
          : SPECIALTIES[i % SPECIALTIES.length],
        roundTripsDefault,
        defaultPeriodStart,
        defaultPeriodEnd,
        p.residenceType,
      ),
      workDays: String(attendanceMap[p.key] ?? 0),
    }, p.name)]))
  )

  // 비목별로 이미 저장된 첨부 URL
  const [savedReceipts, setSavedReceipts] = useState<SavedReceipts>(() => {
    const out: SavedReceipts = {}
    for (const p of basePersons) {
      const saved = draftsByName.get(p.name)
      if (!saved) continue
      const bySub: Record<string, string[]> = {}
      for (const [sub, d] of saved) if (d.receiptUrls.length) bySub[sub] = d.receiptUrls
      if (Object.keys(bySub).length) out[p.key] = bySub
    }
    return out
  })

  const [extraRows, setExtraRows] = useState<ExtraRow[]>([])
  const [names, setNames] = useState<Record<string, string>>(
    Object.fromEntries(basePersons.map((p) => [p.key, p.name]))
  )
  // 현장 인원 변동이 잦아, 기본 인원도 이번 달 입력에서 제외할 수 있어야 함
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set())
  const activePersons = basePersons.filter((p) => !removedKeys.has(p.key))

  function removePersonRow(key: string) {
    setRemovedKeys((p) => new Set(p).add(key))
  }

  // 인원당 첨부 한도 — 기성기간 개월수에 비례 (개월수 × 4 + 여유, 최소 30)
  const maxFiles = Math.max(30, periodMonths * 4 + 10)
  // 상세 패널(영수증/관리비 내역/숙소 계약/자차 산출)은 우측 시트 하나로 연다 —
  // 표 안에 끼워넣던 이전 구조의 잘림 문제를 구조적으로 없앤다
  type SheetPanel = 'receipt' | 'maint' | 'lodging' | 'commute'
  const [sheet, setSheet] = useState<{ id: string; isExtra: boolean; panel: SheetPanel } | null>(null)
  useEffect(() => {
    if (!sheet) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet])

  // 산출값 적용 안내 — 시트가 닫힌 뒤 어느 카드에 무엇이 반영됐는지 알려준다 (몇 초 후 사라짐)
  const [applyNotice, setApplyNotice] = useState<{ id: string; text: string } | null>(null)
  useEffect(() => {
    if (!applyNotice) return
    const t = setTimeout(() => setApplyNotice(null), 6000)
    return () => clearTimeout(t)
  }, [applyNotice])

  // 카드 접기 상태 (기본 펼침 — 인원이 많으면 접어서 훑는다)
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(new Set())
  function toggleCard(id: string) {
    setCollapsedCards((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  // 비목별 상태 칩용 추적 — 서버에 저장된 값(seeded)과 이후 수정 여부(dirty)를 구분한다.
  // 저장됨(초록) = 서버와 일치 / 확인 필요(호박) = 입력·인식됐지만 아직 미저장
  const [seededSaved] = useState<Set<string>>(() => {
    const s = new Set<string>()
    for (const p of basePersons) {
      const saved = draftsByName.get(p.name)
      if (!saved) continue
      for (const sub of ['lodging_rent', 'lodging_maintenance', 'commute'] as const) {
        if ((saved.get(sub)?.amount ?? 0) > 0) s.add(`${p.key}::${sub}`)
      }
    }
    return s
  })
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const FIELD_TO_SUB: Record<string, string> = {
    lodgingContract: 'lodging_rent', lodgingRent: 'lodging_rent', deposit: 'lodging_rent', conversionRate: 'lodging_rent',
    maintItems: 'lodging_maintenance',
    commuteMode: 'commute', commuteRoundtrip: 'commute', commuteTrips: 'commute', commuteCalc: 'commute',
  }

  // 행별 영수증 자동 인식 결과 안내 (저장 버튼과 분리된 트랜지션)
  const [receiptNotice, setReceiptNotice] = useState<Record<string, { kind: 'ok' | 'warn'; text: string } | null>>({})
  const [, startReceiptTransition] = useTransition()

  // 업로드 진행 중인 행
  const [uploadingRows, setUploadingRows] = useState<Set<string>>(new Set())
  // 저장된 첨부를 다시 읽는 중인 행
  const [reparsingRows, setReparsingRows] = useState<Set<string>>(new Set())
  // 비목 단위 저장 상태: `${rowId}::${subcategory}` → 'saving' | 'saved'
  const [itemSaveState, setItemSaveState] = useState<Record<string, 'saving' | 'saved'>>({})

  // 저장 액션에 넘길 대상 식별자 — createStaffCosts와 같은 키(이름·비목·기간)를 만든다
  function itemTarget(id: string, isExtra: boolean, subcategory: StaffCostItemTarget['subcategory']): StaffCostItemTarget | null {
    const r = getRow(id, isExtra)
    if (!r) return null
    const userName = isExtra ? (extraRows.find((e) => e.id === id)?.name ?? '') : (names[id] ?? '')
    if (!userName.trim()) return null
    return {
      siteId,
      yearMonth,
      userId: '',
      userName,
      specialty: spLabels[id] ?? r.specialty,
      periodStart: r.periodStart || null,
      periodEnd: r.periodEnd || null,
      subcategory,
      commuteMode: r.commuteMode,
    }
  }

  // (A) 첨부 즉시 업로드 — 업로드 성공 후 같은 파일로 금액 자동 인식을 돌린다
  function uploadRowReceipts(id: string, files: File[], category: ReceiptCategory) {
    const isExtra = id.startsWith('extra_')
    const subcategory = CATEGORY_TO_SUBCATEGORY[category] as StaffCostItemTarget['subcategory']
    const target = itemTarget(id, isExtra, subcategory)
    if (!target) {
      setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: '성명을 먼저 입력하세요.' } }))
      return
    }
    const fd = new FormData()
    fd.append('target', JSON.stringify(target))
    for (const f of files) fd.append('files', f)

    setUploadingRows((p) => new Set(p).add(id))
    startReceiptTransition(async () => {
      const res = await attachStaffCostReceipt(fd)
      setUploadingRows((p) => { const n = new Set(p); n.delete(id); return n })
      if ('error' in res) {
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: res.error ?? '저장 실패' } }))
        return
      }
      setSavedReceipts((p) => ({ ...p, [id]: { ...(p[id] ?? {}), [subcategory]: res.urls } }))
      const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
      if (pdfs.length > 0) autoFillFromReceipts(id, pdfs)
      else setReceiptNotice((p) => ({ ...p, [id]: { kind: 'ok', text: `${category} 영수증 ${files.length}장 저장됨.` } }))
    })
  }

  function removeSavedReceipt(id: string, category: ReceiptCategory, url: string) {
    const isExtra = id.startsWith('extra_')
    const subcategory = CATEGORY_TO_SUBCATEGORY[category] as StaffCostItemTarget['subcategory']
    const target = itemTarget(id, isExtra, subcategory)
    if (!target) return
    const fd = new FormData()
    fd.append('target', JSON.stringify(target))
    fd.append('url', url)
    startReceiptTransition(async () => {
      const res = await detachStaffCostReceipt(fd)
      if ('error' in res) {
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: res.error ?? '저장 실패' } }))
        return
      }
      setSavedReceipts((p) => ({ ...p, [id]: { ...(p[id] ?? {}), [subcategory]: res.urls } }))
    })
  }

  // (C) 비목 1건 저장 — 자동 인식값을 확인한 뒤 그 비목만 확정한다.
  // 숙소임대비 인식값은 폼에만 있어서, [전체 임시저장]까지 가기 전에 화면을 벗어나면
  // 0원으로 되돌아간 상태로 저장되는 사고가 실제로 났다(2026-08-13, 성혁기 0원 확정).
  // 그래서 영수증 패널의 완료 버튼이 인식된 금액(임대비·관리비)을 그 자리에서 저장한다.
  // 단, 임대비 0원은 저장하지 않는다 — 유령 행 방지(계약형태 패널의 옛 저장 버튼이 낸 사고).
  function saveItem(id: string, isExtra: boolean, subcategory: 'lodging_rent' | 'lodging_maintenance') {
    const r = getRow(id, isExtra)
    const target = itemTarget(id, isExtra, subcategory)
    if (!r || !target) return
    const key = `${id}::${subcategory}`
    const fd = new FormData()
    fd.append('target', JSON.stringify(target))
    if (subcategory === 'lodging_rent') {
      const d = deriveRow(r, mealDailyLimit)
      if (d.lodgingRent <= 0) return
      fd.append('amount', String(d.lodgingRent))
      fd.append('lodging_calc_detail', JSON.stringify(
        r.lodgingContract === 'jeonse'
          ? { contractType: 'jeonse', monthlyRent: d.lodgingRent, deposit: parseNum(r.deposit), conversionRatePct: parseFloat(r.conversionRate) || 0, convertedMonthly: d.lodgingRent }
          : { contractType: 'monthly', monthlyRent: d.lodgingRent },
      ))
    } else {
      fd.append('maint_items', JSON.stringify(
        r.maintItems
          .filter((it) => parseNum(it.amountGross) > 0)
          .map((it) => ({ date: it.date, tag: it.tag, amountGross: parseNum(it.amountGross) })),
      ))
    }
    setItemSaveState((p) => ({ ...p, [key]: 'saving' }))
    startReceiptTransition(async () => {
      const res = await saveStaffCostItem(fd)
      if ('error' in res) {
        setItemSaveState((p) => { const n = { ...p }; delete n[key]; return n })
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: res.error ?? '저장 실패' } }))
        return
      }
      setItemSaveState((p) => ({ ...p, [key]: 'saved' }))
      setDirty((p) => { const n = new Set(p); n.delete(key); return n })
    })
  }

  // 인식 결과를 행에 반영한다 — 업로드 직후(autoFillFromReceipts)와
  // 저장된 첨부 재인식(reparseRowReceipts)이 같은 규칙을 쓰도록 한 곳에 둔다.
  function applyParsedAmounts(
    id: string,
    result: { rentTotal: number; maintItems: { date: string; tag: string; amountGross: number }[] },
  ) {
    const isExtra = id.startsWith('extra_')
    {
      const filled: string[] = []
      // 인식된 비목마다 확정 경로가 다르다 — 관리비는 영수증 패널 버튼, 숙소임대비는 전체 임시저장
      let filledMaint = false
      let filledRent = false
      if (result.rentTotal > 0) {
        patchRow(id, isExtra, {
          lodgingContract: 'monthly',
          lodgingRent: result.rentTotal.toLocaleString('ko-KR'),
        })
        filled.push(`숙소임대비 ${result.rentTotal.toLocaleString('ko-KR')}원`)
        filledRent = true
      }
      if (result.maintItems.length > 0) {
        const existing = getRow(id, isExtra)?.maintItems ?? []
        const newItems = result.maintItems
          .filter((it) => !existing.some((e) => e.date === it.date && e.tag === it.tag))
          .map((it) => ({ date: it.date, tag: it.tag, amountGross: it.amountGross.toLocaleString('ko-KR') }))
        if (newItems.length > 0) {
          patchRow(id, isExtra, { maintItems: [...existing, ...newItems] })
          const gross = result.maintItems.reduce((s, it) => s + it.amountGross, 0)
          filled.push(`관리비 ${newItems.length}건 (합계 ${gross.toLocaleString('ko-KR')}원, VAT 제외 후 인정)`)
          filledMaint = true
        }
      }
      // 인식값은 아래 완료 버튼이 임대비·관리비 모두 그 자리에서 저장한다
      const tail = filledMaint || filledRent
        ? ' — 값을 확인한 뒤 아래 [금액 저장하고 주재비 화면으로]를 누르세요.'
        : ''
      setReceiptNotice((p) => ({
        ...p,
        [id]:
          filled.length > 0
            ? { kind: 'ok', text: `영수증에서 자동 인식: ${filled.join(' · ')}${tail}` }
            : { kind: 'warn', text: '첨부에서 금액을 찾지 못했습니다. 직접 입력하세요.' },
      }))
    }
  }

  // 첨부 PDF에서 숙소임대비(이체금액 합산)·관리비(전기·가스 건별)를 읽어 해당 칸을 채운다.
  // 인식값은 제안 — 사용자가 확인·수정 후 저장으로 확정한다.
  function autoFillFromReceipts(id: string, added: File[]) {
    const fd = new FormData()
    for (const f of added) fd.append('files', f)
    startReceiptTransition(async () => {
      const result = await parseReceiptAmounts(fd)
      if ('error' in result) {
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: result.error } }))
        return
      }
      applyParsedAmounts(id, result)
    })
  }

  // 이미 저장된 첨부를 다시 읽어 금액을 채운다 — 인식값을 저장하기 전에 화면을 벗어나면
  // 첨부만 남고 금액이 사라지는데, 그때 첨부를 지웠다 다시 올리지 않아도 되게 한다.
  function reparseRowReceipts(id: string) {
    const isExtra = id.startsWith('extra_')
    // 조회는 사람(현장·연월·성명) 기준이라 비목은 무엇을 넘겨도 같은 결과다
    const target = itemTarget(id, isExtra, 'lodging_rent')
    if (!target) {
      setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: '성명을 먼저 입력하세요.' } }))
      return
    }
    const fd = new FormData()
    fd.append('target', JSON.stringify(target))
    setReparsingRows((p) => new Set(p).add(id))
    startReceiptTransition(async () => {
      const result = await reparseStaffCostReceipts(fd)
      setReparsingRows((p) => { const n = new Set(p); n.delete(id); return n })
      if ('error' in result) {
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: result.error } }))
        return
      }
      applyParsedAmounts(id, result)
    })
  }

  function getRow(id: string, isExtra: boolean): Row | undefined {
    return isExtra ? extraRows.find((r) => r.id === id) : rows[id]
  }

  function patchRow(id: string, isExtra: boolean, patch: Partial<Row>) {
    // 수정된 비목을 dirty로 표시 — 상태 칩이 저장됨→확인 필요로 바뀐다
    const touched = [...new Set(Object.keys(patch).map((k) => FIELD_TO_SUB[k]).filter(Boolean))]
    if (touched.length > 0) {
      setDirty((p) => new Set([...p, ...touched.map((s) => `${id}::${s}`)]))
    }
    // 출근부에 전기된 인원은 근무일수의 원천이 출근부(휴가 등 결근 제외 반영)이므로,
    // 근무기간을 바꿔도 달력 일수로 덮어쓰지 않는다. 출근부 기록이 없는 인원만 자동 계산.
    const hasAttendance = !isExtra && attendanceMap[id] != null
    const applyDerived = (r: Row): Row => {
      const updated = { ...r, ...patch }
      if (('periodStart' in patch || 'periodEnd' in patch) && !hasAttendance) {
        updated.workDays = String(calcWorkDays(updated.periodStart, updated.periodEnd))
      }
      return updated
    }
    if (isExtra) {
      setExtraRows((p) => p.map((r) => r.id === id ? { ...r, ...applyDerived(r) } : r))
    } else {
      setRows((p) => ({ ...p, [id]: applyDerived(p[id]) }))
    }
  }

  function addRow() {
    const id = `extra_${++extraIdSeq}`
    setExtraRows((p) => [...p, { id, name: '', ...makeDefaultRow(yearMonth, '건축', roundTripsDefault, defaultPeriodStart, defaultPeriodEnd) }])
  }

  function removeRow(id: string) {
    setExtraRows((p) => p.filter((r) => r.id !== id))
    setSavedReceipts((p) => { const n = { ...p }; delete n[id]; return n })
    setSheet((p) => (p?.id === id ? null : p))
  }

  const [year, mon] = yearMonth.split('-')

  // 직종 중복 시 자동 번호 부여
  const allSpecialties: { id: string; sp: string }[] = [
    ...activePersons.map((p) => ({ id: p.key, sp: rows[p.key]?.specialty ?? '' })),
    ...extraRows.map((r) => ({ id: r.id, sp: r.specialty })),
  ]
  const spCount: Record<string, number> = {}
  const spIdx: Record<string, number> = {}
  const spLabels: Record<string, string> = {}
  for (const { sp } of allSpecialties) spCount[sp] = (spCount[sp] ?? 0) + 1
  for (const { id, sp } of allSpecialties) {
    if (spCount[sp] > 1) {
      spIdx[sp] = (spIdx[sp] ?? 0) + 1
      spLabels[id] = `${sp}${spIdx[sp]}`
    } else {
      spLabels[id] = sp
    }
  }

  // 합계
  const allRows = [...activePersons.map((p) => rows[p.key]), ...extraRows].filter(Boolean) as Row[]
  const totals = allRows.reduce((acc, r) => {
    const d = deriveRow(r, mealDailyLimit)
    acc.meal += d.meal
    acc.commute += d.commuteTotal
    acc.lodgingRent += d.lodgingRent
    acc.lodgingMaintenance += d.maintApplied
    return acc
  }, { meal: 0, commute: 0, lodgingRent: 0, lodgingMaintenance: 0 })
  const grandTotal = totals.meal + totals.commute + totals.lodgingRent + totals.lodgingMaintenance
  const totalWorkDays = allRows.reduce((s, r) => s + (parseInt(r.workDays) || 0), 0)

  function buildPayloadRow(rowId: string, userId: string, userName: string, r: Row): StaffCostRow {
    const d = deriveRow(r, mealDailyLimit)
    return {
      rowId,
      userId,
      userName,
      specialty: spLabels[rowId] ?? r.specialty,
      periodStart: r.periodStart || null,
      periodEnd: r.periodEnd || null,
      workDays: d.wd,
      lodgingRent: d.lodgingRent,
      lodgingCalcDetail: r.lodgingContract === 'jeonse'
        ? { contractType: 'jeonse', monthlyRent: d.lodgingRent, deposit: parseNum(r.deposit), conversionRatePct: parseFloat(r.conversionRate) || 0, convertedMonthly: d.lodgingRent }
        : { contractType: 'monthly', monthlyRent: d.lodgingRent },
      maintenanceItems: r.maintItems
        .filter((it) => parseNum(it.amountGross) > 0)
        .map((it) => ({ date: it.date, tag: it.tag, amountGross: parseNum(it.amountGross) })),
      commuteMode: r.commuteMode,
      commuteRoundtrip: parseNum(r.commuteRoundtrip),
      commuteTrips: parseInt(r.commuteTrips) || 0,
      commuteCalc: r.commuteCalc,
    }
  }

  function handleSave() {
    setError(null)
    const payload: StaffCostRow[] = [
      // 명부 인원은 계정이 없으므로 이름으로 식별 (서버가 target_user_name 기준 reconcile)
      ...activePersons.map((p) => buildPayloadRow(p.key, '', names[p.key] ?? p.name, rows[p.key])),
      ...extraRows.map((r) => buildPayloadRow(r.id, '', r.name || '(추가)', r)),
    ]

    const formData = new FormData()
    formData.append('site_id', siteId)
    formData.append('year_month', yearMonth)
    formData.append('rows', JSON.stringify(payload))
    // 첨부는 이미 업로드되어 있으므로 URL만 되돌려 보낸다 — 서버가 이걸 기준으로 병합하며,
    // 화면에서 ✕로 지운 URL은 빠져 있으므로 그대로 반영된다
    for (const [rowId, bySub] of Object.entries(savedReceipts)) {
      for (const [subcategory, urls] of Object.entries(bySub)) {
        for (const url of urls) formData.append(`kept::${rowId}::${subcategory}`, url)
      }
    }

    startTransition(async () => {
      const res = await createStaffCosts(formData)
      if (res && 'error' in res) { setError(res.error as string) }
      else { setSuccess(true); setTimeout(() => router.push('/expenses'), 1200) }
    })
  }

  // ── 비목 상태 칩: 서버 저장값과 일치하면 저장됨, 입력·인식 후 미저장이면 확인 필요 ──
  type ItemStatus = 'saving' | 'saved' | 'pending' | 'empty'
  function itemStatus(id: string, sub: string, amount: number): ItemStatus {
    const key = `${id}::${sub}`
    if (itemSaveState[key] === 'saving') return 'saving'
    if (amount <= 0) return 'empty'
    if (dirty.has(key)) return 'pending'
    if (itemSaveState[key] === 'saved' || seededSaved.has(key)) return 'saved'
    return 'pending'
  }

  const STATUS_CHIP: Record<ItemStatus | 'auto', [string, string]> = {
    auto: ['bg-blue-50 text-blue-600', '자동'],
    saved: ['bg-green-50 text-green-700', '✓ 저장됨'],
    saving: ['bg-gray-100 text-gray-500', '저장 중…'],
    pending: ['bg-amber-50 text-amber-700', '확인 필요'],
    empty: ['bg-gray-100 text-gray-400', '미입력'],
  }
  function statusChip(status: ItemStatus | 'auto') {
    const [cls, label] = STATUS_CHIP[status]
    return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
  }

  // 증빙 칩의 비목 색 점 (Tailwind JIT가 클래스를 인식하도록 리터럴로 나열)
  const CATEGORY_DOT: Record<ReceiptCategory, string> = {
    '숙소임대비': 'bg-purple-400',
    '관리비': 'bg-orange-400',
    '교통비 경로캡처': 'bg-blue-400',
  }

  // ── 인원 카드 (카드 1장 = 사람 1명) ──────────────────────────
  // 컴포넌트가 아닌 렌더 함수로 호출한다 — 부모 안에서 정의한 함수를 JSX 태그로 쓰면
  // 렌더마다 타입이 바뀌어 리마운트되고 입력 포커스가 날아간다.
  function renderCard(id: string, r: Row, isExtra: boolean, nameNode: ReactNode) {
    const d = deriveRow(r, mealDailyLimit)
    const patch = (p: Partial<Row>) => patchRow(id, isExtra, p)
    const commuter = isCommuter(r)
    const residence = commuteModeToResidence(r.commuteMode)
    const isJeonse = r.lodgingContract === 'jeonse'
    const collapsed = collapsedCards.has(id)
    const notice = receiptNotice[id]
    const savedList = RECEIPT_CATEGORIES.flatMap((cat) =>
      ((savedReceipts[id] ?? {})[CATEGORY_TO_SUBCATEGORY[cat]] ?? []).map((url) => ({ cat, url })),
    )

    return (
      <article key={id}
        className={`overflow-hidden rounded-xl border border-gray-200 border-l-4 bg-white shadow-sm ${commuter ? 'border-l-sky-500' : 'border-l-purple-500'}`}>
        {/* 요약 행 — 클릭하면 접기/펼치기 (입력 요소 클릭은 제외) */}
        <div
          className="flex cursor-pointer select-none flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3 hover:bg-gray-50/70"
          onClick={(e) => { if ((e.target as HTMLElement).closest('input,select,button,a,label')) return; toggleCard(id) }}
        >
          {nameNode}
          <select value={r.specialty} onChange={(e) => patch({ specialty: e.target.value })}
            className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600 focus:border-blue-400 focus:outline-none">
            {SPECIALTIES.map((s) => <option key={s} value={s}>({s})</option>)}
          </select>
          <span className="text-xs font-semibold text-blue-600">({spLabels[id]})</span>
          {/* 거주 형태 — 숙소비 계상 여부와 교통비 승수를 가른다. 명부 기본값, 회차 중 이사 시 변경 */}
          <div className="flex items-center gap-1">
            {(Object.keys(RESIDENCE_TYPE_LABELS) as ResidenceType[]).map((rt) => (
              <button key={rt} type="button"
                onClick={() => patch({ commuteMode: residenceToCommuteMode(rt) })}
                disabled={!applyCommuteRegulation}
                title={RESIDENCE_TYPE_LABELS[rt]}
                className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  residence === rt
                    ? rt === 'commute' ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-400' : 'bg-purple-100 text-purple-700 ring-1 ring-purple-400'
                    : 'border border-gray-200 bg-white text-gray-400 hover:border-gray-400'
                }`}>
                {RESIDENCE_TYPE_ICONS[rt]} {RESIDENCE_TYPE_SHORT[rt]}
              </button>
            ))}
          </div>
          <span className="whitespace-nowrap text-xs text-gray-500">근무 <b className="text-gray-700">{d.wd}</b>일</span>
          <div className="ml-auto flex items-center gap-2.5">
            <div className="text-right">
              <div className="text-[15px] font-bold text-gray-900">{d.subtotal > 0 ? `${d.subtotal.toLocaleString()}원` : '—'}</div>
              <div className="text-[10px] text-gray-400">소계</div>
            </div>
            <button type="button" onClick={() => toggleCard(id)} aria-expanded={!collapsed} aria-label="상세 접기/펼치기"
              className={`rounded p-1 text-gray-400 transition-transform hover:bg-gray-100 ${collapsed ? '' : 'rotate-180'}`}>▾</button>
            <button type="button" onClick={() => (isExtra ? removeRow(id) : removePersonRow(id))}
              title={isExtra ? '행 삭제' : '이번 달 입력에서 제외'}
              className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500">✕</button>
          </div>
        </div>

        {/* 산출값 적용 안내 — 시트를 닫고 돌아왔을 때 무엇이 반영됐는지 보인다 */}
        {applyNotice?.id === id && (
          <div className="flex items-center gap-2 border-t border-green-100 bg-green-50 px-4 py-2 text-xs font-semibold text-green-700">
            <span>✓ {applyNotice.text}</span>
            <button type="button" onClick={() => setApplyNotice(null)} aria-label="안내 닫기"
              className="ml-auto text-green-400 hover:text-green-700">✕</button>
          </div>
        )}

        {!collapsed && (
          <>
            {/* 근무기간 · 근무일수 */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2 text-xs text-gray-500">
              <label className="flex items-center gap-1.5">근무기간
                <input type="date" value={r.periodStart} onChange={(e) => patch({ periodStart: e.target.value })}
                  className="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                <span className="text-gray-300">~</span>
                <input type="date" value={r.periodEnd} onChange={(e) => patch({ periodEnd: e.target.value })}
                  className="rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
              </label>
              <label className="flex items-center gap-1.5">근무일수
                <input type="number" min={0} max={999} value={r.workDays} onChange={(e) => patch({ workDays: e.target.value })}
                  className="w-16 rounded border border-gray-300 bg-white px-2 py-1 text-center text-xs text-gray-700 focus:border-blue-500 focus:outline-none" />
                일 <span className="text-gray-400">(출근부 연동)</span>
              </label>
              {d.staleLodging > 0 && (
                <span className="text-amber-600">⚠ 자가 출퇴근인데 숙소비 {d.staleLodging.toLocaleString()}원이 입력되어 있습니다 — 저장하면 0으로 정리됩니다.</span>
              )}
            </div>

            {/* 비목 그리드: 숙소임대비 / 관리비 / 식대 / 교통비 */}
            <div className="grid grid-cols-2 gap-px border-t border-gray-200 bg-gray-200 xl:grid-cols-4">
              <div className="flex min-h-[108px] flex-col gap-1.5 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">숙소임대비</span>
                  {!commuter && statusChip(itemStatus(id, 'lodging_rent', d.lodgingRent))}
                </div>
                {commuter ? (
                  <p className="my-auto text-xs text-gray-400">해당 없음 — 자가 출퇴근</p>
                ) : (
                  <>
                    <NumInput
                      value={isJeonse ? (d.lodgingRent > 0 ? d.lodgingRent.toLocaleString('ko-KR') : '') : r.lodgingRent}
                      onChange={isJeonse ? undefined : (v) => patch({ lodgingRent: v })}
                      readOnly={isJeonse}
                    />
                    <button type="button" onClick={() => setSheet({ id, isExtra, panel: 'lodging' })}
                      className="mt-auto text-left text-xs font-semibold text-purple-600 hover:underline">
                      🏠 {isJeonse ? '전세 환산 근거' : '계약 형태 (월세/전세)'}
                    </button>
                  </>
                )}
              </div>

              <div className="flex min-h-[108px] flex-col gap-1.5 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">관리비 <span className="font-normal text-gray-400">(VAT 제외)</span></span>
                  {!commuter && statusChip(itemStatus(id, 'lodging_maintenance', d.maintApplied))}
                </div>
                {commuter ? (
                  <p className="my-auto text-xs text-gray-400">해당 없음</p>
                ) : (
                  <>
                    <div className="text-[15px] font-bold text-gray-900">{d.maintApplied > 0 ? `${d.maintApplied.toLocaleString()}원` : '—'}</div>
                    {d.maintGross > 0 && <p className="text-[11px] text-gray-400">합계 {d.maintGross.toLocaleString()}원에서 부가세 제외</p>}
                    <button type="button" onClick={() => setSheet({ id, isExtra, panel: 'maint' })}
                      className="mt-auto text-left text-xs font-semibold text-orange-600 hover:underline">
                      🧾 내역 {r.maintItems.length > 0 ? `${r.maintItems.length}건 확인` : '입력'}
                    </button>
                  </>
                )}
              </div>

              <div className="flex min-h-[108px] flex-col gap-1.5 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">식대</span>
                  {statusChip('auto')}
                </div>
                <div className="text-[15px] font-bold text-blue-700">{d.meal > 0 ? `${d.meal.toLocaleString()}원` : '—'}</div>
                <p className="text-[11px] text-gray-400">{d.wd}일 × {mealDailyLimit.toLocaleString()}원 (출근부 기준)</p>
              </div>

              <div className="flex min-h-[108px] flex-col gap-1.5 bg-white p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-500">{commuter ? '출퇴근 교통비' : '주말 교통비'}</span>
                  {applyCommuteRegulation && statusChip(itemStatus(id, 'commute', d.commuteTotal))}
                </div>
                {!applyCommuteRegulation ? (
                  <p className="my-auto text-xs text-gray-400">여비규정 미적용</p>
                ) : (
                  <>
                    <div className="text-[15px] font-bold text-gray-900">{d.commuteTotal > 0 ? `${d.commuteTotal.toLocaleString()}원` : '—'}</div>
                    <div className="flex items-center gap-1 text-[11px] text-gray-500">
                      <span className="w-24 shrink-0">
                        <NumInput value={r.commuteRoundtrip} onChange={(v) => patch({ commuteRoundtrip: v, commuteCalc: null })} />
                      </span>
                      ×
                      {r.commuteMode === 'lodging_return' ? (
                        <>
                          <input type="number" min={0} max={maxRoundTrips} value={r.commuteTrips}
                            onChange={(e) => patch({ commuteTrips: e.target.value })}
                            title={`기성기간 전체 주말 왕복 횟수 — 기본 월 ${commuteTripsDefault}회 × ${periodMonths}개월 = ${roundTripsDefault}회 (최대 ${maxRoundTrips}회)`}
                            className="w-14 rounded border border-gray-300 px-1 py-1 text-center text-xs focus:border-blue-500 focus:outline-none" />
                          회 (주말 왕복)
                        </>
                      ) : (
                        <span>{d.wd}일 (근무일수)</span>
                      )}
                    </div>
                    {r.commuteMode === 'lodging_return' && (
                      <p className="text-[10.5px] text-gray-400">
                        기성기간 전체 기준 — 월 {commuteTripsDefault}회 × {periodMonths}개월 = {roundTripsDefault}회
                      </p>
                    )}
                    <button type="button" onClick={() => setSheet({ id, isExtra, panel: 'commute' })}
                      className="mt-auto text-left text-xs font-semibold text-green-700 hover:underline">
                      🚗 자차 왕복비 산출
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 증빙 스트립 — 사람 단위로 붙어 "누구 증빙이 빠졌나"가 보인다 */}
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/60 px-4 py-2.5">
              {/* 증빙이 없는 행은 라벨부터 눈에 띄어야 한다 — 스트립의 목적이 "누구 증빙이 빠졌나" */}
              <span className={`text-xs font-semibold ${savedList.length === 0 ? 'text-amber-700' : 'text-gray-500'}`}>
                증빙 {savedList.length}
              </span>
              {savedList.map(({ cat, url }) => (
                <span key={url} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow-sm">
                  <span className={`h-2 w-2 rounded-sm ${CATEGORY_DOT[cat]}`} />
                  <a href={receiptHref(url)} target="_blank" rel="noreferrer" title={receiptFileName(url)}
                    className="max-w-[130px] truncate font-medium text-blue-600 hover:underline">
                    {receiptFileName(url)}
                  </a>
                  <button type="button" onClick={() => removeSavedReceipt(id, cat, url)} aria-label="첨부 제거"
                    className="text-gray-300 hover:text-red-500">✕</button>
                </span>
              ))}
              {/* 숙소임대비·관리비 증빙이 모두 이 버튼으로 들어온다 — 회색 점선이라 첨부 자리로 읽히지 않았다.
                  출근부 화면의 '거주지 증빙 첨부'와 같은 규칙: 없으면 주황(누락), 있으면 파랑(추가) */}
              <button type="button" onClick={() => setSheet({ id, isExtra, panel: 'receipt' })}
                title="숙소임대비 이체확인증·관리비 납입확인서·식비·교통비 영수증 — PDF는 금액이 자동 인식됩니다"
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-semibold ${
                  savedList.length === 0
                    ? 'border border-dashed border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-500 hover:bg-amber-100'
                    : 'border border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100'
                }`}>
                <span aria-hidden="true">📎</span>
                {savedList.length === 0 ? '영수증 첨부 (자동 인식)' : '영수증 추가 (자동 인식)'}
              </button>
              {uploadingRows.has(id) && <span className="text-xs text-blue-600">⏳ 업로드 중…</span>}
              {notice && (
                <span className={`basis-full text-xs ${notice.kind === 'ok' ? 'text-green-700' : 'text-amber-600'}`}>
                  {notice.kind === 'ok' ? '✓ ' : '⚠ '}{notice.text}
                </span>
              )}
            </div>
          </>
        )}
      </article>
    )
  }

  const sheetRow = sheet ? getRow(sheet.id, sheet.isExtra) : undefined
  const sheetName = sheet
    ? (sheet.isExtra ? (extraRows.find((e) => e.id === sheet.id)?.name || '(추가)') : (names[sheet.id] ?? ''))
    : ''
  const SHEET_TITLES: Record<SheetPanel, string> = {
    receipt: '영수증 첨부',
    maint: '관리비 건별 내역',
    lodging: '숙소 계약 형태',
    commute: '자차 왕복비 산출',
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">{siteName}</h2>
          <p className="text-sm text-gray-500">{year}년 {parseInt(mon)}월 인원별 주재비 정산</p>
        </div>
        <div className="text-right">
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
            합계 {grandTotal.toLocaleString()}원
          </span>
          {/* 계상 잔액 — 발주청 정산(매 기성·준공)은 증빙으로 채운 만큼만 지급되므로 입력 화면에서 먼저 보인다 */}
          {categoryRemaining !== null && (
            <p className={`mt-1 text-[11px] ${categoryRemaining < 0 ? 'font-semibold text-red-500' : 'text-gray-400'}`}>
              {categoryRemaining < 0
                ? `현장주재비 계상 초과 ${(-categoryRemaining).toLocaleString()}원 — 총액 내 흡수 여부 확인 필요`
                : `현장주재비 계상 잔액 ${categoryRemaining.toLocaleString()}원`}
            </p>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다. 이동 중...</div>}

      <div className="space-y-3">
        {activePersons.map((p) => renderCard(p.key, rows[p.key], false, (
          <input type="text" value={names[p.key] ?? p.name}
            onChange={(e) => setNames((prev) => ({ ...prev, [p.key]: e.target.value }))}
            className="w-28 rounded border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-bold text-gray-900 hover:border-gray-300 focus:border-blue-500 focus:bg-white focus:outline-none" />
        )))}
        {extraRows.map((r) => renderCard(r.id, r, true, (
          <input type="text" value={r.name} placeholder="이름 입력"
            onChange={(e) => setExtraRows((p) => p.map((row) => row.id === r.id ? { ...row, name: e.target.value } : row))}
            className="w-28 rounded border border-gray-300 px-1.5 py-1 text-[15px] font-bold text-gray-900 focus:border-blue-500 focus:outline-none" />
        )))}
      </div>

      <button type="button" onClick={addRow}
        className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:border-blue-400 hover:text-blue-600">
        + 인원 추가
      </button>

      {/* 비목별 합계 */}
      <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
        <span>근무 <b className="text-gray-700">{totalWorkDays}</b>일</span>
        <span>숙소임대 <b className="text-gray-700">{fmt(totals.lodgingRent)}</b></span>
        <span>관리비 <b className="text-gray-700">{fmt(totals.lodgingMaintenance)}</b></span>
        <span>식대 <b className="text-gray-700">{fmt(totals.meal)}</b></span>
        <span>교통비 <b className="text-gray-700">{fmt(totals.commute)}</b></span>
        <span className="text-sm text-gray-600">합계 <b className="text-blue-700">{grandTotal.toLocaleString()}원</b></span>
      </div>

      <div className="flex gap-3 pt-1">
        <button type="button" onClick={() => router.back()}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          취소
        </button>
        <button type="button" onClick={handleSave} disabled={isPending || success}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending ? '저장 중...' : '전체 임시저장'}
        </button>
      </div>

      {/* 우측 시트 — 상세 패널 (관리비 내역 / 숙소 계약 / 자차 산출 / 영수증) */}
      {sheet && sheetRow && (
        <>
          <div className="fixed inset-0 z-40 bg-gray-900/40" onClick={() => setSheet(null)} aria-hidden="true" />
          <aside role="dialog" aria-modal="true" aria-label={SHEET_TITLES[sheet.panel]}
            className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[94vw] flex-col bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-[15px] font-bold text-gray-900">{SHEET_TITLES[sheet.panel]}</h3>
                <p className="mt-0.5 text-xs text-gray-500">{sheetName} ({spLabels[sheet.id] ?? sheetRow.specialty})</p>
              </div>
              <button type="button" onClick={() => setSheet(null)} aria-label="닫기"
                className="rounded-lg bg-gray-100 px-2.5 py-1.5 text-sm text-gray-500 hover:bg-gray-200">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sheet.panel === 'receipt' && (
                <ReceiptPanel
                  savedByCategory={savedReceipts[sheet.id] ?? {}}
                  onAdd={(files, category) => uploadRowReceipts(sheet.id, files, category)}
                  onRemoveSaved={(category, url) => removeSavedReceipt(sheet.id, category, url)}
                  uploading={uploadingRows.has(sheet.id)}
                  maxFiles={maxFiles}
                  notice={receiptNotice[sheet.id]}
                  maintPendingCount={sheetRow.maintItems.filter((it) => parseNum(it.amountGross) > 0).length}
                  rentPendingAmount={sheetRow.commuteMode === 'daily_commute' ? 0 : deriveRow(sheetRow, mealDailyLimit).lodgingRent}
                  saving={
                    itemSaveState[`${sheet.id}::lodging_maintenance`] === 'saving' ||
                    itemSaveState[`${sheet.id}::lodging_rent`] === 'saving'
                  }
                  onReparse={() => reparseRowReceipts(sheet.id)}
                  reparsing={reparsingRows.has(sheet.id)}
                  disabledCategories={sheetRow.commuteMode === 'daily_commute' ? LODGING_CATEGORIES : []}
                  disabledReason="자가 출퇴근 — 숙소임대비·관리비 비대상"
                  onDone={() => {
                    // 인식·입력된 금액을 그 자리에서 확정하고 닫는다 — [전체 임시저장]까지 미루면
                    // 그 사이 화면을 벗어났을 때 인식값이 0으로 되돌아간 채 저장된다 (실제 사고 사례)
                    if (sheetRow.maintItems.some((it) => parseNum(it.amountGross) > 0)) {
                      saveItem(sheet.id, sheet.isExtra, 'lodging_maintenance')
                    }
                    if (sheetRow.commuteMode !== 'daily_commute' && deriveRow(sheetRow, mealDailyLimit).lodgingRent > 0) {
                      saveItem(sheet.id, sheet.isExtra, 'lodging_rent')
                    }
                    setSheet(null)
                  }}
                />
              )}
              {sheet.panel === 'maint' && (
                <MaintenancePanel
                  items={sheetRow.maintItems}
                  onChange={(items) => patchRow(sheet.id, sheet.isExtra, { maintItems: items })}
                  onSave={() => saveItem(sheet.id, sheet.isExtra, 'lodging_maintenance')}
                  saveState={itemSaveState[`${sheet.id}::lodging_maintenance`]}
                />
              )}
              {sheet.panel === 'lodging' && (
                <LodgingPanel
                  r={sheetRow}
                  onChange={(patch) => patchRow(sheet.id, sheet.isExtra, patch)}
                />
              )}
              {sheet.panel === 'commute' && (
                <CommuteCalcPanel
                  siteId={siteId}
                  siteAddress={siteAddress ?? ''}
                  isOwnRow={sheet.id === myUserId}
                  // 자택주소 우선순위: 이미 산출한 값 → 명부(거주지 증빙에서 인식) → 본인 프로필
                  defaultHomeAddress={
                    sheetRow.commuteCalc?.homeAddress
                    || memberHomeAddress[sheet.id]
                    || (sheet.id === myUserId ? myHomeAddress : undefined)
                  }
                  defaultFuelType={sheet.id === myUserId ? myFuelType : undefined}
                  periodStart={sheetRow.periodStart}
                  periodEnd={sheetRow.periodEnd}
                  initial={sheetRow.commuteCalc}
                  onApply={(params: CommuteApplyParams) => {
                    patchRow(sheet.id, sheet.isExtra, {
                      commuteRoundtrip: params.costPerTrip.toLocaleString('ko-KR'),
                      commuteCalc: {
                        homeAddress: params.homeAddress,
                        distanceOnewayKm: params.distanceOnewayKm,
                        fuelType: params.fuelType,
                        fuelEfficiency: params.fuelEfficiency,
                        fuelPrice: params.fuelPrice,
                        fuelPriceDate: params.fuelPriceDate,
                        tollRoundtrip: params.tollRoundtrip,
                      },
                    })
                    // 적용 즉시 시트를 닫고 카드로 돌아간다 — 반영된 금액을 그 자리에서 확인하도록
                    // (시트가 카드를 가려, 열린 채로 두면 적용됐는지 알 수 없다)
                    setSheet(null)
                    setApplyNotice({
                      id: sheet.id,
                      text: `${sheetName} 1회 왕복비 ${params.costPerTrip.toLocaleString('ko-KR')}원 적용 — 아래 교통비 금액을 확인하고 저장하세요.`,
                    })
                  }}
                />
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  )
}
