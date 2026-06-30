-- ============================================================
-- 공통 헬퍼
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- profiles: Supabase Auth users 확장 정보
-- ============================================================
CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('site_staff', 'hq_officer', 'system_admin')),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auth 사용자 생성 시 profiles 행 자동 삽입
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'site_staff')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- sites: 현장(프로젝트) — F-02
-- ============================================================
CREATE TABLE public.sites (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL,
  client_name           TEXT NOT NULL,
  contract_start        DATE NOT NULL,
  contract_end          DATE NOT NULL,
  contract_amount       BIGINT NOT NULL,
  direct_expense_budget BIGINT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'suspended')),
  created_by            UUID REFERENCES public.profiles(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

CREATE TRIGGER trg_sites_updated_at
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sites_status ON public.sites(status) WHERE deleted_at IS NULL;

-- ============================================================
-- site_parameters: 현장별 정산 기준 파라미터 — F-03
-- ============================================================
CREATE TABLE public.site_parameters (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id                    UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  meal_allowance_daily_limit INTEGER NOT NULL DEFAULT 25000,
  welfare_monthly_limit      INTEGER NOT NULL DEFAULT 50000,
  travel_grade               SMALLINT NOT NULL DEFAULT 3
                               CHECK (travel_grade BETWEEN 1 AND 5),
  apply_commute_regulation   BOOLEAN NOT NULL DEFAULT TRUE,
  reject_personal_mobile     BOOLEAN NOT NULL DEFAULT TRUE,
  notes                      TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (site_id)
);

CREATE TRIGGER trg_site_parameters_updated_at
  BEFORE UPDATE ON public.site_parameters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- user_site_assignments: 사용자↔현장 다대다 배정 — F-04
-- ============================================================
CREATE TABLE public.user_site_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by UUID REFERENCES public.profiles(id),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (user_id, site_id)
);

CREATE INDEX idx_user_site_assignments_user ON public.user_site_assignments(user_id);
CREATE INDEX idx_user_site_assignments_site ON public.user_site_assignments(site_id);
CREATE INDEX idx_profiles_role ON public.profiles(role) WHERE deleted_at IS NULL;
