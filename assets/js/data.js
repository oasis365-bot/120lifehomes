/* =========================================================
   케어홈즈 — 공통 데이터 (한국형)
   * 일본 kaigo.homes.co.jp 의 검색 축을 한국 노인장기요양 제도에 맞춰 재구성
   * 아래 시설 정보는 데모용 가상 데이터입니다.
   ========================================================= */

const REGIONS = [
  { code: "seoul", name: "서울", count: 1284 },
  { code: "busan", name: "부산", count: 612 },
  { code: "daegu", name: "대구", count: 431 },
  { code: "incheon", name: "인천", count: 508 },
  { code: "gwangju", name: "광주", count: 274 },
  { code: "daejeon", name: "대전", count: 261 },
  { code: "ulsan", name: "울산", count: 173 },
  { code: "sejong", name: "세종", count: 58 },
  { code: "gyeonggi", name: "경기", count: 2145 },
  { code: "gangwon", name: "강원", count: 342 },
  { code: "chungbuk", name: "충북", count: 318 },
  { code: "chungnam", name: "충남", count: 421 },
  { code: "jeonbuk", name: "전북", count: 389 },
  { code: "jeonnam", name: "전남", count: 402 },
  { code: "gyeongbuk", name: "경북", count: 511 },
  { code: "gyeongnam", name: "경남", count: 486 },
  { code: "jeju", name: "제주", count: 97 },
];

const FACILITY_TYPES = [
  { code: "nursing", name: "노인요양시설(요양원)", icon: "🏥",
    desc: "치매·중풍 등으로 도움이 필요한 어르신이 입소해 요양보호사의 24시간 돌봄을 받는 대표적 생활시설입니다." },
  { code: "grouphome", name: "노인요양공동생활가정(그룹홈)", icon: "🏡",
    desc: "9인 이하 소규모 가정형 시설. 익숙한 생활환경에서 개별 맞춤 돌봄을 제공합니다." },
  { code: "daycare", name: "주야간보호센터(데이케어)", icon: "☀️",
    desc: "낮 시간 동안 어르신을 보호하고 재활·인지 프로그램을 제공. 저녁에는 가정으로 복귀합니다." },
  { code: "respite", name: "단기보호시설", icon: "📅",
    desc: "가족의 여행·입원 등으로 일시적 돌봄이 필요할 때 최대 월 9일까지 이용하는 시설입니다." },
  { code: "homecare", name: "방문요양센터", icon: "🚪",
    desc: "요양보호사가 가정을 방문해 신체활동·가사활동을 지원하는 재가급여 서비스입니다." },
  { code: "silvertown", name: "노인복지주택(실버타운)", icon: "🏙️",
    desc: "건강한 어르신이 독립생활을 하면서 식사·생활편의·건강관리 서비스를 받는 주거시설입니다." },
  { code: "care_asylum", name: "양로시설", icon: "🏫",
    desc: "일상생활에 지장이 없는 어르신에게 급식과 생활편의를 제공하는 무료·실비 시설입니다." },
  { code: "dementia", name: "치매전담형 장기요양기관", icon: "🧠",
    desc: "치매 어르신 전용 프로그램·환경·전문인력을 갖춘 요양시설 및 주야간보호기관입니다." },
  { code: "hospital", name: "요양병원", icon: "💊",
    desc: "의사·간호사가 상주하며 만성기 치료와 재활, 의료적 관리가 필요한 환자를 위한 의료기관입니다." },
];

const CARE_LEVELS = [
  { code: "l1", name: "장기요양 1등급", desc: "일상생활에서 전적으로 다른 사람의 도움이 필요 (95점 이상)" },
  { code: "l2", name: "장기요양 2등급", desc: "상당 부분 다른 사람의 도움이 필요 (75~94점)" },
  { code: "l3", name: "장기요양 3등급", desc: "부분적으로 다른 사람의 도움이 필요 (60~74점)" },
  { code: "l4", name: "장기요양 4등급", desc: "일정 부분 도움이 필요 (51~59점)" },
  { code: "l5", name: "장기요양 5등급", desc: "치매 환자 (45~50점)" },
  { code: "cog", name: "인지지원등급", desc: "경증 치매 (45점 미만, 치매 진단 필요)" },
  { code: "none", name: "등급 외 / 자립", desc: "장기요양 인정을 받지 않은 건강한 어르신" },
];

