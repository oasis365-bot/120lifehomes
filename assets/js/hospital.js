/* =========================================================
   120 라이프홈즈 — 요양병원 검색·상세 화면 (1B-4D)
   ---------------------------------------------------------
   · additive. 기존 LTC 화면(search.html / facility.html / app.js …)과 무관.
   · hospital_module 이 켜지기 전까지는 "준비 중" 안내만 노출한다.
   · API 응답값은 전부 textContent / createElement 로만 DOM 에 넣는다.
     innerHTML / insertAdjacentHTML / document.write 를 쓰지 않는다.
   · 사용하는 API: GET /api/hospital/facilities  ·  GET /api/hospital/facility?id=
   · raw / hira_ykiho / external_id / normalized_hash / source 상태는 쓰지도 표시하지도 않는다.
   ========================================================= */
(function (global) {
  'use strict';

  var API_LIST = '/api/hospital/facilities';
  var API_DETAIL = '/api/hospital/facility';
  var PAGE_SIZE = 20;
  var NONE = '정보 없음';

  // ── 병상 세부 / 실 구분 라벨 (알 수 없는 키는 표시하지 않는다) ──
  var BED_LABELS = {
    standard: '일반 병상', higher: '상급 병상', isolation: '격리 병상',
    negative_pressure: '음압격리 병상', day_ward: '낮병동',
    psych_closed_general: '정신과 폐쇄병동(일반)', psych_closed_higher: '정신과 폐쇄병동(상급)',
    psych_open_general: '정신과 개방병동(일반)', psych_open_higher: '정신과 개방병동(상급)'
  };
  var ROOM_LABELS = {
    operating: '수술실', emergency: '응급실', delivery: '분만실', physical_therapy: '물리치료실',
    newborn: '신생아실', child_recovery: '소아 회복실', adult_child_recovery: '성인·소아 회복실'
  };

  /* ---------------- 순수 헬퍼 ---------------- */

  // 값이 실제로 있는지 (0·false 는 유효값, null/undefined/''/공백만 은 없음)
  function hasValue(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }

  // 날짜(YYYY-MM-DD 또는 ISO) → "YYYY.MM.DD" (형식 이상하면 빈 문자열)
  function fmtDate(v) {
    if (!hasValue(v)) return '';
    var s = String(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[1] + '.' + m[2] + '.' + m[3] : '';
  }

  // 홈페이지 URL: http:/https: 만 허용. javascript:/data:/mailto: 및 형식오류는 null.
  function safeExternalUrl(raw) {
    if (!hasValue(raw)) return null;
    var s = String(raw).trim();
    var u;
    try { u = new URL(s); } catch (e) {
      try { u = new URL('https://' + s); } catch (e2) { return null; }
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  }

  // 목록 API 요청 URL — 사용자 입력은 URLSearchParams 값으로만 전달
  function buildListUrl(state) {
    var p = new URLSearchParams();
    if (hasValue(state.q)) p.set('q', String(state.q).trim());
    if (hasValue(state.sido)) p.set('sido', String(state.sido).trim());
    if (hasValue(state.sigungu)) p.set('sigungu', String(state.sigungu).trim());
    p.set('page', String(Math.max(1, parseInt(state.page, 10) || 1)));
    p.set('size', String(PAGE_SIZE));
    return API_LIST + '?' + p.toString();
  }

  function buildDetailUrl(id) {
    var p = new URLSearchParams();
    p.set('id', String(id == null ? '' : id));
    return API_DETAIL + '?' + p.toString();
  }

  // 상세 페이지(정적 HTML) 링크 — id 는 URLSearchParams 로만, from 은 검색 복귀용
  function detailPageHref(id, backSearch) {
    var p = new URLSearchParams();
    p.set('id', String(id == null ? '' : id));
    if (backSearch && backSearch.charAt(0) === '?') {
      p.set('from', backSearch.slice(1));
    }
    return 'hospital-facility.html?' + p.toString();
  }

  // 브라우저 주소창에 반영할 검색 상태 쿼리스트링 ('' = 조건 없음)
  function stateToSearch(state) {
    state = state || {};
    var p = new URLSearchParams();
    if (hasValue(state.q)) p.set('q', String(state.q).trim());
    if (hasValue(state.sido)) p.set('sido', String(state.sido).trim());
    if (hasValue(state.sigungu)) p.set('sigungu', String(state.sigungu).trim());
    if ((parseInt(state.page, 10) || 1) > 1) p.set('page', String(parseInt(state.page, 10)));
    var s = p.toString();
    return s ? '?' + s : '';
  }

  // HTTP 상태 → 사용자 문구 (내부 오류·URL·쿼리·stack 미노출)
  function userErrorMessage(status) {
    if (status === 400) return '검색 조건을 다시 확인해 주세요.';
    if (status === 404) return '요청하신 요양병원 정보를 찾을 수 없습니다.';
    if (status === 503) return '지금은 정보를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.';
    return '일시적인 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  }

  function pageText(page, size, total) {
    var from = total === 0 ? 0 : (page - 1) * size + 1;
    var to = Math.min(page * size, total);
    return total === 0 ? '검색 결과가 없습니다' : (from + '–' + to + ' / 전체 ' + total.toLocaleString() + '곳');
  }

  /* ---------------- DOM 빌더 (createElement / textContent 만) ---------------- */

  function doc() { return (typeof document !== 'undefined') ? document : global.document; }

  function el(tag, opts) {
    var e = doc().createElement(tag);
    opts = opts || {};
    if (opts.className) e.className = opts.className;
    if (opts.text != null) e.textContent = String(opts.text);
    if (opts.attrs) {
      for (var k in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, k) && opts.attrs[k] != null) {
          e.setAttribute(k, String(opts.attrs[k]));
        }
      }
    }
    if (opts.children) {
      for (var i = 0; i < opts.children.length; i++) {
        if (opts.children[i]) e.appendChild(opts.children[i]);
      }
    }
    return e;
  }

  // 스펙 표의 한 행 — 값이 없으면 "정보 없음" (일관 규칙: 항상 표시)
  function specRow(label, value) {
    var td = el('td', {});
    if (hasValue(value)) td.textContent = String(value);
    else { td.textContent = NONE; td.className = 'none'; }
    return el('tr', { children: [el('th', { text: label }), td] });
  }

  // 값이 없으면 행 자체를 생략 (일관 규칙: 옵셔널)
  function optionalRow(label, value) {
    return hasValue(value) ? specRow(label, value) : null;
  }

  function gradeLabel(grade) {
    var g = String(grade == null ? '' : grade).trim();
    if (g === '') return '';
    if (/^[1-5]$/.test(g)) return g + '등급';
    return g; // "등급제외" 등 원문 유지 (A~E 등 타 체계로 환산하지 않는다)
  }

  // 목록 카드 (공개 응답값만)
  function facilityCard(item, backSearch) {
    item = item || {};
    var f = item.facility || {};
    var prof = item.profile || null;
    var evalv = item.evaluation || null;

    var titleParts = [];
    titleParts.push(el('h3', { text: hasValue(f.name) ? f.name : '(이름 미확인)' }));

    var g = evalv && gradeLabel(evalv.grade);
    if (g) {
      titleParts.push(el('span', { className: 'grade-chip', text: '적정성평가 ' + g,
        attrs: { 'aria-label': '요양병원 입원급여 적정성평가 ' + g } }));
    }

    var metaChildren = [];
    metaChildren.push(el('div', { children: [
      el('span', { className: 'k', text: '전화' }),
      el('strong', { text: hasValue(f.phone) ? f.phone : NONE })
    ] }));
    metaChildren.push(el('div', { children: [
      el('span', { className: 'k', text: '설립일' }),
      el('strong', { text: fmtDate(f.established_at) || NONE })
    ] }));
    if (prof && hasValue(prof.bed_total)) {
      metaChildren.push(el('div', { children: [
        el('span', { className: 'k', text: '병상 수' }),
        el('strong', { text: Number(prof.bed_total).toLocaleString() + '병상' })
      ] }));
    }

    var body = [
      el('div', { className: 'h-card-head', children: titleParts }),
      el('div', { className: 'h-card-addr', text: hasValue(f.address) ? f.address : NONE })
    ];

    if (prof && Array.isArray(prof.specialties) && prof.specialties.length) {
      var shown = prof.specialties.filter(hasValue).slice(0, 5);
      var extra = prof.specialties.filter(hasValue).length - shown.length;
      var tags = shown.map(function (s) { return el('span', { className: 'tag', text: s }); });
      if (extra > 0) tags.push(el('span', { className: 'tag more', text: '+' + extra }));
      body.push(el('div', { className: 'h-card-tags', children: tags }));
    }

    body.push(el('div', { className: 'h-card-meta', children: metaChildren }));

    var link = el('a', {
      className: 'h-card-more',
      text: '상세 보기',
      attrs: {
        href: detailPageHref(f.id, backSearch),
        'aria-label': (hasValue(f.name) ? f.name : '요양병원') + ' 상세 보기'
      }
    });
    body.push(link);

    return el('article', { className: 'h-card', children: [el('div', { className: 'h-card-body', children: body })] });
  }

  function renderList(container, items, backSearch) {
    var frag = doc().createDocumentFragment();
    (items || []).forEach(function (it) { frag.appendChild(facilityCard(it, backSearch)); });
    container.textContent = '';
    container.appendChild(frag);
  }

  // 상세 화면
  function renderDetail(container, data, opts) {
    opts = opts || {};
    data = data || {};
    var f = data.facility || {};
    var prof = data.profile || null;
    var evalv = data.evaluation || null;

    container.textContent = '';
    var root = el('div', { className: 'h-detail' });

    // 헤더
    var head = el('div', { className: 'h-detail-head' });
    head.appendChild(el('div', { className: 'h-detail-kicker', text: '요양병원' }));
    head.appendChild(el('h1', { text: hasValue(f.name) ? f.name : '(이름 미확인)' }));
    var loc = [f.sido, f.sigungu_nm, f.dong_nm].filter(hasValue).join(' ');
    if (loc) head.appendChild(el('div', { className: 'h-detail-loc', text: loc }));
    root.appendChild(head);

    // 기본 정보
    var basicRows = [
      specRow('주소', f.address),
      specRow('전화', f.phone),
      optionalRow('설립구분', prof && prof.establishment_type),
      specRow('설립일', fmtDate(f.established_at) || null)
    ].filter(Boolean);
    var hp = safeExternalUrl(prof && prof.homepage);
    if (hp) {
      basicRows.push(el('tr', { children: [
        el('th', { text: '홈페이지' }),
        el('td', { children: [el('a', { text: hp, attrs: { href: hp, target: '_blank', rel: 'noopener noreferrer nofollow' } })] })
      ] }));
    }
    root.appendChild(section('기본 정보', [table(basicRows)]));

    // 병상
    if (prof && (hasValue(prof.bed_total) || hasValue(prof.bed_detail))) {
      var bedRows = [];
      if (hasValue(prof.bed_total)) bedRows.push(specRow('허가 병상 총수', Number(prof.bed_total).toLocaleString() + '병상'));
      var bd = prof.bed_detail && typeof prof.bed_detail === 'object' ? prof.bed_detail : null;
      if (bd) {
        Object.keys(BED_LABELS).forEach(function (key) {
          if (hasValue(bd[key])) bedRows.push(specRow(BED_LABELS[key], Number(bd[key]).toLocaleString() + '병상'));
        });
        var rooms = bd.rooms && typeof bd.rooms === 'object' ? bd.rooms : null;
        if (rooms) {
          Object.keys(ROOM_LABELS).forEach(function (key) {
            if (hasValue(rooms[key])) bedRows.push(specRow(ROOM_LABELS[key], Number(rooms[key]).toLocaleString() + '실'));
          });
        }
      }
      if (bedRows.length) root.appendChild(section('병상 정보', [table(bedRows)]));
    }

    // 진료과목
    if (prof && Array.isArray(prof.specialties) && prof.specialties.filter(hasValue).length) {
      var chips = prof.specialties.filter(hasValue).map(function (s) { return el('span', { className: 'tag', text: s }); });
      root.appendChild(section('진료과목', [el('div', { className: 'h-chips', children: chips })]));
    }

    // 전문의 현황
    if (prof && prof.specialist_counts && typeof prof.specialist_counts === 'object' && Object.keys(prof.specialist_counts).length) {
      var scRows = [];
      Object.keys(prof.specialist_counts).forEach(function (name) {
        var c = prof.specialist_counts[name];
        if (hasValue(name) && hasValue(c)) scRows.push(specRow(name, Number(c).toLocaleString() + '명'));
      });
      if (scRows.length) root.appendChild(section('전문의 현황', [table(scRows)]));
    }

    // 의료장비
    if (prof && Array.isArray(prof.equipment) && prof.equipment.length) {
      var eqRows = [];
      prof.equipment.forEach(function (item) {
        if (!item || !hasValue(item.name)) return;
        var cnt = hasValue(item.count) ? Number(item.count).toLocaleString() + '대' : '';
        eqRows.push(specRow(String(item.name), cnt || '보유'));
      });
      if (eqRows.length) root.appendChild(section('의료장비', [table(eqRows)]));
    }

    // medical_services — 상태 enum(VERIFIED_TRUE/FALSE·UNKNOWN·FACILITY_CLAIMED)의
    //  사용자 노출 계약과 키 이름 매핑이 아직 확정되지 않았고, 현재 파이프라인은 항상 {}
    //  를 저장한다. 계약 확정 전까지 이 섹션은 렌더링하지 않는다 (원문 상태 문자열 노출 금지).

    // 평가 정보
    if (evalv && (hasValue(evalv.grade) || hasValue(evalv.evaluation_name))) {
      var evRows = [];
      evRows.push(specRow('평가명', hasValue(evalv.evaluation_name) ? evalv.evaluation_name : '요양병원 입원급여 적정성평가'));
      if (hasValue(evalv.grade)) evRows.push(specRow('등급', gradeLabel(evalv.grade)));
      evRows.push(optionalRow('평가 연도', hasValue(evalv.evaluation_year) ? String(evalv.evaluation_year) : null));
      var col = fmtDate(evalv.collected_at);
      if (col) evRows.push(specRow('정보 수집일', col));
      var authority = hasValue(evalv.evaluation_authority) ? evalv.evaluation_authority : null;
      var note = el('p', { className: 'h-note',
        text: (authority === 'HIRA' ? '건강보험심사평가원' : (authority || '평가기관')) +
          ' 적정성평가 결과입니다. 다른 평가체계(요양원 A~E 등)와 등급을 서로 환산하지 않습니다.' });
      root.appendChild(section('적정성평가', [table(evRows.filter(Boolean)), note]));
    }

    // 목록으로 돌아가기
    var backHref = hasValue(opts.backSearch) ? ('hospital.html' + opts.backSearch) : 'hospital.html';
    var back = el('a', { className: 'h-back', text: '← 목록으로 돌아가기', attrs: { href: backHref } });
    root.appendChild(back);

    container.appendChild(root);
  }

  function section(title, children) {
    return el('section', { className: 'h-section', children: [el('h2', { text: title })].concat(children || []) });
  }
  function table(rows) {
    return el('table', { className: 'h-spec', children: [el('tbody', { children: rows })] });
  }

  /* ---------------- 기능 플래그 ---------------- */

  function checkHospitalFlag(fetchImpl) {
    return fetchImpl('/api/flags').then(function (r) {
      return r.json();
    }).then(function (d) {
      return !!(d && d.hospital_module === true);
    }).catch(function () {
      return false;
    });
  }

  /* ---------------- 검색 컨트롤러 ---------------- */

  function initSearch(root, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var hist = deps.history || (typeof history !== 'undefined' ? history : null);
    var loc = deps.location || (typeof location !== 'undefined' ? location : { search: '', pathname: 'hospital.html' });
    var d = doc();

    var elPrep = root.querySelector('[data-h="prep"]');
    var elSearch = root.querySelector('[data-h="search"]');
    var elForm = root.querySelector('[data-h="form"]');
    var elQ = root.querySelector('[data-h="q"]');
    var elSido = root.querySelector('[data-h="sido"]');
    var elSigungu = root.querySelector('[data-h="sigungu"]');
    var elReset = root.querySelector('[data-h="reset"]');
    var elCount = root.querySelector('[data-h="count"]');
    var elList = root.querySelector('[data-h="list"]');
    var elStatus = root.querySelector('[data-h="status"]');
    var elPager = root.querySelector('[data-h="pager"]');
    var elPrev = root.querySelector('[data-h="prev"]');
    var elNext = root.querySelector('[data-h="next"]');
    var elPageInfo = root.querySelector('[data-h="pageinfo"]');

    var seq = 0;
    var ctrl = null;
    var lastWasLastPage = false;
    var state = readState();

    populateRegions();
    applyStateToForm();

    return checkHospitalFlag(fetchImpl).then(function (on) {
      if (!on) {
        show(elPrep, true);
        show(elSearch, false);
        return; // flag OFF: 병원 목록·상세 API 를 호출하지 않는다
      }
      show(elPrep, false);
      show(elSearch, true);

      if (elForm) {
        elForm.addEventListener('submit', function (e) {
          if (e && e.preventDefault) e.preventDefault();
          state = readForm();
          state.page = 1;
          run(true);
        });
      }
      if (elReset) {
        elReset.addEventListener('click', function () {
          if (elQ) elQ.value = '';
          if (elSido) elSido.value = '';
          populateSigungu('');
          state = { q: '', sido: '', sigungu: '', page: 1 };
          run(true);
        });
      }
      if (elSido) {
        elSido.addEventListener('change', function () { populateSigungu(elSido.value); });
      }
      if (elPrev) elPrev.addEventListener('click', function () { if (state.page > 1) { state.page -= 1; run(false); } });
      if (elNext) elNext.addEventListener('click', function () { if (!lastWasLastPage) { state.page += 1; run(false); } });

      if (deps.onReady) deps.onReady({ run: run, getState: function () { return state; } });

      // 최초: URL 에 조건이 있으면 즉시 검색, 없으면 전체 첫 페이지
      run(false);
    });

    /* ---- 내부 ---- */

    function readState() {
      var p = new URLSearchParams(loc.search || '');
      return {
        q: p.get('q') || '',
        sido: p.get('sido') || '',
        sigungu: p.get('sigungu') || '',
        page: Math.max(1, parseInt(p.get('page'), 10) || 1)
      };
    }
    function readForm() {
      return {
        q: elQ ? elQ.value.trim() : '',
        sido: elSido ? elSido.value : '',
        sigungu: elSigungu ? elSigungu.value : '',
        page: 1
      };
    }
    function applyStateToForm() {
      if (elQ) elQ.value = state.q || '';
      if (elSido) elSido.value = state.sido || '';
      populateSigungu(state.sido || '');
      if (elSigungu) elSigungu.value = state.sigungu || '';
    }
    function populateRegions() {
      if (!elSido || typeof REGIONS === 'undefined') return;
      var seen = {};
      for (var i = 0; i < REGIONS.length; i++) {
        var r = REGIONS[i];
        var full = (typeof SIDO_FULL !== 'undefined' && SIDO_FULL[r.name]) || r.name;
        if (seen[full]) continue; seen[full] = 1;
        var o = d.createElement('option');
        o.value = full; o.textContent = full;
        elSido.appendChild(o);
      }
    }
    function populateSigungu(sidoFullName) {
      if (!elSigungu) return;
      elSigungu.textContent = '';
      var first = d.createElement('option');
      first.value = ''; first.textContent = '시·군·구 전체';
      elSigungu.appendChild(first);
      if (typeof REGIONS === 'undefined' || typeof SIGUNGU === 'undefined' || !sidoFullName) return;
      var region = null;
      for (var i = 0; i < REGIONS.length; i++) {
        var full = (typeof SIDO_FULL !== 'undefined' && SIDO_FULL[REGIONS[i].name]) || REGIONS[i].name;
        if (full === sidoFullName) { region = REGIONS[i]; break; }
      }
      if (!region) return;
      var names = [];
      var seen = {};
      Object.keys(SIGUNGU).forEach(function (code) {
        if (code.slice(0, 2) !== region.cd) return;
        var nm = SIGUNGU[code];
        if (seen[nm]) return; seen[nm] = 1;
        names.push(nm);
      });
      names.sort(function (a, b) { return a.localeCompare(b, 'ko'); });
      names.forEach(function (nm) {
        var o = d.createElement('option');
        o.value = nm; o.textContent = nm;
        elSigungu.appendChild(o);
      });
    }

    function setStatus(msg, busy) {
      if (!elStatus) return;
      elStatus.textContent = msg || '';
      show(elStatus, !!msg);
      if (busy) elStatus.setAttribute('aria-busy', 'true');
      else elStatus.removeAttribute('aria-busy');
    }

    function run(pushHistory) {
      var mySeq = ++seq;
      if (ctrl && ctrl.abort) { try { ctrl.abort(); } catch (e) {} }
      ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;

      if (hist && hist.replaceState) {
        var qsPart = stateToSearch(state);
        try { hist.replaceState(null, '', qsPart || (loc.pathname || 'hospital.html')); } catch (e) {}
      }

      if (elList) elList.textContent = '';
      if (elPager) show(elPager, false);
      if (elCount) elCount.textContent = '검색 중…';
      setStatus('요양병원 정보를 불러오는 중입니다…', true);

      var url = buildListUrl(state);
      var opt = ctrl ? { signal: ctrl.signal } : {};
      fetchImpl(url, opt).then(function (r) {
        if (!r.ok) {
          var err = new Error('http');
          err.status = r.status;
          throw err;
        }
        return r.json();
      }).then(function (data) {
        if (mySeq !== seq) return; // 더 최신 요청이 있으면 이 응답은 버린다
        var items = (data && Array.isArray(data.items)) ? data.items : [];
        var total = (data && typeof data.total === 'number') ? data.total : items.length;
        var size = (data && typeof data.size === 'number') ? data.size : PAGE_SIZE;
        var page = (data && typeof data.page === 'number') ? data.page : state.page;
        state.page = page;
        lastWasLastPage = page * size >= total;

        if (elList) renderList(elList, items, stateToSearch(state));
        if (elCount) elCount.textContent = '검색 결과 ' + total.toLocaleString() + '곳';
        if (items.length === 0) {
          setStatus('조건에 맞는 요양병원이 없습니다. 검색어나 지역을 바꿔 보세요.', false);
        } else {
          setStatus('', false);
        }
        if (elPager) {
          var multi = total > size;
          show(elPager, multi);
          if (elPageInfo) elPageInfo.textContent = pageText(page, size, total);
          if (elPrev) elPrev.disabled = page <= 1;
          if (elNext) elNext.disabled = lastWasLastPage;
        }
      }).catch(function (e) {
        if (e && e.name === 'AbortError') return;
        if (mySeq !== seq) return;
        if (elCount) elCount.textContent = '검색 결과';
        setStatus(userErrorMessage(e && e.status), false);
        if (elList) elList.textContent = '';
        if (elPager) show(elPager, false);
      });
    }
  }

  /* ---------------- 상세 컨트롤러 ---------------- */

  function initDetail(root, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var loc = deps.location || (typeof location !== 'undefined' ? location : { search: '' });

    var elPrep = root.querySelector('[data-h="prep"]');
    var elBody = root.querySelector('[data-h="body"]');
    var elStatus = root.querySelector('[data-h="status"]');

    var params = new URLSearchParams(loc.search || '');
    var id = params.get('id') || '';
    var backSearch = '';
    var rawFrom = params.get('from');
    if (rawFrom) {
      // from 은 우리가 만든 검색 쿼리스트링만 허용 (q/sido/sigungu/page)
      var fp = new URLSearchParams(rawFrom);
      var clean = new URLSearchParams();
      ['q', 'sido', 'sigungu', 'page'].forEach(function (k) {
        var v = fp.get(k);
        if (v != null && v !== '') clean.set(k, v);
      });
      var cs = clean.toString();
      if (cs) backSearch = '?' + cs;
    }

    function setStatus(msg, busy) {
      if (!elStatus) return;
      elStatus.textContent = msg || '';
      show(elStatus, !!msg);
      if (busy) elStatus.setAttribute('aria-busy', 'true');
      else elStatus.removeAttribute('aria-busy');
    }

    return checkHospitalFlag(fetchImpl).then(function (on) {
      if (!on) {
        show(elPrep, true);
        show(elBody, false);
        setStatus('', false);
        return;
      }
      show(elPrep, false);
      show(elBody, true);

      if (!id) {
        renderNotFound();
        return;
      }
      setStatus('요양병원 정보를 불러오는 중입니다…', true);
      return fetchImpl(buildDetailUrl(id)).then(function (r) {
        if (!r.ok) { var err = new Error('http'); err.status = r.status; throw err; }
        return r.json();
      }).then(function (data) {
        setStatus('', false);
        if (!data || !data.facility) { renderNotFound(); return; }
        renderDetail(elBody, data, { backSearch: backSearch });
        if (typeof document !== 'undefined' && data.facility && data.facility.name) {
          document.title = String(data.facility.name) + ' | 120 라이프홈즈';
        }
        if (deps.onReady) deps.onReady();
      }).catch(function (e) {
        if (e && (e.status === 404 || e.status === 400)) { renderNotFound(); return; }
        setStatus(userErrorMessage(e && e.status), false);
        if (deps.onReady) deps.onReady();
      });
    });

    function renderNotFound() {
      if (!elBody) return;
      elBody.textContent = '';
      var box = el('div', { className: 'h-empty', children: [
        el('h1', { text: '요양병원을 찾을 수 없습니다' }),
        el('p', { text: '주소가 잘못되었거나 아직 공개되지 않은 기관입니다.' }),
        el('a', { className: 'h-back', text: '← 요양병원 검색으로', attrs: { href: 'hospital.html' + backSearch } })
      ] });
      elBody.appendChild(box);
    }
  }

  /* ---------------- 공통 ---------------- */

  function show(elm, on) {
    if (!elm) return;
    if (on) elm.removeAttribute('hidden');
    else elm.setAttribute('hidden', 'hidden');
  }

  var HospitalUI = {
    // 순수
    hasValue: hasValue,
    fmtDate: fmtDate,
    safeExternalUrl: safeExternalUrl,
    buildListUrl: buildListUrl,
    buildDetailUrl: buildDetailUrl,
    stateToSearch: stateToSearch,
    userErrorMessage: userErrorMessage,
    pageText: pageText,
    gradeLabel: gradeLabel,
    // DOM
    facilityCard: facilityCard,
    renderList: renderList,
    renderDetail: renderDetail,
    // flag / 컨트롤러
    checkHospitalFlag: checkHospitalFlag,
    initSearch: initSearch,
    initDetail: initDetail,
    PAGE_SIZE: PAGE_SIZE
  };

  global.HospitalUI = HospitalUI;
  if (typeof module !== 'undefined' && module.exports) module.exports = HospitalUI;

  // 브라우저 자동 실행
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', function () {
      var s = document.getElementById('hospital-search');
      var dt = document.getElementById('hospital-detail');
      if (s) initSearch(s, {});
      else if (dt) initDetail(dt, {});
    });
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
