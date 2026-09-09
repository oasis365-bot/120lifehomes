# lib/hira — 심평원(HIRA) 요양병원 수집 어댑터 (1B-2 / 1B-3)

1B-1 실측(2026-09-07)으로 확정한 현행 endpoint·필드 기준 구현. 기본 흐름은 **dry-run (DB write 없음)**.

| 파일 | 역할 |
|---|---|
| `parse.js` | HIRA 공통 응답 파서. JSON 우선·XML fallback·게이트웨이 오류 처리. `isNormalResult` / `isTransientResult`. |
| `client.js` | 공통 API 클라이언트. GET only, 7s 타임아웃, 요청 간 ≥250ms, 최대 3회 재시도(timeout/네트워크/429/5xx/일시적 code 12, 지수 백오프+jitter), 실패 시 `HiraError`. 실패 원인은 allowlist `failureKind`/`attemptSummary`/`elapsedBucket` 으로만 (원문·URL·키 비노출). wall-clock 데드라인 지원. 폐기판 fallback 안 함. |
| `adapter.js` | raw → `NormalizedHospital` / `NormalizedEvaluation`. 좌표 number/string 혼재·NaN·범위밖 → NULL+경고. asmGrd10 1~5·"등급제외". 평가연도·폐업상태 추측 금지. `normalizedHash`. |
| `collect.js` | 오케스트레이터. clCd=28 목록 페이징 → ykiho 중복제거 → 기관별 상세 6종+평가 → 정규화. 부분 실패 허용, 실패 기관 재처리 목록. **최대 20곳 (하드캡).** `listOnly` 모드(목록만). DB 미접근. |
| `persist.js` (1B-3) | `_normalizedAll` → `facilities`/`hospital_profiles`/`facility_evaluations`/`facility_sources`/`ingestion_runs` upsert. 운영자 입력 컬럼 미변경, `facility_revisions` 로 검수값 보호. `normalized_hash` 로 unchanged 판정. `assertPreviewDb`/`verifyPreviewDbUrl` 로 목적지 DB 검증(fail-closed). |

호출부: `api/hospital/ingest.js` (Preview 전용, production 404, CRON_SECRET Bearer, dryRun 기본 true).
실 적재(`dryRun=false`)는 `HOSPITAL_INGEST_PERSIST=1` **및** `HOSPITAL_INGEST_DB_HOST=<허용 hostname>` 이 둘 다 설정돼야 하고(미설정이면 fail-closed), `hospital_module=false`·LTC 행 0·001 스키마 확인을 통과해야 한다. — 별도 승인 후에만.

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

## 다음

Preview DB 소량 시험 적재는 검증 완료(멱등성 포함). 다음은 폐업감지·delta 재수집·전체 적재 → 회귀 → 승인 → production. `hospital_module` 은 계속 OFF.