const FEATURES = [
  "입소금 없음", "부부실 가능", "반려동물 동반", "24시간 간호사 상주", "재활 전문 프로그램",
  "치매 전담 케어", "호스피스·완화 케어", "도심 접근성 우수", "숲·자연 환경", "온천·스파 시설",
  "종교시설 인접", "신축 건물", "1인실 보유", "물리치료실", "전담 영양사",
];

const COLLECTIONS = [
  { title: "입소금 0원 시설", desc: "보증금 부담 없이 월 이용료만으로 입소", q: "feature=입소금 없음", c1: "#2e8b57", c2: "#1f8a4c" },
  { title: "반려동물과 함께", desc: "평생 함께한 반려동물과 입소 가능한 시설", q: "feature=반려동물 동반", c1: "#e0912f", c2: "#f47b20" },
  { title: "치매 전문 케어", desc: "치매전담실·전문인력을 갖춘 요양시설", q: "type=dementia", c1: "#6a5acd", c2: "#8367d8" },
  { title: "재활 집중 프로그램", desc: "물리·작업치료로 기능 회복을 돕는 시설", q: "feature=재활 전문 프로그램", c1: "#2f7fb5", c2: "#3a9bd4" },
  { title: "숲세권 요양시설", desc: "도심을 벗어나 자연 속에서 지내는 시설", q: "feature=숲·자연 환경", c1: "#3f8f3f", c2: "#5aa85a" },
  { title: "호스피스·완화 케어", desc: "존엄한 마무리를 돕는 완화의료 연계 시설", q: "feature=호스피스·완화 케어", c1: "#b5546a", c2: "#d46e84" },
];

