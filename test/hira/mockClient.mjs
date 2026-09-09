// collect/ingest 테스트용 mock HIRA client (실제 네트워크 없음)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHiraResponse } from '../../lib/hira/parse.js';
import { HIRA_ENDPOINTS, HiraError } from '../../lib/hira/client.js';

const fx = (name) =>
  parseHiraResponse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
  );

/**
 * @param {Object} [opt]
 * @param {number} [opt.listTotal=5]        목록에 담을 (중복 포함) 항목 수
 * @param {number} [opt.dupEvery]           n번째마다 ykiho 중복 삽입
 * @param {Set<string>} [opt.failSteps]     이 step 이름은 항상 throw ('facility'|'evaluation'...)
 * @param {Set<string>} [opt.emptySteps]    이 step 은 빈 결과 반환
 * @param {number} [opt.listEmptyFirst=0]   처음 N 번의 listHospitals 호출은 "정상 resultCode + 0건" 반환
 * @param {number|null} [opt.listEmptyTotal]  위 빈 응답이 보고할 totalCount (기본 listTotal, null 이면 totalCount 미포함)
 * @param {number} [opt.listThrowFirst=0]   처음 N 번의 listHospitals 호출은 HiraError throw (client 재시도 소진 흉내)
 * @param {string} [opt.listThrowReason='gateway']  위 throw 의 reason ('timeout'|'network'|'http'|'gateway'|'aborted_all'|'config')
 * @param {number} [opt.listAbnormalFirst=0] 처음 N 번의 listHospitals 호출은 비정상 resultCode 반환 (client 가 "비일시적" 으로 그대로 반환한 것)
 * @param {string} [opt.listAbnormalCode='1']  위 비정상 응답의 resultCode
 * @param {Object<number,number>} [opt.emptyOnPage]  { pageNo: 횟수 } — 해당 pageNo 의 처음 N 번 호출은 0건 반환
 * @param {()=>void} [opt.tick]  매 HIRA 메서드 호출마다 1회 실행 (가짜 시계 전진용)
 */
export function makeMockClient(opt = {}) {
  const listItems = fx('hospBasisList_clCd28.json').items;
  const calls = [];
  const tick = typeof opt.tick === 'function' ? opt.tick : () => {};
  const failSteps = opt.failSteps ?? new Set();
  const emptySteps = opt.emptySteps ?? new Set();
  let listCallNo = 0;
  const pageEmptyBudget = { ...(opt.emptyOnPage || {}) };

  const guard = (step, parsed) => {
    calls.push(step);
    tick();
    if (failSteps.has(step)) {
      const e = new Error(`mock fail: ${step}`);
      e.reason = 'gateway';
      throw e;
    }
    if (emptySteps.has(step)) {
      return { format: 'json', gatewayError: false, resultCode: '00', resultMsg: 'NORMAL SERVICE.', totalCount: 0, numOfRows: 10, pageNo: 1, items: [] };
    }
    return parsed;
  };

  return {
    calls,
    endpoints: HIRA_ENDPOINTS,
    async listHospitals({ pageNo = 1, numOfRows = 100 } = {}) {
      listCallNo += 1;
      calls.push(`list:p${pageNo}`);
      tick();
      if ((opt.listThrowFirst && listCallNo <= opt.listThrowFirst) ||
          (opt.listThrowFrom && listCallNo >= opt.listThrowFrom)) {
        throw new HiraError('mock: HIRA getHospBasisList 재시도 소진', {
          op: 'getHospBasisList',
          reason: opt.listThrowReason ?? 'gateway',
          failureKind: opt.listThrowFailureKind ?? 'result_code_12',
          attemptSummary: opt.listThrowAttemptSummary ?? { [opt.listThrowFailureKind ?? 'result_code_12']: 3 },
          elapsedBucket: opt.listThrowElapsedBucket ?? '5s_15s',
          attempts: 3,
          lastResultCode: opt.listThrowResultCode ?? null,
        });
      }
      if (opt.listAbnormalFirst && listCallNo <= opt.listAbnormalFirst) {
        return {
          format: 'json', gatewayError: true,
          resultCode: opt.listAbnormalCode ?? '1',
          resultMsg: 'APPLICATION ERROR',
          totalCount: null, numOfRows, pageNo, items: [],
        };
      }
      const emptyN = opt.listEmptyFirst ?? 0;
      const pageBudget = Number(pageEmptyBudget[pageNo]) > 0;
      if ((emptyN && listCallNo <= emptyN) || pageBudget) {
        if (pageBudget) pageEmptyBudget[pageNo] -= 1;
        const total = opt.listEmptyTotal === null
          ? undefined
          : (opt.listEmptyTotal ?? (opt.listTotal ?? 5));
        const r = {
          format: 'json', gatewayError: false, resultCode: '00', resultMsg: 'NORMAL SERVICE.',
          numOfRows, pageNo, items: [],
        };
        if (total !== undefined) r.totalCount = total;
        return r;
      }
      const n = opt.listTotal ?? 5;
      const pool = [];
      for (let i = 0; i < n; i++) {
        const src = listItems[i % listItems.length];
        // 고유 ykiho 로 치환. dupEvery 이면 i=0 과 동일한 ykiho 를 재사용해 실제 중복 생성.
        let ykiho = `${listItems[0].ykiho}#${i}`;
        if (opt.dupEvery && i > 0 && i % opt.dupEvery === 0) ykiho = `${listItems[0].ykiho}#0`;
        pool.push({ ...src, ykiho });
      }
      const start = (pageNo - 1) * numOfRows;
      const slice = pool.slice(start, start + numOfRows);
      return {
        format: 'json', gatewayError: false, resultCode: '00', resultMsg: 'NORMAL SERVICE.',
        totalCount: n, numOfRows, pageNo, items: slice,
      };
    },
    async getFacilityInfo() { return guard('facility', fx('detail_eqp.json')); },
    async getDetailInfo() { return guard('detail', fx('detail_dtl.json')); },
    async getDepartments() { return guard('departments', fx('detail_dgsbjt.json')); },
    async getEquipment() { return guard('equipment', fx('detail_medOft.json')); },
    async getSpecialists() { return guard('specialists', fx('detail_spcSbjt.json')); },
    async getOtherStaff() { return guard('otherStaff', fx('detail_etcHst.json')); },
    async getEvaluation() { return guard('evaluation', fx('hospAsm_withGrade.json')); },
  };
}
