'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createStaffCosts, type StaffCostRow } from '@/actions/expenses'
import type { Profile, AttendanceRecord } from '@/types'
import { calcWorkDays } from '@/lib/korean-holidays'

interface Props {
  siteId: string
  siteName: string
  yearMonth: string
  users: Profile[]
  attendance: AttendanceRecord[]
}

const MEAL_DAILY = 25000
const COMMUTE_DAILY = 25000
const SPECIALTIES = ['책임', '건축', '토목', '기계', '전기', '통신', '안전'] as const
const ACCEPT = '.jpg,.jpeg,.png,.pdf'
const MAX_FILES = 5
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

function parseNum(v: string) { return parseInt(v.replace(/,/g, ''), 10) || 0 }
function fmt(n: number) { return n > 0 ? n.toLocaleString('ko-KR') : '-' }
function fmtSize(b: number) { return b < 1024 * 1024 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1024 / 1024).toFixed(1)}MB` }

function NumInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <input type="text" inputMode="numeric" value={value}
        onChange={(e) => { const r = e.target.value.replace(/[^0-9]/g, ''); onChange(r ? parseInt(r).toLocaleString('ko-KR') : '') }}
        className="w-full rounded border border-gray-300 px-2 py-1.5 pr-6 text-right text-sm focus:border-blue-500 focus:outline-none" />
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
type Row = { periodStart: string; periodEnd: string; workDays: string; lodgingRent: string; lodgingMaintenance: string; commutePerDay: string; specialty: string }
type ExtraRow = Row & { id: string; name: string }

function makeDefaultRow(yearMonth: string, specialty = '건축'): Row {
  return { periodStart: `${yearMonth}-01`, periodEnd: '', workDays: '0', lodgingRent: '', lodgingMaintenance: '', commutePerDay: COMMUTE_DAILY.toLocaleString('ko-KR'), specialty }
}

let extraIdSeq = 0

// 영수증 패널 컴포넌트
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
      {/* 비목 선택 + 드롭존 */}
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

      {/* 드롭존 */}
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

      {/* 파일 목록 */}
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
              {/* 비목 변경 드롭다운 */}
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

export function StaffCostForm({ siteId, siteName, yearMonth, users, attendance }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const attendanceMap = Object.fromEntries(attendance.map((a) => [a.user_id, a.work_days]))

  const [rows, setRows] = useState<Record<string, Row>>(
    Object.fromEntries(users.map((u, i) => [u.id, {
      ...makeDefaultRow(yearMonth, SPECIALTIES[i % SPECIALTIES.length]),
      workDays: String(attendanceMap[u.id] ?? 0),
    }]))
  )

  const [extraRows, setExtraRows] = useState<ExtraRow[]>([])
  const [names, setNames] = useState<Record<string, string>>(
    Object.fromEntries(users.map((u) => [u.id, u.full_name]))
  )

  // 영수증: 행 id → 파일 목록
  const [receipts, setReceipts] = useState<Record<string, AttachedFile[]>>({})
  // 영수증 패널 열림 상태
  const [openReceipt, setOpenReceipt] = useState<Record<string, boolean>>({})

  function toggleReceipt(id: string) {
    setOpenReceipt((p) => ({ ...p, [id]: !p[id] }))
  }

  function setRowReceipts(id: string, files: AttachedFile[]) {
    setReceipts((p) => ({ ...p, [id]: files }))
  }

  function upd(uid: string, field: keyof Row, val: string) {
    setRows((p) => {
      const updated = { ...p[uid], [field]: val }
      if (field === 'periodStart' || field === 'periodEnd') {
        const start = field === 'periodStart' ? val : updated.periodStart
        const end = field === 'periodEnd' ? val : updated.periodEnd
        updated.workDays = String(calcWorkDays(start, end))
      }
      return { ...p, [uid]: updated }
    })
  }

  function updExtra(id: string, field: keyof ExtraRow, val: string) {
    setExtraRows((p) => p.map((r) => {
      if (r.id !== id) return r
      const updated = { ...r, [field]: val }
      if (field === 'periodStart' || field === 'periodEnd') {
        const start = field === 'periodStart' ? val : r.periodStart
        const end = field === 'periodEnd' ? val : r.periodEnd
        updated.workDays = String(calcWorkDays(start, end))
      }
      return updated
    }))
  }

  function addRow() {
    const id = `extra_${++extraIdSeq}`
    setExtraRows((p) => [...p, { id, name: '', ...makeDefaultRow(yearMonth) }])
  }

  function removeRow(id: string) {
    setExtraRows((p) => p.filter((r) => r.id !== id))
    setReceipts((p) => { const n = { ...p }; delete n[id]; return n })
    setOpenReceipt((p) => { const n = { ...p }; delete n[id]; return n })
  }

  const [year, mon] = yearMonth.split('-')

  // 직종 중복 시 자동 번호 부여
  const allSpecialties: { id: string; sp: string }[] = [
    ...users.map((u) => ({ id: u.id, sp: rows[u.id]?.specialty ?? '' })),
    ...extraRows.map((r) => ({ id: r.id, sp: r.specialty })),
  ]
  const spCount: Record<string, number> = {}
  const spIdx: Record<string, number> = {}
  const spLabels: Record<string, string> = {}
  for (const { sp } of allSpecialties) spCount[sp] = (spCount[sp] ?? 0) + 1
  for (const { id, sp } of allSpecialties) {
    if (spCount[sp] > 1) {
      spIdx[sp] = (spIdx[sp] ?? 0) + 1
      spLabels[id] = `(${sp}${spIdx[sp]})`
    } else {
      spLabels[id] = `(${sp})`
    }
  }

  // 합계
  const totals = [
    ...users.map((u) => rows[u.id]),
    ...extraRows,
  ].reduce((acc, r) => {
    if (!r) return acc
    const wd = parseInt(r.workDays) || 0
    acc.meal += wd * MEAL_DAILY
    acc.commute += parseNum(r.commutePerDay) * wd
    acc.lodgingRent += parseNum(r.lodgingRent)
    acc.lodgingMaintenance += parseNum(r.lodgingMaintenance)
    return acc
  }, { meal: 0, commute: 0, lodgingRent: 0, lodgingMaintenance: 0 })
  const grandTotal = totals.meal + totals.commute + totals.lodgingRent + totals.lodgingMaintenance
  const totalWorkDays = [...users.map((u) => rows[u.id]), ...extraRows].reduce((s, r) => s + (parseInt(r?.workDays ?? '0') || 0), 0)

  function handleSave() {
    setError(null)
    const payload: StaffCostRow[] = [
      ...users.map((u) => {
        const r = rows[u.id]; const wd = parseInt(r.workDays) || 0
        return { rowId: u.id, userId: u.id, userName: names[u.id] ?? u.full_name, workDays: wd, lodgingRent: parseNum(r.lodgingRent), lodgingMaintenance: parseNum(r.lodgingMaintenance), commute: parseNum(r.commutePerDay) * wd, businessTrip: 0 }
      }),
      ...extraRows.map((r) => {
        const wd = parseInt(r.workDays) || 0
        return { rowId: r.id, userId: '', userName: r.name || '(추가)', workDays: wd, lodgingRent: parseNum(r.lodgingRent), lodgingMaintenance: parseNum(r.lodgingMaintenance), commute: parseNum(r.commutePerDay) * wd, businessTrip: 0 }
      }),
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
    const wd = parseInt(r.workDays) || 0
    const meal = wd * MEAL_DAILY
    const commuteTotal = parseNum(r.commutePerDay) * wd
    const subtotal = meal + commuteTotal + parseNum(r.lodgingRent) + parseNum(r.lodgingMaintenance)
    const updFn = isExtra
      ? (field: keyof ExtraRow, val: string) => updExtra(id, field, val)
      : (field: keyof Row, val: string) => upd(id, field, val)
    const fileCount = receipts[id]?.length ?? 0
    return (
      <>
        <td className="px-4 py-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {name}
            <select value={r.specialty} onChange={(e) => updFn('specialty', e.target.value)}
              className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600 focus:outline-none focus:border-blue-400">
              {SPECIALTIES.map((s) => <option key={s} value={s}>({s})</option>)}
            </select>
            <span className="text-xs font-semibold text-blue-600">{spLabels[id]}</span>
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1">
            <input type="date" value={r.periodStart} onChange={(e) => updFn('periodStart', e.target.value)}
              className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
            <span className="text-gray-400 text-xs">~</span>
            <input type="date" value={r.periodEnd} onChange={(e) => updFn('periodEnd', e.target.value)}
              className="rounded border border-gray-300 px-1.5 py-1 text-xs focus:border-blue-500 focus:outline-none" />
          </div>
        </td>
        <td className="px-3 py-2 text-center">
          <input type="number" min={0} max={62} value={r.workDays} onChange={(e) => updFn('workDays', e.target.value)}
            className="w-14 rounded border border-gray-300 px-2 py-1.5 text-center text-sm focus:border-blue-500 focus:outline-none" />
        </td>
        <td className="px-3 py-2"><NumInput value={r.lodgingRent} onChange={(v) => updFn('lodgingRent', v)} /></td>
        <td className="px-3 py-2"><NumInput value={r.lodgingMaintenance} onChange={(v) => updFn('lodgingMaintenance', v)} /></td>
        <td className="px-3 py-2">
          <div className="relative">
            <input readOnly value={meal > 0 ? meal.toLocaleString('ko-KR') : ''} placeholder="0"
              className="w-full rounded border border-blue-200 bg-blue-50 px-2 py-1.5 pr-6 text-right text-sm font-medium text-blue-700 cursor-default" />
            <span className="absolute right-1.5 top-1.5 text-xs text-blue-400">원</span>
          </div>
          {wd > 0 && <p className="mt-0.5 text-center text-xs text-gray-400">{wd}일 × 25,000</p>}
        </td>
        <td className="px-3 py-2"><NumInput value={r.commutePerDay} onChange={(v) => updFn('commutePerDay', v)} /></td>
        <td className="px-3 py-2 text-center font-medium text-blue-700">{commuteTotal > 0 ? commuteTotal.toLocaleString() : '-'}</td>
        <td className="px-3 py-2 text-right font-semibold text-gray-800">{subtotal > 0 ? subtotal.toLocaleString() : '-'}</td>
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={() => toggleReceipt(id)}
            title="영수증 첨부"
            className={`relative inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              openReceipt[id]
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

  // 각 행 id에 대해 tr + 영수증 패널 tr 쌍으로 렌더링
  function UserRow({ u }: { u: Profile }) {
    const id = u.id
    return (
      <>
        <tr className="hover:bg-gray-50">
          <RowCells id={id} r={rows[id]} name={
            <input
              type="text" value={names[id] ?? u.full_name}
              onChange={(e) => setNames((p) => ({ ...p, [id]: e.target.value }))}
              className="w-28 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-medium text-gray-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 focus:outline-none hover:border-gray-400"
            />
          } />
        </tr>
        {openReceipt[id] && (
          <tr>
            <td colSpan={10} className="p-0">
              <ReceiptPanel
                files={receipts[id] ?? []}
                onChange={(files) => setRowReceipts(id, files)}
              />
            </td>
          </tr>
        )}
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
              onChange={(e) => updExtra(r.id, 'name', e.target.value)}
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
        {openReceipt[r.id] && (
          <tr>
            <td colSpan={11} className="p-0">
              <ReceiptPanel
                files={receipts[r.id] ?? []}
                onChange={(files) => setRowReceipts(r.id, files)}
              />
            </td>
          </tr>
        )}
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
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-gray-50 text-xs font-medium text-gray-500">
            <tr>
              <th className="px-4 py-3 text-left whitespace-nowrap">성명</th>
              <th className="px-3 py-3 text-center whitespace-nowrap">근무기간</th>
              <th className="px-3 py-3 text-center whitespace-nowrap">근무일수</th>
              <th className="px-3 py-3 text-center whitespace-nowrap w-32">숙소임대비</th>
              <th className="px-3 py-3 text-center w-32">관리비<br/><span className="font-normal text-gray-400">(전기·가스)</span></th>
              <th className="px-3 py-3 text-center whitespace-nowrap">식대 <span className="text-blue-600 font-normal">(자동)</span></th>
              <th className="px-3 py-3 text-center w-28">교통비<br/><span className="font-normal text-gray-400">원당</span></th>
              <th className="px-3 py-3 text-center whitespace-nowrap">교통비 합계</th>
              <th className="px-3 py-3 text-right whitespace-nowrap">소계</th>
              <th className="px-2 py-3 text-center whitespace-nowrap">영수증</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => <UserRow key={u.id} u={u} />)}
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
              <td className="px-3 py-3 text-center text-blue-700">{fmt(totals.commute)}</td>
              <td className="px-3 py-3 text-right text-blue-700">{grandTotal.toLocaleString()}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 행 추가 버튼 */}
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