/* 데모용 가상 시설 데이터 (12개) */
const FACILITIES = [
  {
    id: "f01", name: "햇살가득 요양원", type: "nursing", region: "seoul", city: "은평구",
    address: "서울특별시 은평구 통일로 1234", monthlyFee: 165, entryFee: 500,
    levels: ["l1", "l2", "l3"], features: ["24시간 간호사 상주", "재활 전문 프로그램", "물리치료실", "전담 영양사", "도심 접근성 우수"],
    vacancy: 3, capacity: 90, opened: "2016", nurse24: true, rating: 4.6, reviews: 128, color: "#2e8b57",
    phone: "02-1234-5678",
    desc: "북한산 자락에 위치한 90인 규모의 노인요양시설입니다. 물리치료실과 작업치료실을 별도로 운영하며, 간호사가 24시간 상주해 응급 상황에 대비합니다. 지하철 3호선 연신내역에서 도보 10분 거리로 가족 면회가 편리합니다.",
  },
  {
    id: "f02", name: "예그리나 케어홈", type: "grouphome", region: "gyeonggi", city: "고양시",
    address: "경기도 고양시 일산동구 중앙로 567", monthlyFee: 148, entryFee: 0,
    levels: ["l2", "l3", "l4"], features: ["입소금 없음", "숲·자연 환경", "1인실 보유", "치매 전담 케어"],
    vacancy: 1, capacity: 9, opened: "2019", nurse24: false, rating: 4.8, reviews: 41, color: "#5aa85a",
    phone: "031-222-3344",
    desc: "정원 9명의 소규모 가정형 그룹홈입니다. 한 명 한 명 이름을 부르며 생활 리듬에 맞춘 돌봄을 제공합니다. 텃밭 가꾸기, 반찬 만들기 등 어르신이 주체가 되는 일상 활동을 중시합니다.",
  },
  {
    id: "f03", name: "가온누리 주야간보호센터", type: "daycare", region: "seoul", city: "노원구",
    address: "서울특별시 노원구 상계로 89", monthlyFee: 52, entryFee: 0,
    levels: ["l3", "l4", "l5", "cog"], features: ["입소금 없음", "재활 전문 프로그램", "도심 접근성 우수", "물리치료실"],
    vacancy: 8, capacity: 45, opened: "2020", nurse24: false, rating: 4.4, reviews: 76, color: "#e0912f",
    phone: "02-987-6543",
    desc: "오전 8시부터 오후 8시까지 운영하는 주야간보호센터입니다. 무료 차량 등·하원 서비스를 제공하며, 인지 활성화 프로그램과 어르신 체력에 맞춘 운동 프로그램을 매일 진행합니다.",
  },
  {
    id: "f04", name: "솔향기 실버타운", type: "silvertown", region: "gyeonggi", city: "용인시",
    address: "경기도 용인시 처인구 명지로 21", monthlyFee: 290, entryFee: 12000,
    levels: ["none", "cog", "l5"], features: ["부부실 가능", "숲·자연 환경", "온천·스파 시설", "신축 건물", "전담 영양사"],
    vacancy: 5, capacity: 220, opened: "2022", nurse24: true, rating: 4.7, reviews: 63, color: "#3a9bd4",
    phone: "031-330-1000",
    desc: "건강한 어르신을 위한 노인복지주택입니다. 부부 세대는 전용 30평형 세대를 이용할 수 있고, 단지 내 온천 스파와 피트니스, 문화센터를 갖추고 있습니다. 필요 시 인근 협력 요양시설로 연계됩니다.",
  },
  {
    id: "f05", name: "온새미로 치매전담요양원", type: "dementia", region: "busan", city: "해운대구",
    address: "부산광역시 해운대구 좌동순환로 456", monthlyFee: 172, entryFee: 300,
    levels: ["l2", "l3", "l4", "l5", "cog"], features: ["치매 전담 케어", "24시간 간호사 상주", "숲·자연 환경", "물리치료실"],
    vacancy: 2, capacity: 70, opened: "2018", nurse24: true, rating: 4.5, reviews: 94, color: "#8367d8",
    phone: "051-777-8888",
    desc: "치매전담실 4개를 운영하는 치매전담형 장기요양기관입니다. 배회 동선을 고려한 원형 복도 설계, 회상 요법실, 스누젤렌실을 갖추고 있으며 치매전문교육을 이수한 요양보호사가 배치됩니다.",
  },
  {
    id: "f06", name: "미리내 요양병원", type: "hospital", region: "daegu", city: "수성구",
    address: "대구광역시 수성구 달구벌대로 3000", monthlyFee: 210, entryFee: 0,
    levels: ["l1", "l2", "l3"], features: ["입소금 없음", "24시간 간호사 상주", "재활 전문 프로그램", "호스피스·완화 케어", "물리치료실"],
    vacancy: 12, capacity: 180, opened: "2014", nurse24: true, rating: 4.2, reviews: 210, color: "#2f7fb5",
    phone: "053-555-0100",
    desc: "재활의학과·신경과·내과 전문의가 상주하는 요양병원입니다. 뇌졸중 후 집중 재활, 완화의료 병동을 운영합니다. 건강보험이 적용되며 본인부담금과 간병비가 별도로 발생합니다.",
  },
  {
    id: "f07", name: "달가온 방문요양센터", type: "homecare", region: "incheon", city: "부평구",
    address: "인천광역시 부평구 부평대로 77", monthlyFee: 28, entryFee: 0,
    levels: ["l3", "l4", "l5", "cog"], features: ["입소금 없음", "도심 접근성 우수"],
    vacancy: 20, capacity: 0, opened: "2017", nurse24: false, rating: 4.3, reviews: 55, color: "#1f8a4c",
    phone: "032-444-5566",
    desc: "요양보호사가 가정을 방문해 목욕·식사·이동을 돕고 말벗이 되어드립니다. 장기요양 등급에 따른 재가급여 한도 내에서 본인부담 15%로 이용할 수 있습니다.",
  },
  {
    id: "f08", name: "푸른솔 요양원", type: "nursing", region: "gyeongnam", city: "김해시",
    address: "경상남도 김해시 분성로 210", monthlyFee: 152, entryFee: 200,
    levels: ["l1", "l2", "l3", "l4"], features: ["숲·자연 환경", "종교시설 인접", "전담 영양사", "부부실 가능"],
    vacancy: 6, capacity: 110, opened: "2015", nurse24: true, rating: 4.4, reviews: 87, color: "#3f8f3f",
    phone: "055-321-7654",
    desc: "야트막한 산으로 둘러싸인 110인 규모 요양원입니다. 텃밭과 산책로가 잘 조성되어 있고, 인근에 성당·교회·사찰이 있어 종교 활동이 가능합니다. 부부 어르신을 위한 2인실을 보유합니다.",
  },
  {
    id: "f09", name: "한아름 케어빌리지", type: "nursing", region: "jeju", city: "제주시",
    address: "제주특별자치도 제주시 애월읍 하귀로 88", monthlyFee: 198, entryFee: 800,
    levels: ["l1", "l2", "l3"], features: ["반려동물 동반", "숲·자연 환경", "온천·스파 시설", "신축 건물", "1인실 보유"],
    vacancy: 4, capacity: 60, opened: "2023", nurse24: true, rating: 4.9, reviews: 33, color: "#2e8b57",
    phone: "064-900-2200",
    desc: "제주 바다가 보이는 신축 요양시설입니다. 반려동물과 함께 입소할 수 있는 전용 세대를 운영하며, 지열을 이용한 스파 시설과 전 객실 1인실 구조가 특징입니다.",
  },
  {
    id: "f10", name: "늘봄 주야간보호센터", type: "daycare", region: "daejeon", city: "유성구",
    address: "대전광역시 유성구 대학로 199", monthlyFee: 49, entryFee: 0,
    levels: ["l3", "l4", "l5", "cog", "none"], features: ["입소금 없음", "재활 전문 프로그램", "물리치료실", "도심 접근성 우수"],
    vacancy: 10, capacity: 40, opened: "2021", nurse24: false, rating: 4.6, reviews: 48, color: "#e0912f",
    phone: "042-611-3300",
    desc: "대학 인근에 위치해 학생 봉사·세대 교류 프로그램이 활발한 주야간보호센터입니다. 작업치료사가 상주하며 개인별 재활 목표를 세워 관리합니다.",
  },
  {
    id: "f11", name: "봄뜰 단기보호센터", type: "respite", region: "gyeonggi", city: "성남시",
    address: "경기도 성남시 분당구 판교로 300", monthlyFee: 60, entryFee: 0,
    levels: ["l1", "l2", "l3", "l4", "l5"], features: ["입소금 없음", "24시간 간호사 상주", "신축 건물", "도심 접근성 우수"],
    vacancy: 7, capacity: 25, opened: "2022", nurse24: true, rating: 4.5, reviews: 29, color: "#5aa85a",
    phone: "031-707-1212",
    desc: "가족 돌봄자가 잠시 쉬어갈 수 있도록 최대 월 9일 단기보호를 제공합니다. 당일 입소 상담이 가능하며, 요양원 입소 전 적응 체험 용도로도 많이 이용됩니다.",
  },
  {
    id: "f12", name: "안식처 완화의료병동", type: "hospital", region: "seoul", city: "서대문구",
    address: "서울특별시 서대문구 연세로 50", monthlyFee: 230, entryFee: 0,
    levels: ["l1", "l2"], features: ["입소금 없음", "24시간 간호사 상주", "호스피스·완화 케어", "종교시설 인접", "전담 영양사"],
    vacancy: 2, capacity: 30, opened: "2013", nurse24: true, rating: 4.7, reviews: 156, color: "#d46e84",
    phone: "02-361-5000",
    desc: "말기 환자와 가족의 삶의 질을 돌보는 완화의료 전문 병동입니다. 통증 관리, 심리·영적 돌봄, 사별 가족 지원 프로그램을 운영하며 1인실 위주로 구성되어 있습니다.",
  },
];

