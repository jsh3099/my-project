-- ============================================================
-- expenses RLS 수정
--
-- 라이브 DB에 마이그레이션 파일 없이 직접 걸려있던 정책이 앱이 실제로
-- 쓰지 않는 컬럼(submission_status)을 기준으로 필터링하고 있어,
-- hq_officer가 site_staff가 제출(status='submitted')한 항목을
-- 하나도 조회할 수 없었다 (앱은 submission_status가 아닌 status 컬럼만 씀).
-- 이 때문에 /expenses, /hq/overview, 기성회차 확정 미리보기가 모두
-- 본인이 직접 입력한 건 외에는 빈 목록으로 보였다.
-- ============================================================
DROP POLICY IF EXISTS "hq_officer: submitted 항목 조회" ON public.expenses;

CREATE POLICY "hq_officer: 전체 현장 조회"
  ON public.expenses FOR SELECT
  USING (get_user_role() IN ('hq_officer', 'system_admin'));
