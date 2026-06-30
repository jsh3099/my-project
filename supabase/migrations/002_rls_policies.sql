-- ============================================================
-- 역할 조회 헬퍼 함수
-- ============================================================
CREATE OR REPLACE FUNCTION auth.user_role()
RETURNS TEXT AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid() AND deleted_at IS NULL;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION auth.is_site_member(p_site_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_site_assignments
    WHERE user_id = auth.uid()
      AND site_id = p_site_id
      AND is_active = TRUE
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ============================================================
-- RLS 활성화
-- ============================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_parameters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_site_assignments ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- profiles RLS
-- ============================================================
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "profiles_select_admin_hq"
  ON public.profiles FOR SELECT
  USING (auth.user_role() IN ('system_admin', 'hq_officer'));

CREATE POLICY "profiles_insert_admin"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.user_role() = 'system_admin');

CREATE POLICY "profiles_update_admin"
  ON public.profiles FOR UPDATE
  USING (auth.user_role() = 'system_admin');

-- ============================================================
-- sites RLS
-- ============================================================
CREATE POLICY "sites_select"
  ON public.sites FOR SELECT
  USING (
    deleted_at IS NULL AND (
      auth.user_role() IN ('system_admin', 'hq_officer')
      OR auth.is_site_member(id)
    )
  );

CREATE POLICY "sites_insert_admin"
  ON public.sites FOR INSERT
  WITH CHECK (auth.user_role() = 'system_admin');

CREATE POLICY "sites_update_admin"
  ON public.sites FOR UPDATE
  USING (auth.user_role() = 'system_admin');

-- ============================================================
-- site_parameters RLS
-- ============================================================
CREATE POLICY "site_params_select"
  ON public.site_parameters FOR SELECT
  USING (
    auth.user_role() IN ('system_admin', 'hq_officer')
    OR auth.is_site_member(site_id)
  );

CREATE POLICY "site_params_write"
  ON public.site_parameters FOR ALL
  USING (auth.user_role() IN ('system_admin', 'hq_officer'))
  WITH CHECK (auth.user_role() IN ('system_admin', 'hq_officer'));

-- ============================================================
-- user_site_assignments RLS
-- ============================================================
CREATE POLICY "assignments_select"
  ON public.user_site_assignments FOR SELECT
  USING (
    auth.user_role() IN ('system_admin', 'hq_officer')
    OR user_id = auth.uid()
  );

CREATE POLICY "assignments_write_admin"
  ON public.user_site_assignments FOR ALL
  USING (auth.user_role() = 'system_admin')
  WITH CHECK (auth.user_role() = 'system_admin');
