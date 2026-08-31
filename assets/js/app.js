/* =========================================================
   120 라이프홈즈 — 공통 스크립트
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
      <img src="assets/logo.svg" alt="120 LIFE homes" class="logo-img">
      <span class="logo-tag">전국 요양시설<br>정보 리뷰 포털</span>
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
        <h4>120 라이프홈즈</h4>
        <p>우리 가족에게 맞는 요양시설을, 전국 어디서나 쉽고 투명하게 찾을 수 있도록 돕는 요양시설 검색 플랫폼입니다.</p>
        <p style="margin-top:10px">고객센터 <strong style="color:#fff">1600-0000</strong> (평일 09:00–18:00)</p>
      </div>
      <div><h4>시설 찾기</h4><ul>
        <li><a href="search.html?type=%EB%85%B8%EC%9D%B8%EC%9A%94%EC%96%91%EC%8B%9C%EC%84%A4">노인요양시설(요양원)</a></li>
        <li><a href="search.html?type=%EB%85%B8%EC%9D%B8%EC%9A%94%EC%96%91%EA%B3%B5%EB%8F%99%EC%83%9D%ED%99%9C%EA%B0%80%EC%A0%95">그룹홈</a></li>
        <li><a href="search.html?type=%EC%A3%BC%EC%95%BC%EA%B0%84%EB%B3%B4%ED%98%B8">주야간보호</a></li>
        <li><a href="search.html?type=%EB%B0%A9%EB%AC%B8%EC%9A%94%EC%96%91">방문요양</a></li>
        <li><a href="search.html">전체 시설 검색</a></li>
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
      시설 정보는 <strong>국민건강보험공단</strong>이 공공데이터포털을 통해 제공하는 「장기요양기관 검색」 데이터를 기반으로 하며 매일 갱신됩니다.
      상세 주소·정원·평가등급 등 일부 항목은 순차적으로 보강 중이며, 최신·정확한 정보는 해당 기관 또는
      <em>국민건강보험공단(1577-1000)</em>에 확인하시기 바랍니다. 화면 구성은 일본 <em>LIFULL 介護</em>를 참고했습니다.<br>
      © 2026 120lifehomes (120 라이프홈즈). All rights reserved.
    </div>
  </div></footer>`;

  document.getElementById("chrome-header").innerHTML = header;
  document.getElementById("chrome-footer").innerHTML = footer;
  if (activePage) {
    const link = document.querySelector(`nav.main a[data-p="${activePage}"]`);
    if (link) link.classList.add("active");
  }
}

/* ---------- 시설 카드 HTML (공공데이터 기반) ---------- */
const _typeColor = {
  "노인요양시설": "#1f8a4c", "노인요양공동생활가정": "#5aa85a", "주야간보호": "#f47b20",
  "단기보호": "#8367d8", "방문요양": "#3a9bd4", "방문간호": "#2f7fb5", "방문목욕": "#3f8f3f",
  "복지용구": "#b5546a", "재가노인지원": "#6a7a8a",
};
function typeColor(t) { return _typeColor[t] || "#6a7a8a"; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function sgName(f) {
  return f.sigungu_nm || (typeof sigunguName === "function" && sigunguName(f.sigungu)) || "";
}
function gradeBadge(g) {
  if (!g) return "";
  const col = { A: "#1f8a4c", B: "#3a9bd4", C: "#e0912f", D: "#c0663a", E: "#b5546a" }[g] || "#6a7a8a";
  return `<span style="display:inline-block;background:${col};color:#fff;border-radius:5px;padding:1px 7px;font-size:.82rem;font-weight:800">평가 ${g}</span>`;
}
function facilityCardHTML(f) {
  const c = typeColor(f.type_label);
  const region = [f.sido, sgName(f), f.dong_nm].filter(Boolean).join(" ");
  const isResidential = ["노인요양시설", "노인요양공동생활가정"].includes(f.type_label);
  const addrShort = f.address || region;
  return `
  <a class="facility-card" href="facility.html?id=${encodeURIComponent(f.id)}">
    <div class="thumb" style="background:linear-gradient(135deg,${c},${c}cc)">
      <span class="badge" style="background:rgba(255,255,255,.92);color:${c}">${esc(f.type_label || "장기요양기관")}</span>
    </div>
    <div class="body">
      <div class="type-label">${esc(f.type_label || "장기요양기관")} ${gradeBadge(f.eval_grade)}</div>
      <h3>${esc(f.name)}</h3>
      <div class="addr">${esc(addrShort) || "지역 정보 준비중"}</div>
      <div class="meta">
        <div>전화<strong>${f.phone ? esc(f.phone) : "준비중"}</strong></div>
        ${isResidential
          ? `<div>정원<strong>${f.capacity != null ? f.capacity + "명" : "-"}</strong></div>
             <div>현원<strong>${f.current_count != null ? f.current_count + "명" : "준비중"}</strong></div>
             <div>지정일<strong>${f.established_at ? ymd(f.established_at) : "-"}</strong></div>`
          : `<div>지정일<strong>${f.established_at ? ymd(f.established_at) : "-"}</strong></div>
             <div>우편<strong>${f.post_no || "-"}</strong></div>
             <div></div>`}
      </div>
    </div>
  </a>`;
}

/* ---------- 쿼리스트링 ---------- */
function qs() {
  return Object.fromEntries(new URLSearchParams(location.search).entries());
}
