-- 명부 인원별 거주지 증빙 첨부 (재직증명서·주민등록등본 등)
-- 교통비(자택↔현장 거리 기준) 산출의 자택주소를 뒷받침하는 서류 — 사람의 속성이라
-- 회차가 아닌 명부(site_staff_members)에 둔다. 한 번 첨부하면 모든 회차에 적용,
-- 이사 등 주소 변경 시에만 교체한다. URL 프래그먼트(#파일명)에 원본 파일명을 보관한다.
ALTER TABLE site_staff_members
  ADD COLUMN IF NOT EXISTS residence_doc_urls TEXT[] NOT NULL DEFAULT '{}';
