-- 008: 라이브 DB에만 존재하던 expenses / attendance_records / receipts 테이블 복원
--
-- 배경: expenses·attendance_records는 원격 마이그레이션(003_expenses_schema 등)으로
-- 라이브 DB에 직접 생성되어 리포지토리에 DDL이 없었다. 이 파일은 2026-07-29 시점
-- 라이브 스키마를 introspection해 그대로 옮긴 baseline이다.
-- 라이브 DB에는 no-op(IF NOT EXISTS), 신규 환경에서는 001~007 이후 실행하면 앱 구동에 필요한
-- 전체 스키마가 재현된다.

-- ── RLS 헬퍼 (라이브 DB의 public 스키마 함수 — 002의 auth.* 버전은 라이브에 없음) ──
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.is_site_member(p_site_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_site_assignments
    WHERE user_id = auth.uid()
      AND site_id = p_site_id
      AND is_active = TRUE
  );
$$;

-- ── expenses ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.expenses (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id UUID NOT NULL REFERENCES public.sites(id),
  submitted_by UUID NOT NULL REFERENCES public.profiles(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status = ANY (ARRAY['draft','submitted','approved','rejected'])),
  -- 레거시 컬럼 (구버전 화면 잔재 — 현행 코드는 status/over_limit_amount 사용)
  disallowed_amount BIGINT NOT NULL DEFAULT 0,
  submission_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (submission_status = ANY (ARRAY['draft','submitted'])),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  year_month TEXT,
  headcount INTEGER NOT NULL DEFAULT 1,
  working_days INTEGER,
  is_over_limit BOOLEAN NOT NULL DEFAULT FALSE,
  over_limit_amount BIGINT NOT NULL DEFAULT 0,
  receipt_urls TEXT[] NOT NULL DEFAULT '{}'::text[],
  target_user_name TEXT,
  rejection_reason TEXT,
  deleted_at TIMESTAMPTZ,
  target_user_id UUID REFERENCES public.profiles(id),
  settlement_round_id UUID REFERENCES public.settlement_rounds(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_settlement_round_id ON public.expenses (settlement_round_id);
CREATE INDEX IF NOT EXISTS idx_expenses_target_user_id ON public.expenses (target_user_id);

DROP TRIGGER IF EXISTS update_expenses_updated_at ON public.expenses;
CREATE TRIGGER update_expenses_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hq_officer: 전체 현장 조회" ON public.expenses;
CREATE POLICY "hq_officer: 전체 현장 조회" ON public.expenses
  FOR SELECT
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

DROP POLICY IF EXISTS "site_staff: 본인 현장 draft 관리" ON public.expenses;
CREATE POLICY "site_staff: 본인 현장 draft 관리" ON public.expenses
  FOR ALL TO authenticated
  USING (get_user_role() = 'site_staff' AND is_site_member(site_id) AND submitted_by = auth.uid())
  WITH CHECK (get_user_role() = 'site_staff' AND is_site_member(site_id) AND submitted_by = auth.uid());

DROP POLICY IF EXISTS "system_admin: 전체 관리" ON public.expenses;
CREATE POLICY "system_admin: 전체 관리" ON public.expenses
  FOR ALL TO authenticated
  USING (get_user_role() = 'system_admin')
  WITH CHECK (get_user_role() = 'system_admin');

-- ── attendance_records ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_records (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id UUID NOT NULL REFERENCES public.sites(id),
  user_id UUID NOT NULL REFERENCES public.profiles(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  work_days INTEGER NOT NULL CHECK (work_days >= 0 AND work_days <= 31),
  file_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, user_id, year, month)
);

DROP TRIGGER IF EXISTS update_attendance_updated_at ON public.attendance_records;
CREATE TRIGGER update_attendance_updated_at
  BEFORE UPDATE ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hq_officer: 출근부 조회" ON public.attendance_records;
CREATE POLICY "hq_officer: 출근부 조회" ON public.attendance_records
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));

DROP POLICY IF EXISTS "site_staff: 본인 현장 출근부 관리" ON public.attendance_records;
CREATE POLICY "site_staff: 본인 현장 출근부 관리" ON public.attendance_records
  FOR ALL TO authenticated
  USING (is_site_member(site_id))
  WITH CHECK (is_site_member(site_id));

-- ── receipts (라이브에 존재하는 미사용 테이블 — 스키마 정합성 위해 복원) ──
CREATE TABLE IF NOT EXISTS public.receipts (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id),
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_by UUID REFERENCES public.profiles(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense 소유자: 영수증 관리" ON public.receipts;
CREATE POLICY "expense 소유자: 영수증 관리" ON public.receipts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = receipts.expense_id AND e.submitted_by = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = receipts.expense_id AND e.submitted_by = auth.uid()));

DROP POLICY IF EXISTS "hq_officer: 영수증 조회" ON public.receipts;
CREATE POLICY "hq_officer: 영수증 조회" ON public.receipts
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer','system_admin']));
