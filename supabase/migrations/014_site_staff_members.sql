-- 014: 현장 기술인 명부 (site_staff_members)
--
-- 정산 대상 기술인(상주·기술지원)은 대부분 시스템 로그인 계정이 없다
-- (예본: 상주 13명·기술지원 5명). 출근부 화면에서 바로 추가하는 명부를 두고,
-- 출근부(attendance_records)가 계정(user_id) 또는 명부(member_id) 어느 쪽이든
-- 참조할 수 있게 한다.

CREATE TABLE IF NOT EXISTS public.site_staff_members (
  id         UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  site_id    UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  specialty  TEXT,                      -- 직종 (책임/건축/토목/…, 자유 입력 허용)
  staff_type TEXT NOT NULL CHECK (staff_type IN ('resident', 'support')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.site_staff_members IS '현장 기술인 명부 — 로그인 계정이 없는 상주/기술지원 기술인. 출근부·정산 인원의 원천';

DROP TRIGGER IF EXISTS trg_site_staff_members_updated_at ON public.site_staff_members;
CREATE TRIGGER trg_site_staff_members_updated_at
  BEFORE UPDATE ON public.site_staff_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_site_staff_members_site ON public.site_staff_members(site_id, staff_type, is_active);

ALTER TABLE public.site_staff_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hq_officer: 기술인 명부 관리" ON public.site_staff_members;
CREATE POLICY "hq_officer: 기술인 명부 관리" ON public.site_staff_members
  FOR ALL TO authenticated
  USING (get_user_role() = ANY (ARRAY['hq_officer', 'system_admin']))
  WITH CHECK (get_user_role() = ANY (ARRAY['hq_officer', 'system_admin']));

DROP POLICY IF EXISTS "site_staff: 본인 현장 기술인 명부 관리" ON public.site_staff_members;
CREATE POLICY "site_staff: 본인 현장 기술인 명부 관리" ON public.site_staff_members
  FOR ALL TO authenticated
  USING (is_site_member(site_id))
  WITH CHECK (is_site_member(site_id));

-- ── 출근부가 명부 인원도 참조할 수 있도록 ──────────────────────────
ALTER TABLE public.attendance_records
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES public.site_staff_members(id) ON DELETE CASCADE;

-- 계정 또는 명부 중 정확히 하나를 참조
ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS chk_attendance_person;
ALTER TABLE public.attendance_records
  ADD CONSTRAINT chk_attendance_person
  CHECK ((user_id IS NOT NULL AND member_id IS NULL) OR (user_id IS NULL AND member_id IS NOT NULL));

-- 명부 인원용 유니크 (user_id NULL 행은 기존 (site,user,year,month) 유니크에 걸리지 않음)
ALTER TABLE public.attendance_records
  DROP CONSTRAINT IF EXISTS uq_attendance_member;
ALTER TABLE public.attendance_records
  ADD CONSTRAINT uq_attendance_member UNIQUE (site_id, member_id, year, month);
