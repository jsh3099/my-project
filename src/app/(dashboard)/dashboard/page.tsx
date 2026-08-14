import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PlusCircle, Send, AlertTriangle, CalendarRange, Wallet } from 'lucide-react'
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from '@/lib/constants'
import { calcClaim } from '@/lib/settlement'
import { SiteAddressCard } from '@/components/sites/SiteAddressCard'
import { SiteSelect } from '@/components/expenses/ExpenseFilters'
import type { Site, SettlementRound, SettlementRoundItem } from '@/types'

// 대시보드는 「요약 화면」이다 — 계약 하나를 금액축(KPI 4장)과 시간축(회차 타임라인)으로
// 한 번에 보여준다. 종전엔 「이번 달 · 본인」 기준이라 회차·현장 단위인 나머지 화면과
// 숫자가 어긋났고(주재비·출장비는 회차 단위 계산이라 마지막 달에 몰려 저장된다),
// 배정 현장을 모두 합산해 한 현장의 초과가 다른 현장의 미충당을 가렸다.
// 삭감은 현장 단위로 발생하므로 다른 화면과 같은 현장 선택기를 두고 한 현장씩 본다.

const CATEGORY_KEYS = Object.keys(EXPENSE_CATEGORY_LABELS) as ExpenseCategory[]

// 비목 색 — 현장경비 입력 화면(SiteExpenseBoard)의 카드 색과 같은 계열로 맞춘다
const CATEGORY_BAR: Record<ExpenseCategory, string> = {
  site_residence: 'bg-indigo-500',
  vehicle: 'bg-blue-500',
  business_trip: 'bg-teal-500',
  local_staff: 'bg-rose-400',
  printing: 'bg-emerald-500',
}

const won = (n: number) => n.toLocaleString('ko-KR')
const eok = (n: number) => `${(n / 100_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}억`

const DAY = 86_400_000
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const daysBetween = (from: string, to: string) => Math.round((dayOf(to) - dayOf(from)) / DAY)
const addDays = (iso: string, n: number) => new Date(dayOf(iso) + n * DAY).toISOString().slice(0, 10)

/** 남은 기간을 「N개월 N일」로 — 일수만 보여주면 규모가 안 읽힌다 */
function humanSpan(days: number): string {
  if (days <= 0) return '종료'
  const m = Math.floor(days / 30)
  const d = days - m * 30
  return m > 0 ? `${m}개월 ${d}일` : `${d}일`
}

type Segment = { kind: 'done' | 'now' | 'idle'; label: string; amount: string; days: number; title: string }

/** 계약기간을 회차별 기간 비율로 나눈다 — 회차가 안 잡힌 구간도 그대로 드러내야
 *  「기간은 남았는데 계상은 다 배정됐다」 같은 상태가 보인다 */
