'use client'

import { useState, useTransition, useRef, useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  createStaffCosts,
  attachStaffCostReceipt,
  detachStaffCostReceipt,
  saveStaffCostItem,
  type StaffCostRow,
  type StaffCostCommuteCalc,
  type StaffCostItemTarget,
} from '@/actions/expenses'
import type { AttendanceRecord, SiteStaffMember, LodgingCalcDetail } from '@/types'
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

const RECEIPT_CATEGORIES = ['숙소임대비', '관리비', '식비', '교통비'] as const
type ReceiptCategory = typeof RECEIPT_CATEGORIES[number]
const CATEGORY_COLORS: Record<ReceiptCategory, string> = {
  '숙소임대비': 'bg-purple-100 text-purple-700',
  '관리비':    'bg-orange-100 text-orange-700',
  '식비':      'bg-green-100 text-green-700',
  '교통비':    'bg-blue-100 text-blue-700',
}

// 파일명에서 비목 자동 인식 (일괄 업로드 자동 분류) — 관리비 키워드를 먼저 본다
// ("관리비_납입확인서"가 이체·숙소 키워드와 겹치지 않도록)
function detectCategory(filename: string): ReceiptCategory | null {
  if (/관리비|전기|가스|납입확인/.test(filename)) return '관리비'
  if (/숙소|임대|월세|이체확인/.test(filename)) return '숙소임대비'
  if (/식비|식대/.test(filename)) return '식비'
  if (/유류|주유|통행료|하이패스|교통/.test(filename)) return '교통비'
  return null
}
// 영수증 비목 라벨 → expenses.subcategory 값 매핑 (서버 액션에 전달할 때 사용)
const CATEGORY_TO_SUBCATEGORY: Record<ReceiptCategory, string> = {
  '숙소임대비': 'lodging_rent',
  '관리비':    'lodging_maintenance',
  '식비':      'meal',
  '교통비':    'commute',
}

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
  // 교통비: 1회 왕복비 × (숙박형: 월횟수 / 출퇴근형: 근무일수)
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
function ReceiptPanel({ savedByCategory, onAdd, onRemoveSaved, uploading, maxFiles, notice }: {
  savedByCategory: Record<string, string[]>
  onAdd: (files: File[], category: ReceiptCategory) => void
  onRemoveSaved: (category: ReceiptCategory, url: string) => void
  uploading: boolean
  maxFiles: number
  notice?: { kind: 'ok' | 'warn'; text: string } | null
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<ReceiptCategory>('숙소임대비')

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
      // 파일명에서 비목이 읽히면 그것을, 아니면 위에서 선택한 비목을 쓴다
      valid.push({ file: f, category: detectCategory(f.name) ?? selectedCategory })
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
        <div className="flex gap-1.5">
          {RECEIPT_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                selectedCategory === cat
                  ? CATEGORY_COLORS[cat] + ' ring-2 ring-offset-1 ring-current'
                  : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-400'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

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
              <a href={url} target="_blank" rel="noreferrer"
                className="max-w-[130px] truncate text-xs font-medium text-blue-600 hover:underline">
                {decodeURIComponent(url.split('/').pop() ?? '첨부')}
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
function LodgingPanel({ r, onChange, onSave, saveState }: {
  r: Row
  onChange: (patch: Partial<Row>) => void
  onSave: () => void
  saveState?: 'saving' | 'saved'
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
        <p className="text-xs text-gray-500">월세 금액을 표의 숙소임대비 칸에 직접 입력하세요.</p>
      )}
      <ItemSaveButton label="숙소임대비 저장" onSave={onSave} saveState={saveState} tone="purple" />
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
        commuteTripsDefault,
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
  const periodMonths =
    defaultPeriodStart && defaultPeriodEnd
      ? Math.max(
          1,
          (parseInt(defaultPeriodEnd.slice(0, 4), 10) * 12 + parseInt(defaultPeriodEnd.slice(5, 7), 10)) -
            (parseInt(defaultPeriodStart.slice(0, 4), 10) * 12 + parseInt(defaultPeriodStart.slice(5, 7), 10)) +
            1,
        )
      : 1
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

  // (C) 비목 1건 저장 — 자동 인식값을 확인한 뒤 이 비목만 확정한다
  function saveItem(id: string, isExtra: boolean, subcategory: 'lodging_rent' | 'lodging_maintenance') {
    const r = getRow(id, isExtra)
    const target = itemTarget(id, isExtra, subcategory)
    if (!r || !target) return
    const key = `${id}::${subcategory}`
    const fd = new FormData()
    fd.append('target', JSON.stringify(target))
    if (subcategory === 'lodging_rent') {
      const d = deriveRow(r, mealDailyLimit)
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

  // 첨부 PDF에서 숙소임대비(이체금액 합산)·관리비(전기·가스 건별)를 읽어 해당 칸을 채운다.
  // 인식값은 제안 — 사용자가 확인·수정 후 저장으로 확정한다.
  function autoFillFromReceipts(id: string, added: File[]) {
    const isExtra = id.startsWith('extra_')
    const fd = new FormData()
    for (const f of added) fd.append('files', f)
    startReceiptTransition(async () => {
      const result = await parseReceiptAmounts(fd)
      if ('error' in result) {
        setReceiptNotice((p) => ({ ...p, [id]: { kind: 'warn', text: result.error } }))
        return
      }
      const filled: string[] = []
      if (result.rentTotal > 0) {
        patchRow(id, isExtra, {
          lodgingContract: 'monthly',
          lodgingRent: result.rentTotal.toLocaleString('ko-KR'),
        })
        filled.push(`숙소임대비 ${result.rentTotal.toLocaleString('ko-KR')}원`)
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
        }
      }
      setReceiptNotice((p) => ({
        ...p,
        [id]:
          filled.length > 0
            ? { kind: 'ok', text: `영수증에서 자동 인식: ${filled.join(' · ')} — 값을 확인하고 해당 비목의 저장 버튼을 누르세요.` }
            : { kind: 'warn', text: '첨부에서 금액을 찾지 못했습니다. 직접 입력하세요.' },
      }))
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
    setExtraRows((p) => [...p, { id, name: '', ...makeDefaultRow(yearMonth, '건축', commuteTripsDefault, defaultPeriodStart, defaultPeriodEnd) }])
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
    '식비': 'bg-green-400',
    '교통비': 'bg-blue-400',
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
                  <span className="text-xs font-semibold text-gray-500">{commuter ? '출퇴근 교통비' : '귀가 교통비'}</span>
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
                          <input type="number" min={0} max={10} value={r.commuteTrips} onChange={(e) => patch({ commuteTrips: e.target.value })}
                            className="w-11 rounded border border-gray-300 px-1 py-1 text-center text-xs focus:border-blue-500 focus:outline-none" />
                          회 (월 귀가)
                        </>
                      ) : (
                        <span>{d.wd}일 (근무일수)</span>
                      )}
                    </div>
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
              <span className="text-xs font-semibold text-gray-500">증빙 {savedList.length}</span>
              {savedList.map(({ cat, url }) => (
                <span key={url} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow-sm">
                  <span className={`h-2 w-2 rounded-sm ${CATEGORY_DOT[cat]}`} />
                  <a href={url} target="_blank" rel="noreferrer" className="max-w-[130px] truncate font-medium text-blue-600 hover:underline">
                    {decodeURIComponent(url.split('/').pop() ?? '첨부')}
                  </a>
                  <button type="button" onClick={() => removeSavedReceipt(id, cat, url)} aria-label="첨부 제거"
                    className="text-gray-300 hover:text-red-500">✕</button>
                </span>
              ))}
              <button type="button" onClick={() => setSheet({ id, isExtra, panel: 'receipt' })}
                className="rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600">
                + 영수증 추가 (자동 인식)
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
                  onSave={() => saveItem(sheet.id, sheet.isExtra, 'lodging_rent')}
                  saveState={itemSaveState[`${sheet.id}::lodging_rent`]}
                />
              )}
              {sheet.panel === 'commute' && (
                <CommuteCalcPanel
                  siteId={siteId}
                  siteAddress={siteAddress ?? ''}
                  isOwnRow={sheet.id === myUserId}
                  defaultHomeAddress={sheet.id === myUserId ? myHomeAddress : undefined}
                  defaultFuelType={sheet.id === myUserId ? myFuelType : undefined}
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
