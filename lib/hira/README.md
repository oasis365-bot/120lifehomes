# lib/hira — 심평원(HIRA) 요양병원 수집 어댑터 (1B-2)

1B-1 실측(2026-09-07)으로 확정한 현행 endpoint·필드 기준 구현. **DB write 없음 (dry-run 전용).**

| 파일 | 역할 |
|---|---|
| `parse.js` | HIRA 공통 응답 파서. JSON 우선·XML fallback·게이트웨이 오류 처리. `isNormalResult` / `isTransientResult`. |
| `client.js` | 공통 API 클라이언트. GET only, 7s 타임아웃, 요청 간 ≥250ms, 최대 3회 재시도(timeout/네트워크/429/5xx/일시적 code 12·99, 지수 백오프+jitter), 실패 시 `HiraError`. serviceKey·URL 로그 안 남김. 폐기판 fallback 안 함. |
| `adapter.js` | raw → `NormalizedHospital` / `NormalizedEvaluation`. 좌표 number/string 혼재·NaN·범위밖 → NULL+경고. asmGrd10 1~5·"등급제외". 평가연도·폐업상태 추측 금지. `normalizedHash`. |
| `collect.js` | 오케스트레이터. clCd=28 목록 페이징 → ykiho 중복제거 → 기관별 상세 6종+평가 → 정규화. 부분 실패 허용, 실패 기관 재처리 목록. **최대 20곳 (하드캡).** DB 미접근. |

호출부: `api/hospital/ingest.js` (Preview 전용, production 404, CRON_SECRET Bearer, dryRun 기본 true).

## 현행 endpoint (1B-1 실측)

```
목록  https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList   (clCd=28, totalCount 1,280)
상세  https://apis.data.go.kr/B551182/MadmDtlInfoService2.8/get{X}Info2.8
        getEqpInfo2.8 getDtlInfo2.8 getDgsbjtInfo2.8 getMedOftInfo2.8 getSpcSbjtSdrInfo2.8 getEtcHstInfo2.8
평가  https://apis.data.go.kr/B551182/hospAsmInfoService1/getHospAsmInfo1   (asmGrd10)
```

구형 판(`hospInfoService1`, `hospAsmInfoService`, `medicInsttDetailInfoService`)은 게이트웨이 code 12(폐기). 자동 전환하지 않음.

## 테스트

```bash
npm test            # 전체 (node --test, Node 20.11+)
npm run test:hira   # test/hira/ 만
```

fixture(`test/hira/fixtures/`)는 1B-1 인증정보 제거 샘플 기반. serviceKey 없음.

## 다음 (1B-3)

`collect.js` 의 `_normalizedAll` → `facilities`(H-ykiho, domain='HOSPITAL') + `hospital_profiles` + `facility_evaluations` + `facility_sources`(raw, normalized_hash) upsert. `facility_revisions` 로 운영자 검수값 보호. `ingestion_runs` 로그. **별도 승인 후.**