function buildTimeline(site: Site, rounds: SettlementRound[], openClaim: number): Segment[] {
  const start = site.contract_start
  const end = site.contract_end
  if (!start || !end) return []
  const segs: Segment[] = []
  let cursor = start
  for (const r of rounds) {
    const from = r.period_start < cursor ? cursor : r.period_start
    const to = r.period_end > end ? end : r.period_end
    if (daysBetween(from, to) < 0) continue
    if (daysBetween(cursor, from) > 0) {
      segs.push({ kind: 'idle', label: '미개시', amount: humanSpan(daysBetween(cursor, from)), days: daysBetween(cursor, from), title: `${cursor} ~ ${addDays(from, -1)} — 회차 없음` })
    }
    const isOpen = r.status === 'open'
    // 진행 중 회차의 claim_amount는 확정 시 채워지므로 지금은 0이다 —
    // 타임라인에 0억으로 찍히면 "아무것도 안 썼다"로 읽히므로 잠정 기성을 쓴다
    segs.push({
      kind: isOpen ? 'now' : 'done',
      label: `${r.round_no}회차${isOpen ? ' 진행중' : ''}`,
      amount: isOpen && r.budgeted_amount ? `${eok(openClaim)} / ${eok(r.budgeted_amount)}` : eok(r.claim_amount),
      days: Math.max(1, daysBetween(from, to) + 1),
      title: `${r.round_no}회차 ${r.period_start} ~ ${r.period_end}`,
    })
    cursor = addDays(to, 1)
  }
  if (daysBetween(cursor, end) >= 0) {
    const days = daysBetween(cursor, end) + 1
    segs.push({ kind: 'idle', label: '미개시', amount: humanSpan(days), days, title: `${cursor} ~ ${end} — 회차 없음` })
  }
  return segs
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const { data: profile } = await supabase
    .from('profiles').select('full_name').eq('id', user.id).single()

  const { data: assignments } = await supabase
    .from('user_site_assignments')
    .select('site_id, sites(id, name, address, direct_expense_budget, contract_start, contract_end, status)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  const sites = (assignments?.map((a) => a.sites).filter(Boolean) ?? []) as unknown as Site[]
  const siteId = params.site ?? sites[0]?.id ?? ''
  const site = sites.find((s) => s.id === siteId)

  if (!site) {
    return (
      <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-yellow-500" />
        <p className="font-medium text-yellow-800">배정된 현장이 없습니다</p>
        <p className="mt-1 text-sm text-yellow-600">시스템 관리자에게 현장 배정을 요청하세요.</p>
      </div>
    )
  }

  const admin = createAdminClient()
  const [{ data: roundsData }, { data: budgetRows }] = await Promise.all([
    supabase.from('settlement_rounds').select('*').eq('site_id', siteId).order('round_no'),
    supabase.from('site_expense_budgets').select('category, amount').eq('site_id', siteId),
  ])
  const rounds = (roundsData ?? []) as SettlementRound[]
  const openRound = rounds.find((r) => r.status === 'open') ?? null
  const confirmedRounds = rounds.filter((r) => r.status === 'confirmed')
  const priorCumulative = confirmedRounds.reduce((s, r) => s + r.claim_amount, 0)

  const budgetByCategory = new Map<string, number>()
  for (const b of budgetRows ?? []) {
    budgetByCategory.set(b.category, (budgetByCategory.get(b.category) ?? 0) + b.amount)
  }

  // 항목별 전회 누계 — 확정 시점 스냅샷이 원천 (계상금액이 나중에 바뀌어도 과거가 흔들리지 않는다)
  const priorClaimByCategory = new Map<string, number>()
  if (confirmedRounds.length > 0) {
    const { data: itemRows } = await supabase
      .from('settlement_round_items')
      .select('category, claim_amount')
      .in('round_id', confirmedRounds.map((r) => r.id))
    for (const row of (itemRows ?? []) as Pick<SettlementRoundItem, 'category' | 'claim_amount'>[]) {
      priorClaimByCategory.set(row.category, (priorClaimByCategory.get(row.category) ?? 0) + row.claim_amount)
    }
  }

  // 금회 사용액 — 확정 편입 기준과 같게 제출분만 센다. 미제출분은 아래에서 따로 알린다.
  const usedByCategory = new Map<string, number>()
  // 회차별 비목 계상 (산출내역서 기준) — settlement_rounds.budgeted_amount는 총액 하나뿐이라
  // 「금회 계상 대비 비목별 충족」은 이 표가 없으면 계산할 수 없다
  const roundBudgetByCategory = new Map<string, number>()
  let unsubmittedCount = 0
  let unsubmittedAmount = 0
  if (openRound) {
    const [{ data: sent }, { data: drafts }, { data: rbRows }] = await Promise.all([
      admin.from('expenses').select('category, amount, over_limit_amount')
        .eq('site_id', siteId).in('status', ['submitted', 'approved'])
        .is('settlement_round_id', null).is('deleted_at', null)
        .gte('expense_date', openRound.period_start).lte('expense_date', openRound.period_end),
      admin.from('expenses').select('amount, over_limit_amount')
        .eq('site_id', siteId).eq('status', 'draft')
        .is('settlement_round_id', null).is('deleted_at', null)
        .gte('expense_date', openRound.period_start).lte('expense_date', openRound.period_end),
      supabase.from('settlement_round_budgets').select('category, amount').eq('round_id', openRound.id),
    ])
    for (const b of rbRows ?? []) roundBudgetByCategory.set(b.category, b.amount)
    for (const e of sent ?? []) {
      usedByCategory.set(e.category, (usedByCategory.get(e.category) ?? 0) + (e.amount - e.over_limit_amount))
    }
    unsubmittedCount = (drafts ?? []).length
    unsubmittedAmount = (drafts ?? []).reduce((s, e) => s + (e.amount - e.over_limit_amount), 0)
  }

  const claim = calcClaim({
    totalBudget: site.direct_expense_budget,
    priorClaimTotal: priorCumulative,
    items: CATEGORY_KEYS.map((category) => ({
      category,
      contractAmount: budgetByCategory.get(category) ?? 0,
      priorCumulative: priorClaimByCategory.get(category) ?? 0,
      usedAmount: usedByCategory.get(category) ?? 0,
    })),
  })

  // ── KPI 4장은 전부 금액 — 더하고 빼면 맞아떨어져 그 자리에서 검산된다.
  //    기간은 KPI가 아니라 타임라인이 담당한다(금액축·시간축 분리).
  const roundBudget = openRound?.budgeted_amount ?? 0
  const remainingAfterRound = site.direct_expense_budget - priorCumulative - roundBudget
  // 비목별 계상 합이 회차 계상금액과 어긋나면 화면에서 알린다 — 둘은 따로 입력되는 값이라
  // 한쪽만 고치면 조용히 벌어진다(입력 폼이 붙기 전에는 특히)
  const roundBudgetSum = [...roundBudgetByCategory.values()].reduce((s, v) => s + v, 0)

  const today = new Date().toISOString().slice(0, 10)
  const daysToContractEnd = site.contract_end ? daysBetween(today, site.contract_end) : null
  const daysToRoundEnd = openRound ? daysBetween(today, openRound.period_end) : null
  const contractMonths = site.contract_start && site.contract_end
    ? Math.round(daysBetween(site.contract_start, site.contract_end) / 30.44)
    : null

  const timeline = buildTimeline(site, rounds, claim.claimTotal)
  const totalDays = timeline.reduce((s, t) => s + t.days, 0)
  const shortfall = roundBudget > 0 ? roundBudget - claim.usedTotal : 0

  return (
    <div className="space-y-4">
      {/* 헤더 — 현장 선택 + 계약 한 줄 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          {/* 사이드바 라벨(「현장 요약」)과 같은 말을 쓴다 — 메뉴와 화면 제목이 다르면 같은 화면인지 확신하지 못한다 */}
          {/* 현장명은 낫표로 묶는다 — 「도매시장 5회차」처럼 이름에 회차가 든 현장이 있어
              따옴표가 없으면 "5회차의 요약"으로 읽힌다(이 화면엔 실제 진행 회차가 따로 있다) */}
          <h1 className="text-xl font-bold text-gray-900">{profile?.full_name}님, 「{site.name}」 현장 요약입니다</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {site.contract_start && site.contract_end && (
              <>총 용역기간 <b className="text-gray-700 tabular-nums">{site.contract_start} ~ {site.contract_end}</b>
                {contractMonths !== null && ` (${contractMonths}개월)`} · </>
            )}
            직접경비 계상총액 <b className="text-gray-700 tabular-nums">{won(site.direct_expense_budget)}원</b>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {sites.length > 1 && <SiteSelect sites={sites} selectedSiteId={siteId} basePath="/dashboard" />}
          <Link href="/expenses/new"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
            <PlusCircle className="h-4 w-4" />
            비용 입력
          </Link>
        </div>
      </div>

      {/* KPI 4장 (전부 금액) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="직접경비 계상총액" value={won(site.direct_expense_budget)} sub="계약 전체" />
        <Kpi label="누계 기성" value={won(priorCumulative)}
          sub={`${confirmedRounds.length}회 확정${site.direct_expense_budget > 0 ? ` · 계상의 ${Math.round((priorCumulative / site.direct_expense_budget) * 1000) / 10}%` : ''}`} />
        <Kpi accent label={openRound ? `금회 계상 (${openRound.round_no}회차)` : '금회 계상'}
          value={roundBudget > 0 ? won(roundBudget) : '-'}
          sub={roundBudget > 0 ? '이번 회차에 증빙으로 채워야 할 금액' : '진행 중 회차 없음'} />
        <Kpi label="잔여 정산금액" value={won(remainingAfterRound)}
          sub={remainingAfterRound <= 0
            ? `누계·금회를 빼면 남지 않습니다 — ${openRound ? `${openRound.round_no}회차가 마지막 회차` : '계상 소진'}`
            : '금회 이후 남는 계상'} />
      </div>

      {/* 회차 타임라인 */}
      {timeline.length > 0 && totalDays > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-100 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <CalendarRange className="h-4 w-4 text-blue-500" />
              회차 타임라인
            </h2>
            <span className="text-xs text-gray-500">
              {daysToContractEnd !== null && <>계약 종료까지 <b className="text-gray-700">{humanSpan(daysToContractEnd)}</b></>}
              {daysToRoundEnd !== null && <> · 금회 회차 종료까지 <b className="text-gray-700">{humanSpan(daysToRoundEnd)}</b></>}
            </span>
          </div>
          <div className="px-5 py-4">
            <div className="flex h-12 overflow-hidden rounded-lg border border-gray-200">
              {timeline.map((t, i) => (
                <div key={i} title={t.title} style={{ flexGrow: t.days }}
                  className={`grid place-content-center gap-0.5 px-1 text-center text-[11px] leading-tight ${
                    t.kind === 'now'
                      ? 'bg-green-600 font-bold text-white ring-2 ring-inset ring-green-300'
                      : t.kind === 'done'
                        ? (i % 2 === 0 ? 'bg-blue-600 text-white' : 'bg-blue-700 text-white')
                        : 'bg-gray-200 text-gray-500'
                  }`}>
                  <span className="truncate font-semibold">{t.label}</span>
                  <span className="truncate opacity-90 tabular-nums">{t.amount}</span>
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-gray-400 tabular-nums">
              <span>{site.contract_start}</span>
              <span>오늘 {today}</span>
              <span>{site.contract_end}</span>
            </div>
          </div>
        </section>
      )}

      {/* 차수별 정산 내역 */}
      {rounds.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Wallet className="h-4 w-4 text-blue-500" />
              차수별 정산 내역
            </h2>
          </div>
          <div className="overflow-x-auto px-5 py-3">
            <table className="w-full min-w-[620px] text-xs tabular-nums">
              <thead>
                <tr className="border-b border-gray-200 text-[11px] text-gray-400">
                  <th className="py-2 text-left font-medium">회차</th>
                  <th className="py-2 text-left font-medium">정산기간</th>
                  <th className="py-2 text-right font-medium">금회 계상</th>
                  <th className="py-2 text-right font-medium">금회 기성</th>
                  <th className="py-2 text-right font-medium">누계 기성</th>
                  <th className="py-2 text-center font-medium">상태</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rounds.map((r) => {
                  const isOpen = r.status === 'open'
                  const amount = isOpen ? claim.claimTotal : r.claim_amount
                  const cum = isOpen ? priorCumulative + claim.claimTotal : r.prior_cumulative_amount + r.claim_amount
                  return (
                    <tr key={r.id} className={isOpen ? 'bg-green-50/60' : ''}>
                      <td className="py-2 text-left font-medium text-gray-800">{r.round_no}회차</td>
                      <td className="py-2 text-left text-gray-600">{r.period_start} ~ {r.period_end}</td>
                      <td className="py-2 text-right text-gray-600">{r.budgeted_amount ? won(r.budgeted_amount) : '-'}</td>
                      <td className="py-2 text-right font-semibold text-gray-900">
                        {won(amount)}{isOpen && <span className="ml-1 text-[10px] font-normal text-gray-400">잠정</span>}
                      </td>
                      <td className="py-2 text-right text-gray-600">{won(cum)}</td>
                      <td className="py-2 text-center">
                        <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${
                          isOpen ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                        }`}>{isOpen ? '진행 중' : '확정'}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 진행 중 회차 — 비목별 채움 */}
      {openRound && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-baseline gap-x-3 border-b border-gray-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-700">진행 중 {openRound.round_no}회차</h2>
            <span className="text-xs text-gray-500 tabular-nums">
              {openRound.period_start} ~ {openRound.period_end}
              {daysToRoundEnd !== null && ` · 종료까지 ${humanSpan(daysToRoundEnd)}`}
            </span>
          </div>
          <div className="grid gap-x-8 gap-y-1.5 px-5 py-4 text-sm sm:grid-cols-2">
            <Fact k="금회 계상금액" v={`${won(roundBudget)}원`} />
            <Fact k="금회 사용액 (제출분)" v={`${won(claim.usedTotal)}원`} />
            <Fact k="금회 기성금액 (잠정)" v={`${won(claim.claimTotal)}원`} />
            <Fact k="미충당 — 삭감 예상" v={`${won(Math.max(0, shortfall))}원`} bad={shortfall > 0} />
          </div>
          {/* 금회 사용액의 비목별 구성 — 분모를 금회 사용액으로 두어 합이 위 「금회 사용액」과
              정확히 맞는다. 진행 중 회차에는 비목별 계상이 없으므로(settlement_rounds는
              budgeted_amount 총액 하나뿐, 비목별 스냅샷은 확정 시 생김) 「계상 대비」로는
              만들 수 없다 — 계약 기준 잔여를 분모로 쓰면 합이 2,880만이 되어 금회 계상
              1,680만과 어긋난다(실제 오독). 계약 대비 채움은 아래 별도 블록이 담당한다. */}
          {roundBudgetByCategory.size > 0 && (
            <div className="border-t border-gray-100 px-5 py-4">
              <p className="mb-3 text-xs text-gray-500">
                금회 계상 대비 비목별 충족 — 계상 합계{' '}
                <b className="text-gray-700 tabular-nums">{won(roundBudgetSum)}원</b>
                {roundBudgetSum !== roundBudget && (
                  <span className="ml-1 text-amber-600">
                    (회차 계상금액 {won(roundBudget)}원과 다릅니다 — 비목별 금액을 확인하세요)
                  </span>
                )}
              </p>
              <div className="space-y-3.5">
                {CATEGORY_KEYS
                  .filter((c) => (roundBudgetByCategory.get(c) ?? 0) > 0 || (usedByCategory.get(c) ?? 0) > 0)
                  .map((c) => {
                    const plan = roundBudgetByCategory.get(c) ?? 0
                    const used = usedByCategory.get(c) ?? 0
                    const gap = plan - used            // 양수 = 미충당, 음수 = 초과
                    // 100%로 자르지 않는다 — 초과를 100%로 보이면 「정확히 채웠다」로 읽혀
                    // 초과분이 총액에서 흡수된다는 사실이 사라진다. 막대만 100%에서 멈춘다.
                    const pct = plan > 0 ? Math.round((used / plan) * 100) : (used > 0 ? 100 : 0)
                    const short = gap > 0
                    return (
                      <div key={c}>
                        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
                          <span className="font-semibold text-gray-700">{EXPENSE_CATEGORY_LABELS[c]}</span>
                          <span className="text-gray-500 tabular-nums">
                            {won(used)} / {won(plan)}
                            <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold ${
                              short ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-700'
                            }`}>{short ? `${pct}%` : `충족 ${pct}%`}</span>
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-gray-100">
                          <div className={`h-2 rounded-full ${short ? 'bg-red-400' : CATEGORY_BAR[c]}`}
                            style={{ width: `${Math.min(100, pct)}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] text-gray-400 tabular-nums">
                          {gap < 0
                            ? `초과 ${won(-gap)}원 — 직접경비 총액 내에서 흡수`
                            : short
                              ? `미충당 ${won(gap)}원 — 증빙이 없으면 삭감`
                              : '계상과 정확히 일치'}
                        </p>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {/* 미제출분 — 위 금액은 제출분만 센다 */}
          {unsubmittedCount > 0 && (
            <div className="mx-5 mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              📮 임시저장 {unsubmittedCount}건 · <b className="tabular-nums">{won(unsubmittedAmount)}원</b>이 아직 제출되지 않았습니다 —
              위 금액은 <b>제출분만</b> 집계하므로 빠져 있습니다.{' '}
              <Link href="/expenses" className="font-semibold underline hover:text-amber-900">본사 제출로 이동</Link>
            </div>
          )}
          {shortfall > 0 && (
            <div className="mx-5 mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              금회 계상금액 {won(roundBudget)}원 중 증빙으로 채우지 못한{' '}
              <b className="tabular-nums">{won(shortfall)}원이 삭감 후 지급될 예정</b>입니다 —
              사용한 비용을 빠짐없이 입력·제출해 계상금액을 채워주세요.
            </div>
          )}
        </section>
      )}

      {/* 비목별 계상 채움 — 계약 전체 기준.
          「기성회차 현황」의 채움률과 같은 식(계상 − 잔액)/계상을 쓴다. 기준이 다르면
          같은 비목이 두 화면에서 다른 %로 보여 어느 쪽이 맞는지 알 수 없게 된다. */}
      {claim.items.some((i) => i.contractAmount > 0) && (
        <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-baseline gap-x-3 border-b border-gray-100 px-5 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Wallet className="h-4 w-4 text-blue-500" />
              비목별 계상 채움 현황
            </h2>
            <span className="text-xs text-gray-500">계약 전체 기준 — 누계기성 + 금회기성(잠정)</span>
          </div>
          <div className="space-y-3.5 px-5 py-4">
            {claim.items
              .filter((i) => i.contractAmount > 0)
              .map((i) => {
                const filledAmount = i.priorCumulative + i.claimAmount
                // 100%로 자르지 않는다 — 초과를 100%로 표시하면 「정확히 채웠다」로 읽혀
                // 초과분이 총액에서 흡수된다는 사실이 사라진다. 막대만 100%에서 멈춘다.
                const pct = Math.round((filledAmount / i.contractAmount) * 1000) / 10
                const short = i.remaining > 0
                return (
                  <div key={i.category}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
                      <span className="font-semibold text-gray-700">
                        {EXPENSE_CATEGORY_LABELS[i.category as ExpenseCategory]}
                      </span>
                      <span className="text-gray-500 tabular-nums">
                        {won(filledAmount)} / {won(i.contractAmount)}
                        <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold ${
                          short ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-700'
                        }`}>{short ? `${pct}%` : `충족 ${pct}%`}</span>
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-100">
                      <div className={`h-2 rounded-full ${short ? 'bg-red-400' : 'bg-blue-500'}`}
                        style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-gray-400 tabular-nums">
                      {i.remaining < 0
                        ? `초과 ${won(-i.remaining)}원 — 직접경비 총액 내에서 흡수되어 정상 지급`
                        : short
                          ? `미충당 ${won(i.remaining)}원 — 계약기간 내 증빙으로 채우지 못하면 삭감`
                          : '계상과 정확히 일치'}
                    </p>
                  </div>
                )
              })}
          </div>
        </section>
      )}

      {/* 빠른 이동 */}
      <div className="grid grid-cols-2 gap-3">
        <Quick href="/expenses/new" icon={<PlusCircle className="h-5 w-5" />}
          title="비용 입력" desc="영수증 업로드 · 자동 인식" tone="blue" />
        <Quick href="/expenses" icon={<Send className="h-5 w-5" />}
          title="본사 제출" desc="월별 내역 확인 · 회차 전체 제출" tone="gray" />
      </div>

      {/* 현장 정보 — 자주 바뀌지 않으므로 접어 둔다 (교통비·출장비 산출의 현장주소 단일 입력 지점) */}
      <details className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <summary className="cursor-pointer px-5 py-3 text-sm font-semibold text-gray-700">
          현장 정보 — 주소 (교통비·출장비 산출에 사용)
        </summary>
        <div className="border-t border-gray-100 p-4">
          <SiteAddressCard siteId={site.id} siteName={site.name} address={site.address ?? ''} />
        </div>
      </details>
    </div>
  )
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${accent ? 'border-blue-200 bg-blue-50' : 'border-gray-200 bg-white'}`}>
      <p className="text-[11.5px] text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accent ? 'text-blue-700' : 'text-gray-900'}`}>{value}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{sub}</p>
    </div>
  )
}

function Fact({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-dashed border-gray-100 pb-1.5 last:border-b-0">
      <span className="text-gray-500">{k}</span>
      <span className={`font-semibold tabular-nums ${bad ? 'text-red-600' : 'text-gray-900'}`}>{v}</span>
    </div>
  )
}

function Quick({ href, icon, title, desc, tone }: {
  href: string; icon: React.ReactNode; title: string; desc: string; tone: 'blue' | 'gray'
}) {
  const cls = tone === 'blue'
    ? 'border-blue-300 bg-blue-50 text-blue-700 hover:border-blue-400 hover:bg-blue-100'
    : 'border-gray-300 bg-gray-50 text-gray-700 hover:border-gray-400 hover:bg-gray-100'
  return (
    <Link href={href} className={`flex items-center gap-3 rounded-xl border-2 border-dashed p-4 transition ${cls}`}>
      {icon}
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-[11px] opacity-70">{desc}</p>
      </div>
    </Link>
  )
}