const GUIDES = [
  { cat: "제도 이해", title: "요양시설 종류, 한눈에 정리", desc: "요양원·그룹홈·주야간보호·요양병원은 무엇이 다를까요? 우리 가족에게 맞는 유형을 찾는 법.", color: "#2e8b57" },
  { cat: "신청 절차", title: "장기요양등급 신청부터 판정까지", desc: "국민건강보험공단 신청 → 방문조사 → 등급판정위원회. 준비물과 소요 기간을 안내합니다.", color: "#3a9bd4" },
  { cat: "비용", title: "노인장기요양보험, 얼마나 지원되나요?", desc: "시설급여 본인부담 20%, 재가급여 15%. 감경 대상과 비급여 항목까지 계산해 봅니다.", color: "#e0912f" },
  { cat: "시설 선택", title: "요양원 견학 체크리스트 25가지", desc: "냄새, 직원 표정, 식단표, 야간 인력, 계약서 독소조항까지 — 현장에서 꼭 확인할 것들.", color: "#8367d8" },
  { cat: "입소 준비", title: "입소 전 준비물과 계약 시 주의사항", desc: "필요 서류, 개인 물품, 표준약관 확인, 보증금 반환 조건을 미리 챙기세요.", color: "#5aa85a" },
  { cat: "치매 돌봄", title: "치매 어르신, 시설 적응을 돕는 법", desc: "초기 면회 빈도, 익숙한 물건, 이별 인사 방법 등 적응기를 함께 넘기는 요령.", color: "#b5546a" },
];

