/* =========================================================
   케어홈즈 — 공통 스크립트
   ========================================================= */

/* ---------- 글자 크기 조절 (접근성) ---------- */
(function () {
  const saved = localStorage.getItem("ch-fs");
  if (saved) document.body.classList.add(saved);
  window.setFontSize = function (size) {
    document.body.classList.remove("fs-large", "fs-xlarge");
    if (size === "large") document.body.classList.add("fs-large");
    if (size === "xlarge") document.body.classList.add("fs-xlarge");
    localStorage.setItem("ch-fs", size === "normal" ? "" : "fs-" + size);
  };
})();

/* ---------- 모바일 메뉴 ---------- */
window.toggleMenu = function () {
  document.querySelector("nav.main")?.classList.toggle("open");
};

/* ---------- 공통 헤더/푸터 주입 ---------- */
function mountChrome(activePage) {
  const header = `
  <div class="access-bar"><div class="wrap">
    <span>어르신도 보기 편한 큰 글씨 지원</span>
    <div class="fs-controls">
      <span>글자 크기</span>
      <button onclick="setFontSize('normal')">가</button>
      <button onclick="setFontSize('large')" style="font-size:1.05rem">가</button>
      <button onclick="setFontSize('xlarge')" style="font-size:1.2rem">가</button>
    </div>
  </div></div>
  <header class="site"><div class="wrap">
    <a href="index.html" class="logo">
      <svg viewBox="0 0 48 48" fill="none"><path d="M24 4 6 18v24a2 2 0 0 0 2 2h32a2 2 0 0 0 2-2V18L24 4Z" fill="#1f8a4c"/><path d="M24 22a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm-9 15c0-5 4-8 9-8s9 3 9 8v2H15v-2Z" fill="#fff"/></svg>
      <span>케어홈즈<small>전국 요양시설 검색</small></span>
    </a>
    <button class="menu-toggle" onclick="toggleMenu()" aria-label="메뉴">☰</button>
    <nav class="main"><ul>
      <li><a href="search.html" data-p="search">시설 찾기</a></li>
      <li><a href="guide.html" data-p="guide">돌봄 가이드</a></li>
      <li><a href="consult.html" data-p="consult">무료 입소 상담</a></li>
      <li><a href="consult.html" class="cta">전화 상담 1600-0000</a></li>
    </ul></nav>
  </div></header>`;

  const footer = `
  <div class="cta-banner"><div class="wrap">
    <h2>어디서부터 알아봐야 할지 막막하신가요?</h2>
    <p>요양 상담 전문가가 조건에 맞는 시설을 무료로 골라 드립니다.</p>
    <a href="consult.html" class="btn btn-ghost btn-lg">무료 상담 신청하기</a>
  </div></div>
  <footer class="site"><div class="wrap">
    <div class="cols">
      <div>
        <h4>케어홈즈</h4>
        <p>우리 가족에게 맞는 요양시설을, 전국 어디서나 쉽고 투명하게 찾을 수 있도록 돕는 요양시설 검색 플랫폼입니다.</p>
        <p style="margin-top:10px">고객센터 <strong style="color:#fff">1600-0000</strong> (평일 09:00–18:00)</p>
      </div>
      <div><h4>시설 찾기</h4><ul>
        <li><a href="search.html?type=nursing">노인요양시설</a></li>
        <li><a href="search.html?type=grouphome">그룹홈</a></li>
        <li><a href="search.html?type=daycare">주야간보호센터</a></li>
        <li><a href="search.html?type=silvertown">실버타운</a></li>
        <li><a href="search.html?type=hospital">요양병원</a></li>
      </ul></div>
      <div><h4>가이드</h4><ul>
        <li><a href="guide.html">장기요양등급 신청</a></li>
        <li><a href="guide.html">비용·지원 제도</a></li>
        <li><a href="guide.html">시설 견학 체크리스트</a></li>
        <li><a href="guide.html">치매 돌봄</a></li>
      </ul></div>
      <div><h4>회사</h4><ul>
        <li><a href="#">회사 소개</a></li>
        <li><a href="#">시설 등록 문의</a></li>
        <li><a href="#">채용</a></li>
        <li><a href="#">이용약관 · 개인정보처리방침</a></li>
      </ul></div>
    </div>
    <div class="disclaimer">
      본 사이트는 일본 최대 요양시설 검색 사이트 <em>LIFULL 介護(kaigo.homes.co.jp)</em>의 정보 구조를 참고하여
      한국 노인장기요양보험 제도에 맞게 재구성한 <strong>데모(포트폴리오) 프로젝트</strong>입니다.
      게시된 시설명·주소·연락처·요금·후기는 모두 가상의 예시이며 실제 기관과 무관합니다.<br>
      © 2026 CareHomes Demo. All rights reserved.
    </div>
  </div></footer>`;

  document.getElementById("chrome-header").innerHTML = header;
  document.getElementById("chrome-footer").innerHTML = footer;
  if (activePage) {
    const link = document.querySelector(`nav.main a[data-p="${activePage}"]`);
    if (link) link.classList.add("active");
  }
}

/* ---------- 시설 카드 HTML ---------- */
function facilityCardHTML(f) {
  const vac = f.type === "homecare"
    ? `<span class="badge">상시 이용 가능</span>`
    : (f.vacancy > 0
        ? `<span class="badge">공실 ${f.vacancy}자리</span>`
        : `<span class="badge full">대기 접수 중</span>`);
  const feeLabel = (f.type === "daycare" || f.type === "homecare" || f.type === "respite")
    ? "월 본인부담(예상)" : "월 이용료(예상)";
  return `
  <a class="facility-card" href="facility.html?id=${f.id}">
    <div class="thumb" style="background:linear-gradient(135deg,${f.color},${f.color}cc)">${vac}</div>
    <div class="body">
      <div class="type-label">${typeName(f.type)}</div>
      <h3>${f.name}</h3>
      <div class="addr">${regionName(f.region)} ${f.city} · ${f.address}</div>
      <div class="tags">${f.features.slice(0, 4).map(t => `<span>${t}</span>`).join("")}</div>
      <div class="meta">
        <div>${feeLabel}<strong class="fee">${won(f.monthlyFee)}</strong></div>
        <div>입소보증금<strong>${f.entryFee === 0 ? "없음" : won(f.entryFee)}</strong></div>
        <div>이용 정원<strong>${f.capacity === 0 ? "재가" : f.capacity + "명"}</strong></div>
        <div>이용자 평가<strong class="rating">★ ${f.rating.toFixed(1)} <small>(${f.reviews})</small></strong></div>
      </div>
    </div>
  </a>`;
}

/* ---------- 쿼리스트링 ---------- */
function qs() {
  return Object.fromEntries(new URLSearchParams(location.search).entries());
}
