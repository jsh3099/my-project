'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffCosts, type StaffCostRow, type StaffCostMaintItem, type StaffCostCommuteCalc } from '@/actions/expenses'
import type { Profile, AttendanceRecord, SiteStaffMember } from '@/types'
import { calcWorkDays } from '@/lib/korean-holidays'
import { SPECIALTIES, COMMUTE_MODE_LABELS, type CommuteMode } from '@/lib/constants'
import { applyVatExclusion, convertJeonseToMonthly } from '@/lib/settlement'
import { CommuteCalcPanel, type CommuteApplyParams } from './CommuteCalcPanel'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  users: Profile[]
  members: SiteStaffMember[]   // 현장 기술인 명부 (로그인 계정 없음 — 출근부 화면에서 등록)
  attendance: AttendanceRecord[]
  mealDailyLimit?: number
  applyCommuteRegulation?: boolean
  commuteTripsDefault?: number
  siteAddress?: string | null
  myUserId?: string
  myHomeAddress?: string | null
  myFuelType?: string | null
}

const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_FILES = 5
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

function parseNum(v: string) { return parseInt(v.replace(/,/g, ''), 10) || 0 }
function fmt(n: number) { return n > 0 ? n.toLocaleString('ko-KR') : '-' }
function fmtSize(b: number) { return b < 1024 * 1024 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB` }

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
// 영수증 비목 라벨 → expenses.subcategory 값 매핑 (서버 액션에 전달할 때 사용)
const CATEGORY_TO_SUBCATEGORY: Record<ReceiptCategory, string> = {
  '숙소임대비': 'lodging_rent',
  '관리비':    'lodging_maintenance',
  '식비':      'meal',
  '교통비':    'commute',
}

type AttachedFile = { file: File; preview: string | null; category: ReceiptCategory }

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

function makeDefaultRow(yearMonth: string, specialty: string, tripsDefault: number): Row {
  return {
    periodStart: `${yearMonth}-01`, periodEnd: '', workDays: '0', specialty,
    lodgingContract: 'monthly', lodgingRent: '', deposit: '', conversionRate: '5.5',
    maintItems: [],
    commuteMode: 'lodging_return', commuteRoundtrip: '', commuteTrips: String(tripsDefault), commuteCalc: null,
  }
}

// 행별 파생값 계산 (미리보기용 — 저장 시 서버가 동일 규칙으로 재계산)
function deriveRow(r: Row, mealDailyLimit: number) {
  const wd = parseInt(r.workDays) || 0
  const meal = wd * mealDailyLimit
  const lodgingRent = r.lodgingContract === 'jeonse'
    ? convertJeonseToMonthly(parseNum(r.deposit), parseFloat(r.conversionRate) || 0)
    : parseNum(r.lodgingRent)
  const maintGross = r.maintItems.reduce((s, i) => s + parseNum(i.amountGross), 0)
  const maintApplied = maintGross > 0 ? applyVatExclusion(maintGross) : 0
  const multiplier = r.commuteMode === 'daily_commute' ? wd : (parseInt(r.commuteTrips) || 0)
  const commuteTotal = parseNum(r.commuteRoundtrip) * multiplier
  return { wd, meal, lodgingRent, maintGross, maintApplied, multiplier, commuteTotal, subtotal: meal + lodgingRent + maintApplied + commuteTotal }
}

let extraIdSeq = 0

// ── 영수증 패널 ─────────────────────────────────────────────
function ReceiptPanel({ files, onChange }: { files: AttachedFile[]; onChange: (files: AttachedFile[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<ReceiptCategory>('숙소임대비')

  function addFiles(incoming: FileList | null) {
    if (!incoming) return
    const valid: AttachedFile[] = []
    for (const f of Array.from(incoming)) {
      if (files.length + valid.length >= MAX_FILES) break
      if (f.size > MAX_SIZE) { alert(`${f.name}: 파일 크기는 10MB 이하만 가능합니다.`); continue }
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null
      valid.push({ file: f, preview, category: selectedCategory })
    }
    if (valid.length) onChange([...files, ...valid])
  }

  function remove(idx: number) {
    onChange(files.filter((_, i) => i !== idx))
  }

  function changeCategory(idx: number, cat: ReceiptCategory) {
    onChange(files.map((f, i) => i === idx ? { ...f, category: cat } : f))
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

      {files.length < MAX_FILES && (
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

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((af, idx) => (
            <div key={idx} className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 shadow-sm">
              {af.preview
                ? <img src={af.preview} alt={af.file.name} className="h-8 w-8 rounded object-cover" />
                : <div className="flex h-8 w-8 items-center justify-center rounded bg-red-50 text-xs font-bold text-red-500">PDF</div>
              }
              <div className="max-w-[110px]">
                <p className="truncate text-xs font-medium text-gray-700">{af.file.name}</p>
                <p className="text-xs text-gray-400">{fmtSize(af.file.size)}</p>
              </div>
              <select
                value={af.category}
                onChange={(e) => changeCategory(idx, e.target.value as ReceiptCategory)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium border-0 focus:outline-none focus:ring-1 focus:ring-blue-400 ${CATEGORY_COLORS[af.category]}`}
              >
                {RECEIPT_CATEGORIES.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
              <button type="button" onClick={() => remove(idx)}
                className="rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors">
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400">최대 {MAX_FILES}개 · JPG·PNG·PDF · 10MB 이하</p>
    </div>
  )
}

