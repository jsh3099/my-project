-- ============================================================
-- 상주기술인 / 기술지원 기술인 구분
--
-- 한 사람이 현장별로 상주 또는 기술지원으로 다르게 배정될 수 있으므로
-- profiles가 아닌 user_site_assignments(현장 배정) 단위로 저장한다.
-- 기존 배정 건은 전부 상주(resident)로 백필한다 (기존 운영과 동일).
-- ============================================================
ALTER TABLE public.user_site_assignments
  ADD COLUMN IF NOT EXISTS staff_type TEXT NOT NULL DEFAULT 'resident'
    CHECK (staff_type IN ('resident', 'support'));