const FAQS = [
  { q: "장기요양등급이 없어도 입소할 수 있나요?", a: "노인복지주택(실버타운)과 양로시설은 등급 없이 입소할 수 있습니다. 다만 요양원·그룹홈 등 장기요양기관은 원칙적으로 1~5등급 또는 인지지원등급 판정이 필요합니다. 등급이 없다면 국민건강보험공단에 장기요양 인정 신청을 먼저 진행하세요." },
  { q: "월 이용료에는 무엇이 포함되나요?", a: "시설급여 본인부담금(장기요양보험 수가의 20%)과 식재료비·간식비, 상급 침실 이용료, 이·미용비 등 비급여 항목이 더해집니다. 시설마다 비급여 구성이 다르므로 반드시 '표준 계약서'와 '월 비용 내역서'를 받아 비교하세요." },
  { q: "국가 지원은 얼마나 받을 수 있나요?", a: "장기요양보험이 시설급여 비용의 80%를 부담합니다. 의료급여 수급자, 차상위 계층 등은 본인부담금을 40~60% 추가 경감받을 수 있습니다. 자세한 감경 여부는 공단(1577-1000)에서 확인 가능합니다." },
  { q: "입소까지 얼마나 걸리나요?", a: "공실이 있는 시설은 서류 준비 후 3~7일 내 입소가 가능합니다. 인기 지역·소규모 시설은 대기가 수개월 걸리기도 합니다. 케어홈즈 무료 상담을 이용하면 여러 시설의 실시간 공실을 한 번에 확인할 수 있습니다." },
  { q: "견학은 어떻게 신청하나요?", a: "각 시설 상세 페이지의 '견학·상담 신청' 버튼을 누르거나, 케어홈즈 무료 상담(1600-0000)으로 연락 주시면 상담원이 방문 일정을 조율해 드립니다. 가능하면 식사 시간대에 방문해 실제 급식과 분위기를 확인하시길 권합니다." },
];

/* ---------- 공통 유틸 ---------- */
function typeName(code) { const t = FACILITY_TYPES.find(x => x.code === code); return t ? t.name : code; }
function regionName(code) { const r = REGIONS.find(x => x.code === code); return r ? r.name : code; }
function levelName(code) { const l = CARE_LEVELS.find(x => x.code === code); return l ? l.name : code; }
function won(manwon) {
  if (manwon >= 10000) return (manwon / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "억 원";
  return manwon.toLocaleString("ko-KR") + "만 원";
}
