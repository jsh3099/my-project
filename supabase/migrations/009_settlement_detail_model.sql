-- 009: 실제 정산서 규정 반영을 위한 상세 모델 (전부 additive — 기존 데이터 영향 없음)
--
-- 설계 원칙: expenses.amount = "적용금액(인정금액)". 회차 집계 RPC(SUM(amount - over_limit_amount)),
-- 잠금, RLS는 그대로 유지하고, 산출 근거를 자식 테이블 + calc_detail JSONB로 분리한다.

-- ── expenses 컬럼 확장 ─────────────────────────────────────────
-- amount_gross : VAT 포함 사용금액 (NULL이면 amount와 동일 취급 — 구모델 행)
-- vat_mode     : 'none' | 'exclude_10' (적용금액 = round(gross ÷ 1.1))
-- period_start/end : 인원별 투입기간 (정산서 세부내역 "기간" 열, 전임/후임 분리 기준)
-- specialty    : 직종 라벨 스냅샷 (책임/건축1/소방2 …)
-- calc_detail  : 항목 유형별 산출 파라미터 스냅샷 (숙소 전월세 환산 등)
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS amount_gross BIGINT,
  ADD COLUMN IF NOT EXISTS vat_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (vat_mode IN ('none', 'exclude_10')),
  ADD COLUMN IF NOT EXISTS period_start DATE,
  ADD COLUMN IF NOT EXISTS period_end DATE,
  ADD COLUMN IF NOT EXISTS specialty TEXT,
  ADD COLUMN IF NOT EXISTS calc_detail JSONB;

-- ── site_parameters 확장 (하드코딩 제거) ────────────────────────
ALTER TABLE public.site_parameters
  ADD COLUMN IF NOT EXISTS trip_daily_allowance INTEGER NOT NULL DEFAULT 25000,
  ADD COLUMN IF NOT EXISTS trip_meal_allowance INTEGER NOT NULL DEFAULT 25000,
  ADD COLUMN IF NOT EXISTS commute_trips_per_month SMALLINT NOT NULL DEFAULT 4
    CHECK (commute_trips_per_month >= 1 AND commute_trips_per_month <= 10);

