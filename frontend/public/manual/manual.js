/**
 * 사용 설명서 보조 기능(QA DL-020). 화면 보안 정책상 인라인 스크립트는 쓸 수 없어 별도 파일로 둔다.
 * 1) 그림 크게 보기: 그림을 누르면 새 탭 대신 이 페이지 위에 크게 띄운다. 바깥·닫기·Esc로 닫는다.
 * 2) 목차 찾기: 입력한 낱말이 들어 있는 장만 목차에 남긴다(본문 글자 기준).
 * 스크립트가 꺼져 있어도 그림 링크는 원래대로 새 탭에서 열린다.
 */
(function () {
  // 1) 그림 크게 보기
  const viewer = document.createElement('div');
  viewer.className = 'lightbox';
  viewer.setAttribute('role', 'dialog');
  viewer.setAttribute('aria-modal', 'true');
  viewer.hidden = true;
  viewer.innerHTML =
    '<button type="button" class="lightbox-close" aria-label="닫기">×</button><img alt="" />';
  document.body.appendChild(viewer);
  const img = viewer.querySelector('img');
  let back = null;
  const close = () => {
    viewer.hidden = true;
    img.removeAttribute('src');
    if (back) back.focus();
  };
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="media/"]');
    if (!link || !link.querySelector('img') || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    back = link;
    img.src = link.getAttribute('href');
    img.alt = link.querySelector('img').alt || '';
    viewer.hidden = false;
    viewer.querySelector('.lightbox-close').focus();
  });
  viewer.addEventListener('click', (e) => {
    if (e.target !== img) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !viewer.hidden) close();
  });

  // 2) 목차 찾기
  const toc = document.querySelector('nav.toc');
  if (!toc) return;
  const box = document.createElement('input');
  box.type = 'search';
  box.className = 'toc-search';
  box.placeholder = '설명서에서 찾기 (예: 승인)';
  box.setAttribute('aria-label', '설명서에서 찾기');
  const count = document.createElement('small');
  count.className = 'toc-count';
  toc.insertBefore(count, toc.firstChild);
  toc.insertBefore(box, toc.firstChild);
  const links = Array.from(toc.querySelectorAll('a[href^="#"]'));
  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    let shown = 0;
    for (const a of links) {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      const text = ((target && target.textContent) || a.textContent).toLowerCase();
      const hit = !q || text.includes(q);
      a.hidden = !hit;
      if (hit) shown++;
    }
    count.textContent = q ? (shown ? shown + '개 장에 있습니다' : '찾는 낱말이 없습니다') : '';
  });
})();
