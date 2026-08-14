-- 회차별 비목 계상금액 (산출내역서 기준)
--
-- 왜 새 표인가: settlement_rounds.budgeted_amount는 회차 **총액 하나**뿐이라
-- 「금회 계상 대비 비목별 충족」을 계산할 수 없었다. 대시보드에서 비목 막대의 분모를
-- 계약 잔여로 대신 썼더니 합이 28,800,000이 되어 회차 계상 16,800,000과 어긋났다
-- (「1,680만인데 왜 2,880만?」 — 테스터 지적).
-- settlement_round_items는 **확정 시점 스냅샷**이라 진행 중 회차에는 행이 없다.
-- 그래서 계획값(계상)을 담는 표를 따로 둔다.
--
-- amount 합계 = settlement_rounds.budgeted_amount 가 되어야 하며, 어긋나면 화면에서 알린다.

create table if not exists settlement_round_budgets (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references settlement_rounds(id) on delete cascade,
  category text not null,
  amount bigint not null default 0 check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (round_id, category)
);

create index if not exists settlement_round_budgets_round_idx
  on settlement_round_budgets(round_id);

alter table settlement_round_budgets enable row level security;

-- RLS는 settlement_round_items와 같은 기준 — 본사·관리자는 관리, 현장직원은 소속 현장 조회
create policy "hq_officer: 회차 비목 계상 관리" on settlement_round_budgets
  for all
  using (get_user_role() = any (array['hq_officer', 'system_admin']))
  with check (get_user_role() = any (array['hq_officer', 'system_admin']));

create policy "site_staff: 소속 현장 회차 비목 계상 조회" on settlement_round_budgets
  for select
  using (exists (
    select 1 from settlement_rounds r
    where r.id = settlement_round_budgets.round_id and is_site_member(r.site_id)
  ));