-- ── expense_items: 건별 사용내역 (실비-VAT제외형 공통) ──────────
-- 관리비(전기·가스 건별 입금) / 사무용품·안전용품·사무기기·통신비·사무실비 / 도서인쇄 / 복리후생 건별
-- 부모 expenses.amount = SUM(amount_applied), amount_gross = SUM(amount_gross) — 서버 액션에서 동기화
CREATE TABLE IF NOT EXISTS public.expense_items (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  item_date DATE NOT NULL,
  vendor TEXT,                       -- 구매처 / 입금처
  description TEXT NOT NULL,         -- 구매내용 (예: "전기세(일반)", "사무용품(종이컵)")
  tag TEXT,                          -- 복리후생 구분(식대/음료), 관리비 구분(전기/가스) 등
  amount_gross BIGINT NOT NULL CHECK (amount_gross >= 0),
  amount_applied BIGINT NOT NULL CHECK (amount_applied >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expense_items_expense_id ON public.expense_items (expense_id);

-- ── commute_calcs: 상주기술인 교통비 월별 산출 (expense 1:1) ─────
-- mode: lodging_return(숙박형 — 왕복비 × 월횟수) | daily_commute(출퇴근형 — 왕복비 × 근무일수)
CREATE TABLE IF NOT EXISTS public.commute_calcs (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  expense_id UUID NOT NULL UNIQUE REFERENCES public.expenses(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('lodging_return', 'daily_commute')),
  home_address TEXT,
  distance_oneway_km NUMERIC(8,1) NOT NULL CHECK (distance_oneway_km >= 0),
  fuel_type TEXT NOT NULL,
  fuel_efficiency NUMERIC(6,2) NOT NULL,   -- 연비 스냅샷 (규정 개정 대비)
  fuel_price INTEGER NOT NULL,             -- 유가 (원/L 등)
  fuel_price_date DATE,                    -- opinet 고시 기준일
  fuel_cost_roundtrip INTEGER NOT NULL,    -- 1회 왕복 유류비
  toll_roundtrip INTEGER NOT NULL DEFAULT 0,
  multiplier SMALLINT NOT NULL CHECK (multiplier >= 0),  -- 월횟수 또는 근무일수
  map_capture_url TEXT,                    -- 지도 경로 캡처 (수동 업로드)
  total BIGINT NOT NULL,                   -- (fuel_cost_roundtrip + toll_roundtrip) × multiplier
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── trip_visits: 기술지원 기술인 출장 방문일별 기록 (expense 1:N) ─
-- 부모 expense: category='business_trip', subcategory='support_trip' (월별·인원별 1행)
CREATE TABLE IF NOT EXISTS public.trip_visits (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  origin_address TEXT,                     -- 출발지 (본사/자택)
  distance_oneway_km NUMERIC(8,1) NOT NULL CHECK (distance_oneway_km >= 0),
  fuel_type TEXT NOT NULL,
  fuel_efficiency NUMERIC(6,2) NOT NULL,
  fuel_price INTEGER NOT NULL,             -- 방문일 기준 유가
  fuel_price_date DATE,
  fuel_cost INTEGER NOT NULL,              -- 왕복 유류비
  toll INTEGER NOT NULL DEFAULT 0,
  daily_allowance INTEGER NOT NULL DEFAULT 25000,  -- 일비
  meal_allowance INTEGER NOT NULL DEFAULT 25000,   -- 식비
  total INTEGER NOT NULL,                  -- 유류비 + 통행료 + 일비 + 식비
  map_capture_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_visits_expense_id ON public.trip_visits (expense_id);

-- ── welfare_settlements: 복리후생비 월별 정산기준 (expense 1:1) ──
-- 인정금액 = min(상주인원 × 월한도, 증빙금액(VAT제외 합))
-- 부모 expense: amount = evidence_amount(증빙 전체), over_limit_amount = evidence - approved
-- → 회차 집계식 SUM(amount - over_limit_amount)의 결과가 인정금액이 된다
CREATE TABLE IF NOT EXISTS public.welfare_settlements (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  expense_id UUID NOT NULL UNIQUE REFERENCES public.expenses(id) ON DELETE CASCADE,
  resident_headcount SMALLINT NOT NULL CHECK (resident_headcount >= 0),
  monthly_limit INTEGER NOT NULL,          -- 파라미터 스냅샷 (1인 1월 한도)
  computed_amount BIGINT NOT NULL,         -- 산출금액 = 인원 × 한도
  evidence_amount BIGINT NOT NULL,         -- 증빙금액 = 건별 VAT제외 합
  approved_amount BIGINT NOT NULL,         -- 인정금액 = min(산출, 증빙)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── company_profile: 정산서 총괄표 「1. 계약내용」 회사 정보 (단일행) ──
CREATE TABLE IF NOT EXISTS public.company_profile (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- 단일행 강제
  company_name TEXT NOT NULL,
  representative TEXT NOT NULL,            -- 대표자
  address TEXT NOT NULL,                   -- 소재지
  stamp_image_url TEXT,                    -- 도장 이미지
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── RLS: 자식 테이블은 부모 expense 접근 권한을 그대로 따른다 ─────
ALTER TABLE public.expense_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commute_calcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welfare_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_profile ENABLE ROW LEVEL SECURITY;

-- expense_items
DROP POLICY IF EXISTS "expense 소유자: 건별내역 관리" ON public.expense_items;
CREATE POLICY "expense 소유자: 건별내역 관리" ON public.expense_items
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_items.expense_id AND e.submitted_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_items.expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "hq: 건별내역 조회" ON public.expense_items;
CREATE POLICY "hq: 건별내역 조회" ON public.expense_items
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

-- commute_calcs
DROP POLICY IF EXISTS "expense 소유자: 교통비산출 관리" ON public.commute_calcs;
CREATE POLICY "expense 소유자: 교통비산출 관리" ON public.commute_calcs
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = commute_calcs.expense_id AND e.submitted_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = commute_calcs.expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "hq: 교통비산출 조회" ON public.commute_calcs;
CREATE POLICY "hq: 교통비산출 조회" ON public.commute_calcs
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

-- trip_visits
DROP POLICY IF EXISTS "expense 소유자: 출장방문 관리" ON public.trip_visits;
CREATE POLICY "expense 소유자: 출장방문 관리" ON public.trip_visits
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = trip_visits.expense_id AND e.submitted_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = trip_visits.expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "hq: 출장방문 조회" ON public.trip_visits;
CREATE POLICY "hq: 출장방문 조회" ON public.trip_visits
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

-- welfare_settlements
DROP POLICY IF EXISTS "expense 소유자: 복리후생정산 관리" ON public.welfare_settlements;
CREATE POLICY "expense 소유자: 복리후생정산 관리" ON public.welfare_settlements
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = welfare_settlements.expense_id AND e.submitted_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = welfare_settlements.expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "hq: 복리후생정산 조회" ON public.welfare_settlements;
CREATE POLICY "hq: 복리후생정산 조회" ON public.welfare_settlements
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

-- company_profile: 전체 로그인 사용자 조회, hq/admin만 수정
DROP POLICY IF EXISTS "회사정보 조회" ON public.company_profile;
CREATE POLICY "회사정보 조회" ON public.company_profile
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "hq: 회사정보 관리" ON public.company_profile;
CREATE POLICY "hq: 회사정보 관리" ON public.company_profile
  FOR ALL TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']))
  WITH CHECK (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));
