-- 013: 출근부 첨부 모델 — 상주/기술지원 구분 첨부 + 방문일자
--
-- 실무 흐름: 현장이 실제 근무일을 작성한 출근부(서명본)를 스캔해 첨부하고,
-- 그 일수를 시스템에 전기(轉記)한다. 이 일수가 식대·출퇴근교통비 산출과
-- 기술지원 출장비 방문일 검증의 기준이 된다 (정산서 "붙임: 출근부 1부").
--
--  · attendance_sheets : 현장×연월×구분(상주/기술지원) 출근부 첨부 파일
--  · attendance_records.visit_dates : 기술지원 기술인의 방문일자 목록
--    (상주는 work_days 일수만, 기술지원은 방문일 기반 — work_days = 방문일 수)

-- ── 1. 출근부 첨부 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attendance_sheets (
  id          UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id     UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL CHECK (month >= 1 AND month <= 12),
  staff_type  TEXT NOT NULL CHECK (staff_type IN ('resident', 'support')),
  file_urls   TEXT[] NOT NULL DEFAULT '{}',
  uploaded_by UUID REFERENCES public.profiles(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, year, month, staff_type)
);

COMMENT ON TABLE public.attendance_sheets IS '출근부 첨부 — 현장×연월×구분(상주/기술지원). 현장이 작성·서명한 출근부 스캔이 원본 증빙';

DROP TRIGGER IF EXISTS trg_attendance_sheets_updated_at ON public.attendance_sheets;
CREATE TRIGGER trg_attendance_sheets_updated_at
  BEFORE UPDATE ON public.attendance_sheets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_attendance_sheets_site ON public.attendance_sheets(site_id, year, month);

ALTER TABLE public.attendance_sheets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hq_officer: 출근부 첨부 조회" ON public.attendance_sheets;
CREATE POLICY "hq_officer: 출근부 첨부 조회" ON public.attendance_sheets
  FOR SELECT TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer', 'system_admin']));

DROP POLICY IF EXISTS "site_staff: 본인 현장 출근부 첨부 관리" ON public.attendance_sheets;
CREATE POLICY "site_staff: 본인 현장 출근부 첨부 관리" ON public.attendance_sheets
  FOR ALL TO authenticated
  USING (is_site_member(site_id))
  WITH CHECK (is_site_member(site_id));

-- ── 2. 기술지원 방문일자 ────────────────────────────────────────
ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS visit_dates DATE[];

COMMENT ON COLUMN public.attendance_records.visit_dates IS '기술지원 기술인 방문일자 목록 (출근부 기준) — 출장비 방문일 검증용. 상주는 NULL';
