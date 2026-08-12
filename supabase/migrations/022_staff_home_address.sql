-- 명부 인원별 자택주소 — 교통비(상주)·출장비(기술지원) 산출의 출발지.
-- 거주지 증빙(재직증명서 등)을 첨부하면 PDF에서 주소를 인식해 채우고, 사용자가 확인·수정한다.
-- 인원의 속성이라 회차와 무관하게 유지되며, 산출 패널에는 이 값이 자동 매핑된다.
ALTER TABLE site_staff_members
  ADD COLUMN IF NOT EXISTS home_address TEXT;
