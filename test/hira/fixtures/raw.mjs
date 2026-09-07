// HIRA 파서/클라이언트 테스트용 raw 문자열 (합성 — serviceKey 없음)

// 정상 XML (item 배열)
export const XML_NORMAL_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item>
        <yadmNm>가나요양병원</yadmNm>
        <clCd>28</clCd><clCdNm>요양병원</clCdNm>
        <addr>서울특별시 종로구 세종대로 1</addr>
        <telno>02-000-0000</telno>
        <XPos>126.977</XPos><YPos>37.5665</YPos>
        <ykiho>YKIHO_XML_A</ykiho>
      </item>
      <item>
        <yadmNm>다라요양병원</yadmNm>
        <clCd>28</clCd><clCdNm>요양병원</clCdNm>
        <addr>부산광역시 해운대구 1</addr>
        <ykiho>YKIHO_XML_B</ykiho>
      </item>
    </items>
    <numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>2</totalCount>
  </body>
</response>`;

// 정상 XML (item 단건)
export const XML_NORMAL_ONE = `<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
<body><items><item><yadmNm>단건요양병원</yadmNm><clCd>28</clCd><ykiho>YKIHO_XML_ONE</ykiho></item></items>
<numOfRows>1</numOfRows><pageNo>1</pageNo><totalCount>1</totalCount></body></response>`;

// 게이트웨이 오류 XML (code 12 — NO_OPENAPI_SERVICE)
export const XML_GATEWAY_12 = `<OpenAPI_ServiceResponse>
  <cmmMsgHeader>
    <errMsg>SERVICE ERROR</errMsg>
    <returnAuthMsg>해당 오픈API 서비스가 없거나 폐기됨</returnAuthMsg>
    <returnReasonCode>12</returnReasonCode>
  </cmmMsgHeader>
</OpenAPI_ServiceResponse>`;

// 게이트웨이 오류 JSON (code 12)
export const JSON_GATEWAY_12 = JSON.stringify({
  OpenAPI_ServiceResponse: {
    cmmMsgHeader: {
      errMsg: 'NO_OPENAPI_SERVICE_ERROR',
      returnAuthMsg: '해당 오픈API 서비스가 없거나 폐기됨',
      returnReasonCode: '12',
    },
  },
});

// 게이트웨이 오류 JSON (code 22 — 일일 트래픽 초과, 재시도 대상 아님)
export const JSON_GATEWAY_22 = JSON.stringify({
  OpenAPI_ServiceResponse: {
    cmmMsgHeader: {
      errMsg: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR',
      returnAuthMsg: 'LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR',
      returnReasonCode: '22',
    },
  },
});

// 서비스 정상 응답이나 결과 0건 (item 없음)
export const JSON_EMPTY = JSON.stringify({
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: { items: '', numOfRows: 10, pageNo: 1, totalCount: 0 },
  },
});

// 파라미터 오류 (비일시적) — resultCode 그대로 반환되어야 함
export const JSON_PARAM_ERROR = JSON.stringify({
  response: {
    header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' },
    body: {},
  },
});

// 평가: asmGrd10 = "등급제외"
export const JSON_ASM_EXCLUDED = JSON.stringify({
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: {
      items: { item: { asmGrd10: '등급제외', clCd: 28, yadmNm: '등급제외병원', ykiho: 'YK_EXCL' } },
      numOfRows: 10, pageNo: 1, totalCount: 1,
    },
  },
});

// 평가: asmGrd10 없음 (요양병원 적정성평가 미대상)
export const JSON_ASM_NONE = JSON.stringify({
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' },
    body: {
      items: { item: { asmGrd07: 1, clCd: 31, yadmNm: '의원', ykiho: 'YK_NOASM' } },
      numOfRows: 10, pageNo: 1, totalCount: 1,
    },
  },
});

// 평가: 목록 자체가 빈 경우
export const JSON_ASM_EMPTY = JSON_EMPTY;