// ── 관리비 건별 내역 패널 (정산서 1-1 관리비 사용내역 — 합계에서 VAT 제외) ──
function MaintenancePanel({ items, onChange }: { items: MaintItem[]; onChange: (items: MaintItem[]) => void }) {
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
      </div>
    </div>
  )
}

// ── 숙소임대비 패널 (월세 / 전세 환산) ──────────────────────────
function LodgingPanel({ r, onChange }: { r: Row; onChange: (patch: Partial<Row>) => void }) {
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
    </div>
  )
}

// 표에 뜨는 기본 인원: 계정 인원(key=userId) + 명부 인원(key=m_{memberId})
type BasePerson = { key: string; name: string; isMember: boolean; defaultSpecialty: string | null }

export function StaffCostForm({ siteId, siteName, yearMonth, users, members, attendance, mealDailyLimit = 25000, applyCommuteRegulation = true, commuteTripsDefault = 4, siteAddress, myUserId, myHomeAddress, myFuelType }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // 출근부 일수 — 계정 인원은 user_id, 명부 인원은 member_id 기준
  const attendanceMap = Object.fromEntries(
    attendance.map((a) => [a.user_id ?? `m_${a.member_id}`, a.work_days]),
  )

  const basePersons: BasePerson[] = [
    ...users.map((u) => ({ key: u.id, name: u.full_name, isMember: false, defaultSpecialty: null })),
    ...members.map((m) => ({ key: `m_${m.id}`, name: m.name, isMember: true, defaultSpecialty: m.specialty })),
  ]

  const [rows, setRows] = useState<Record<string, Row>>(
    Object.fromEntries(basePersons.map((p, i) => [p.key, {
      ...makeDefaultRow(
        yearMonth,
        p.defaultSpecialty && (SPECIALTIES as readonly string[]).includes(p.defaultSpecialty)
          ? p.defaultSpecialty
          : SPECIALTIES[i % SPECIALTIES.length],
        commuteTripsDefault,
      ),
      workDays: String(attendanceMap[p.key] ?? 0),
    }]))
  )

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

  const [receipts, setReceipts] = useState<Record<string, AttachedFile[]>>({})
  // 행별 패널 열림 상태: receipt | commute | maint | lodging
  const [openPanel, setOpenPanel] = useState<Record<string, string | null>>({})
  function togglePanel(id: string, panel: string) {
    setOpenPanel((p) => ({ ...p, [id]: p[id] === panel ? null : panel }))
  }

  function setRowReceipts(id: string, files: AttachedFile[]) {
    setReceipts((p) => ({ ...p, [id]: files }))
  }

  function getRow(id: string, isExtra: boolean): Row | undefined {
    return isExtra ? extraRows.find((r) => r.id === id) : rows[id]
  }

  function patchRow(id: string, isExtra: boolean, patch: Partial<Row>) {
    const applyDerived = (r: Row): Row => {
      const updated = { ...r, ...patch }
      if ('periodStart' in patch || 'periodEnd' in patch) {
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
    setExtraRows((p) => [...p, { id, name: '', ...makeDefaultRow(yearMonth, '건축', commuteTripsDefault) }])
  }

  function removeRow(id: string) {
    setExtraRows((p) => p.filter((r) => r.id !== id))
    setReceipts((p) => { const n = { ...p }; delete n[id]; return n })
    setOpenPanel((p) => { const n = { ...p }; delete n[id]; return n })
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
      // 명부 인원(m_*)은 계정이 없으므로 이름으로 식별 (서버가 target_user_name 기준 reconcile)
      ...activePersons.map((p) => buildPayloadRow(p.key, p.isMember ? '' : p.key, names[p.key] ?? p.name, rows[p.key])),
      ...extraRows.map((r) => buildPayloadRow(r.id, '', r.name || '(추가)', r)),
    ]

    const formData = new FormData()
    formData.append('site_id', siteId)
    formData.append('year_month', yearMonth)
    formData.append('rows', JSON.stringify(payload))
    for (const [rowId, files] of Object.entries(receipts)) {
      for (const af of files) {
        const subcategory = CATEGORY_TO_SUBCATEGORY[af.category]
        formData.append(`receipt::${rowId}::${subcategory}`, af.file)
      }
    }

    startTransition(async () => {
      const res = await createStaffCosts(formData)
      if (res && 'error' in res) { setError(res.error as string) }
      else { setSuccess(true); setTimeout(() => router.push('/expenses'), 1200) }
    })
  }

  function RowCells({ id, r, name, isExtra = false }: { id: string; r: Row; name: React.ReactNode; isExtra?: boolean }) {
    const d = deriveRow(r, mealDailyLimit)
    const patch = (p: Partial<Row>) => patchRow(id, isExtra, p)
    const fileCount = receipts[id]?.length ?? 0
    const isJeonse = r.lodgingContract === 'jeonse'
    return (
      <>
        <td className="px-4 py-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {name}
            <select value={r.specialty} onChange={(e) => patch({ specialty: e.target.value })}
              className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600 focus:outline-none focus:border-blue-400">
              {SPECIALTIES.map((s) => <option key={s} value={s}>({s})</option>)}
            </select>
            <span className="text-xs font-semibold text-blue-600">({spLabels[id]})</span>
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            <input type="date" value={r.periodStart} onChange={(e) => patch({ periodStart: e.target.value })}
              className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
            <span className="text-gray-400 text-xs">~</span>
            <input type="date" value={r.periodEnd} onChange={(e) => patch({ periodEnd: e.target.value })}
              className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
          </div>
        </td>
        <td className="px-3 py-2 text-center">
          <input type="number" min={0} max={62} value={r.workDays} onChange={(e) => patch({ workDays: e.target.value })}
            className="w-14 rounded border border-gray-300 px-2 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none" />
        </td>
        <td className="px-3 py-2">
          <NumInput
            value={isJeonse ? (d.lodgingRent > 0 ? d.lodgingRent.toLocaleString('ko-KR') : '') : r.lodgingRent}
            onChange={isJeonse ? undefined : (v) => patch({ lodgingRent: v })}
            readOnly={isJeonse}
          />
          <button type="button" onClick={() => togglePanel(id, 'lodging')}
            className="mt-0.5 w-full text-center text-xs text-purple-600 hover:underline">
            🏠 {isJeonse ? '전세 환산' : '계약 형태'}
          </button>
        </td>
        <td className="px-3 py-2">
          <NumInput value={d.maintApplied > 0 ? d.maintApplied.toLocaleString('ko-KR') : ''} readOnly />
          <button type="button" onClick={() => togglePanel(id, 'maint')}
            className="mt-0.5 w-full text-center text-xs text-orange-600 hover:underline">
            🧾 내역 {r.maintItems.length > 0 ? `(${r.maintItems.length}건)` : '입력'}
          </button>
        </td>
        <td className="px-3 py-2">
          <div className="relative">
            <input readOnly value={d.meal > 0 ? d.meal.toLocaleString('ko-KR') : ''} placeholder="0"
              className="w-full rounded border border-blue-200 bg-blue-50 px-2 py-1.5 pr-6 text-right text-sm font-medium text-blue-700 cursor-default" />
            <span className="absolute right-1.5 top-1.5 text-xs text-blue-400">원</span>
          </div>
          {d.wd > 0 && <p className="mt-0.5 text-center text-xs text-gray-400">{d.wd}일 × {mealDailyLimit.toLocaleString()}</p>}
        </td>
        <td className="px-3 py-2">
          <select value={r.commuteMode} onChange={(e) => patch({ commuteMode: e.target.value as CommuteMode })}
            disabled={!applyCommuteRegulation}
            className="mb-1 w-full rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-xs text-gray-600 focus:outline-none focus:border-blue-400 disabled:text-gray-400">
            {Object.entries(COMMUTE_MODE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <NumInput value={r.commuteRoundtrip} onChange={(v) => patch({ commuteRoundtrip: v, commuteCalc: null })} disabled={!applyCommuteRegulation} />
          {!applyCommuteRegulation && <p className="mt-0.5 text-center text-xs text-gray-400">여비규정 미적용</p>}
          {applyCommuteRegulation && (
            <button type="button" onClick={() => togglePanel(id, 'commute')}
              className="mt-0.5 w-full text-center text-xs text-green-600 hover:underline">
              🚗 자차 산출
            </button>
          )}
        </td>
        <td className="px-3 py-2 text-center">
          {r.commuteMode === 'lodging_return' ? (
            <input type="number" min={0} max={10} value={r.commuteTrips} disabled={!applyCommuteRegulation}
              onChange={(e) => patch({ commuteTrips: e.target.value })}
              className="w-12 rounded border border-gray-300 px-1 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100" />
          ) : (
            <span className="text-xs text-gray-500">{d.wd}일</span>
          )}
        </td>
        <td className="px-3 py-2 text-center font-medium text-blue-700">
          {d.commuteTotal > 0 ? d.commuteTotal.toLocaleString() : '-'}
          {d.commuteTotal > 0 && <p className="text-xs font-normal text-gray-400">×{d.multiplier}{r.commuteMode === 'lodging_return' ? '회' : '일'}</p>}
        </td>
        <td className="px-3 py-2 text-right font-semibold text-gray-800">{d.subtotal > 0 ? d.subtotal.toLocaleString() : '-'}</td>
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={() => togglePanel(id, 'receipt')}
            title="영수증 첨부"
            className={`relative inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              openPanel[id] === 'receipt'
                ? 'bg-blue-100 text-blue-700'
                : fileCount > 0
                  ? 'bg-green-50 text-green-700 hover:bg-green-100'
                  : 'bg-gray-50 text-gray-500 hover:bg-blue-50 hover:text-blue-600'
            }`}
          >
            📎
            {fileCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white text-[10px] font-bold">
                {fileCount}
              </span>
            )}
          </button>
        </td>
      </>
    )
  }

  // 행별 하단 패널 렌더링 (영수증 / 자차산출 / 관리비 내역 / 숙소 계약)
  function RowPanels({ id, isExtra }: { id: string; isExtra: boolean }) {
    const r = getRow(id, isExtra)
    if (!r || !openPanel[id]) return null
    const panel = openPanel[id]
    return (
      <tr>
        <td colSpan={12} className="p-0">
          {panel === 'receipt' && (
            <ReceiptPanel files={receipts[id] ?? []} onChange={(files) => setRowReceipts(id, files)} />
          )}
          {panel === 'commute' && (
            <CommuteCalcPanel
              siteAddress={siteAddress ?? ''}
              isOwnRow={id === myUserId}
              defaultHomeAddress={id === myUserId ? myHomeAddress : undefined}
              defaultFuelType={id === myUserId ? myFuelType : undefined}
              onApply={(params: CommuteApplyParams) => patchRow(id, isExtra, {
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
              })}
            />
          )}
          {panel === 'maint' && (
            <MaintenancePanel items={r.maintItems} onChange={(items) => patchRow(id, isExtra, { maintItems: items })} />
          )}
          {panel === 'lodging' && (
            <LodgingPanel r={r} onChange={(patch) => patchRow(id, isExtra, patch)} />
          )}
        </td>
      </tr>
    )
  }

  function PersonRowItem({ p }: { p: BasePerson }) {
    const id = p.key
    return (
      <>
        <tr className="hover:bg-gray-50">
          <RowCells id={id} r={rows[id]} name={
            <input
              type="text" value={names[id] ?? p.name}
              onChange={(e) => setNames((prev) => ({ ...prev, [id]: e.target.value }))}
              className="w-28 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-gray-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none hover:border-gray-400"
            />
          } />
          <td className="px-1 py-2">
            <button type="button" onClick={() => removePersonRow(id)} title="이번 달 입력에서 제외"
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500">
              ✕
            </button>
          </td>
        </tr>
        <RowPanels id={id} isExtra={false} />
      </>
    )
  }

  function ExtraRowItem({ r }: { r: ExtraRow }) {
    return (
      <>
        <tr className="hover:bg-blue-50 bg-blue-50/30">
          <RowCells id={r.id} r={r} isExtra name={
            <input
              type="text" value={r.name} placeholder="이름 입력"
              onChange={(e) => setExtraRows((p) => p.map((row) => row.id === r.id ? { ...row, name: e.target.value } : row))}
              className="w-20 rounded border border-gray-300 px-2 py-1 text-sm font-medium text-gray-800 focus:border-blue-500 focus:outline-none"
            />
          } />
          <td className="px-1 py-2">
            <button type="button" onClick={() => removeRow(r.id)}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500">
              ✕
            </button>
          </td>
        </tr>
        <RowPanels id={r.id} isExtra />
      </>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-800">{siteName}</h2>
          <p className="text-sm text-gray-500">{year}년 {parseInt(mon)}월 인원별 주재비 정산</p>
        </div>
        <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
          합계 {grandTotal.toLocaleString()}원
        </span>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {success && <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">저장되었습니다. 이동 중...</div>}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[1080px] text-sm">
          <thead className="bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left whitespace-nowrap">성명</th>
              <th className="px-3 py-3 text-center whitespace-nowrap">근무기간</th>
              <th className="px-3 py-3 text-center whitespace-nowrap">근무일수</th>
              <th className="px-3 py-3 text-center whitespace-nowrap w-32">숙소임대비</th>
              <th className="px-3 py-3 text-center w-32">관리비<br/><span className="font-normal text-gray-400">(적용금액·VAT제외)</span></th>
              <th className="px-3 py-3 text-center whitespace-nowrap">식대 <span className="text-blue-600 font-normal">(자동)</span></th>
              <th className="px-3 py-3 text-center w-32">교통비<br/><span className="font-normal text-gray-400">1회 왕복비</span></th>
              <th className="px-3 py-3 text-center whitespace-nowrap">횟수</th>
              <th className="px-3 py-3 text-center whitespace-nowrap">교통비 합계</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">소계</th>
              <th className="px-2 py-3 text-center whitespace-nowrap">영수증</th>
              <th className="px-2 py-3 text-center whitespace-nowrap">삭제</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {activePersons.map((p) => <PersonRowItem key={p.key} p={p} />)}
            {extraRows.map((r) => <ExtraRowItem key={r.id} r={r} />)}
          </tbody>
          <tfoot className="bg-gray-50 text-xs font-semibold text-gray-700">
            <tr>
              <td className="px-4 py-3">합 계</td>
              <td className="px-3 py-3 text-center text-gray-400">—</td>
              <td className="px-3 py-3 text-center text-gray-500">{totalWorkDays}일</td>
              <td className="px-3 py-3 text-right">{fmt(totals.lodgingRent)}</td>
              <td className="px-3 py-3 text-right">{fmt(totals.lodgingMaintenance)}</td>
              <td className="px-3 py-3 text-center text-blue-700">{fmt(totals.meal)}</td>
              <td className="px-3 py-3 text-center text-gray-400">—</td>
              <td className="px-3 py-3 text-center text-gray-400">—</td>
              <td className="px-3 py-3 text-center text-blue-700">{fmt(totals.commute)}</td>
              <td className="px-3 py-3 text-right text-blue-700">{grandTotal.toLocaleString()}</td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <button type="button" onClick={addRow}
        className="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
        + 행 추가
      </button>

      <div className="flex gap-3 pt-2">
        <button type="button" onClick={() => router.back()}
          className="flex-1 rounded-lg border border-gray-300 bg-white py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50">
          취소
        </button>
        <button type="button" onClick={handleSave} disabled={isPending || success}
          className="flex-1 rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          {isPending ? '저장 중...' : '임시저장'}
        </button>
      </div>
    </div>
  )
}
