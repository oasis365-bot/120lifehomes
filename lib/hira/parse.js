// =====================================================================
// HIRA (건강보험심사평가원) 오픈API 응답 파서 — JSON 우선, XML fallback
// =====================================================================
//  data.go.kr B551182 계열 3개 서비스가 모두 같은 봉투 구조를 쓴다.
//    · 정상(JSON)      : { response: { header:{resultCode,resultMsg}, body:{items:{item}, totalCount, numOfRows, pageNo} } }
//    · 정상(XML)       : <response><header>…</header><body><items><item>…</item></items>…</body></response>
//    · 게이트웨이 오류 : { OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode, returnAuthMsg, errMsg } } }
//                        또는 같은 내용의 XML (<OpenAPI_ServiceResponse>…)
//  item 은 0건이면 없음/빈문자, 1건이면 단수 객체, 2건+면 배열 → 항상 배열로 정규화.
//
//  serviceKey 는 쿼리 파라미터라 응답 본문에 들어오지 않지만, 방어적으로 scrub 훅을 받는다.
// =====================================================================

/**
 * @typedef {Object} HiraParsed
 * @property {'json'|'xml'} format
 * @property {boolean} gatewayError   data.go.kr 게이트웨이 레벨 오류 (서비스 미존재/키 등)
 * @property {string|null} resultCode  '00' = 정상. 게이트웨이 오류면 returnReasonCode.
 * @property {string|null} resultMsg
 * @property {number|null} totalCount
 * @property {number|null} numOfRows
 * @property {number|null} pageNo
 * @property {Array<Object>} items
 */

const toIntOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {string} text  응답 본문 (이미 scrub 되었다고 가정하되, scrubFn 이 있으면 한 번 더)
 * @param {(s:string)=>string} [scrubFn]
 * @returns {HiraParsed}
 */
export function parseHiraResponse(text, scrubFn) {
  const src = typeof scrubFn === 'function' ? scrubFn(String(text ?? '')) : String(text ?? '');

  // ── JSON 시도 ──
  try {
    const j = JSON.parse(src);

    const gw = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
    if (gw) {
      return {
        format: 'json',
        gatewayError: true,
        resultCode: gw.returnReasonCode ?? null,
        resultMsg: gw.returnAuthMsg ?? gw.errMsg ?? null,
        totalCount: null,
        numOfRows: null,
        pageNo: null,
        items: [],
      };
    }

    const header = j?.response?.header ?? {};
    const body = j?.response?.body ?? {};
    let item = body?.items?.item ?? body?.items ?? [];
    item = Array.isArray(item) ? item : item ? [item] : [];
    return {
      format: 'json',
      gatewayError: false,
      resultCode: header.resultCode ?? null,
      resultMsg: header.resultMsg ?? null,
      totalCount: toIntOrNull(body?.totalCount),
      numOfRows: toIntOrNull(body?.numOfRows),
      pageNo: toIntOrNull(body?.pageNo),
      items: item,
    };
  } catch {
    /* JSON 아님 → XML */
  }

  // ── XML fallback ──
  const pick = (re) => {
    const m = src.match(re);
    return m ? m[1].trim() : null;
  };
  const gatewayError = /<OpenAPI_ServiceResponse>/.test(src) || /<cmmMsgHeader>/.test(src);

  const resultCode =
    pick(/<resultCode>([^<]*)<\/resultCode>/) ??
    pick(/<returnReasonCode>([^<]*)<\/returnReasonCode>/);
  const resultMsg =
    pick(/<resultMsg>([^<]*)<\/resultMsg>/) ??
    pick(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/) ??
    pick(/<errMsg>([^<]*)<\/errMsg>/);

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(src))) {
    const obj = {};
    const fieldRe = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(m[1]))) obj[f[1]] = String(f[2]).trim();
    if (Object.keys(obj).length) items.push(obj);
  }

  return {
    format: 'xml',
    gatewayError,
    resultCode: resultCode ?? null,
    resultMsg: resultMsg ?? null,
    totalCount: toIntOrNull(pick(/<totalCount>([^<]*)<\/totalCount>/)),
    numOfRows: toIntOrNull(pick(/<numOfRows>([^<]*)<\/numOfRows>/)),
    pageNo: toIntOrNull(pick(/<pageNo>([^<]*)<\/pageNo>/)),
    items,
  };
}

/**
 * resultCode 가 "정상"인지. HIRA 는 '00' 을 쓴다. (장기요양 API 의 'NORMAL SERVICE.' 도 관용 허용)
 * @param {HiraParsed} p
 */
export function isNormalResult(p) {
  if (!p || p.gatewayError) return false;
  const rc = String(p.resultCode ?? '').trim();
  // 명시적 성공 코드만 정상으로 인정. resultCode 가 비어있으면(파싱 실패·형식 이상) 정상 아님.
  return rc === '00' || rc === '0' || /^NORMAL SERVICE\.?$/i.test(rc);
}

/**
 * 재시도해볼 가치가 있는 "일시적" 실패인지 판정.
 *   · 게이트웨이 code 12 (NO_OPENAPI_SERVICE_ERROR) — HIRA 게이트웨이가 부하 시 오탐으로 뱉는 사례 실측됨
 *   · code 99 (알 수 없는 오류), 1 (어플리케이션 에러)
 * 폐기된 엔드포인트도 12 를 주므로, 호출부는 "정상 endpoint 로만" 재시도해야 한다(자동 fallback 금지).
 * @param {HiraParsed} p
 */
export function isTransientResult(p) {
  if (!p) return false;
  const rc = String(p.resultCode ?? '');
  if (!p.gatewayError) return false;
  return rc === '12' || rc === '99' || rc === '1' || /NO_OPENAPI_SERVICE|UNKNOWN_ERROR/i.test(String(p.resultMsg ?? ''));
}
