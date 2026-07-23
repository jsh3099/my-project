-- ============================================================
-- 상주기술인 자차 교통비 자동산출을 위한 필드
--
-- 공무원보수 등의 업무지침: 연료비 = 여행거리(km) × 유가 ÷ 연비
-- 여행거리는 자택주소~현장주소 간 편도 거리를 왕복(×2)으로 계산한다.
-- ============================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS home_address TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_fuel_type TEXT
    CHECK (vehicle_fuel_type IN ('gasoline', 'diesel', 'lpg', 'hybrid', 'phev', 'ev', 'hydrogen'));

-- 현장 주소 (거리 계산의 목적지) — 기존 sites 테이블에 주소 컬럼이 아예 없었음
ALTER TABLE public.sites
  ADD COLUMN IF NOT EXISTS address TEXT;
