/**
 * 화면·메뉴·RESP 등록 UI. 왼쪽은 체크 행 일괄 처리, 오른쪽은 선택 항목의 연결 구성이다.
 * 편집을 확정한 뒤 요청을 만들고 응답의 최신 버전을 다음 저장에 사용한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Column, DataGrid, GridHandle, GridRow } from './DataGrid';
import { actions, labels, Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
export type RegisterKind = 'screens' | 'menus' | 'responsibilities';
const titles = { screens: '화면', menus: '메뉴', responsibilities: 'RESP' };
const time = (v: any) => (v ? new Date(v).toLocaleString('ko-KR') : '');
const blankFlags = () => Object.fromEntries(actions.map((a) => [a, false]));
// map은 각 동작을 [이름, 값] 쌍으로 바꾸고 fromEntries는 그 쌍들을 객체로 만든다.
// 결과는 { RESET: false, QUERY: false, ... }이며 신규 화면의 버튼 초기값이다.
const wrap = (r: any): GridRow => ({ ...r, _key: String(r.id), _checked: false });
function errorMessage(error: unknown) {
  const details = error instanceof ApiError ? error.rowErrors : [];
  return [
    (error as Error).message,
    ...details.map((e) => `${e.rowNumber}행 ${e.code || ''}: ${e.message}`),
  ].join('\n');
}
type Props = {
  kind: RegisterKind;
  screen: Screen;
  notify: Notify;
  onState: (s: ViewState) => void;
  onSaved: () => Promise<void>;
};
export const RegistrationScreen = forwardRef<ScreenHandle, Props>(function RegistrationScreen(
  { kind, screen, notify, onState, onSaved },
  ref,
) {
  // useState는 [현재 값, 값을 바꾸는 함수]를 반환한다. setRows를 호출하면 화면에 반영된다.
  // <GridRow[]>는 행 배열 타입이다. rowRef는 같은 데이터를 즉시 읽기 위해 별도로 보관한다.
  const [rows, setRows] = useState<GridRow[]>([]),
    rowRef = useRef<GridRow[]>([]);
  const [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(''),
    [parent, setParent] = useState<any>(null),
    [links, setLinks] = useState<GridRow[]>([]),
    linkRef = useRef<GridRow[]>([]);
  const [menus, setMenus] = useState<GridRow[]>([]),
    [screens, setScreens] = useState<GridRow[]>([]);
  const [mCode, setMCode] = useState(''),
    [mName, setMName] = useState(''),
    [sCode, setSCode] = useState(''),
    [sName, setSName] = useState('');
  const [mFilter, setMFilter] = useState(['', '']),
    [sFilter, setSFilter] = useState(['', '']);
  const [linkActive, setLinkActive] = useState(''),
    [chosenMenu, setChosenMenu] = useState<any>(null);
  const [split, setSplit] = useState(kind === 'menus' ? 36 : 46);
  const leftGrid = useRef<GridHandle>(null),
    rightGrid = useRef<GridHandle>(null),
    epoch = useRef(0);
  const rightParent = useRef<any>(parent);
  rightParent.current = parent;
  const prefix = 'registration/' + kind,
    headers = { 'X-Menu-ID': screen.menu_id };
  const dirty = rows.some((r) => r._checked) || links.some((r) => r._checked);
  // some은 조건을 만족하는 행이 하나라도 있으면 true다. 여기서는 체크 상태를 변경 표시로 사용한다.
  // useEffect는 렌더 후 실행되며, 배열의 값이 바뀌면 부모에게 현재 변경·처리 상태를 알린다.
  useEffect(() => onState({ dirty, busy }), [dirty, busy, onState]);
  // ref를 즉시 갱신해 재렌더 전에 저장해도 마지막 셀 편집 결과를 읽을 수 있게 한다.
  function updateRows(r: GridRow[]) {
    rowRef.current = r;
    setRows(r);
  }
  function updateLinks(r: GridRow[]) {
    linkRef.current = r;
    setLinks(r);
  }
  // 요청 세대를 증가시켜 이전 상세 조회의 늦은 응답을 무효화한다.
  function clearRight() {
    epoch.current++;
    setParent(null);
    rightParent.current = null;
    updateLinks([]);
    setMenus([]);
    setScreens([]);
    setChosenMenu(null);
    setLinkActive('');
    setMCode('');
    setMName('');
    setSCode('');
    setSName('');
    setMFilter(['', '']);
    setSFilter(['', '']);
  }
  function reset() {
    // ?.는 그리드가 연결되어 있을 때만 호출한다. 입력 중인 셀을 확정한 뒤 목록을 비운다.
    leftGrid.current?.stop();
    updateRows([]);
    setCode('');
    setName('');
    setSelected('');
    clearRight();
  }
  async function query() {
    leftGrid.current?.stop();
    setBusy(true);
    clearRight();
    setSelected('');
    try {
      // URLSearchParams는 공백·한글 등이 포함된 조회 조건을 URL에 맞게 인코딩한다.
      const r = await api(prefix + '?' + new URLSearchParams({ code, name }), { headers });
      updateRows(r.items.map(wrap));
      notify('조회했습니다.', 'success');
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  // 변경 성공 후 조회 조건을 유지해 모든 행을 교체한다. 미저장 행은 의도적으로 폐기한다.
  async function reloadSaved(id?: string) {
    clearRight();
    setSelected('');
    updateRows([]);
    try {
      const d = await api(prefix + '?' + new URLSearchParams({ code, name }), { headers });
      const fresh = d.items.map(wrap);
      updateRows(fresh);
      const row = fresh.find((r: GridRow) => r.id === id);
      if (row) await pick(row);
    } catch (e) {
      notify(
        '변경은 완료됐지만 재조회하지 못했습니다. 조회 버튼으로 확인해주세요. ' + errorMessage(e),
        'error',
      );
    }
  }
  // 응답 시점에도 요청 세대가 같을 때만 상세를 바꾼다. 신규 행은 DB 상세가 없다.
  async function pick(row: GridRow) {
    setSelected(row._key);
    if (kind === 'screens') return;
    clearRight();
    if (!row.id) return;
    const ticket = epoch.current;
    try {
      const d = await api(prefix + '/' + row.id + (kind === 'menus' ? '/layout' : '/link'), {
        headers,
      });
      if (ticket !== epoch.current) return;
      setParent(d.parent);
      setMenus(d.menus.map(wrap));
      if (kind === 'menus') {
        setScreens(d.screens.map(wrap));
        updateLinks(
          d.rows.map((r: any) => ({ ...r, _key: r.kind + ':' + r.target_id, _checked: false })),
        );
      } else if (d.parent.root_menu_id)
        setChosenMenu(d.menus.find((m: any) => m.id === d.parent.root_menu_id) || null);
    } catch (e) {
      if (ticket === epoch.current) notify(errorMessage(e), 'error');
    }
  }
  function addRow() {
    leftGrid.current?.stop();
    updateRows([
      ...rowRef.current,
      {
        _key: crypto.randomUUID(),
        _checked: true,
        code: '',
        name: '',
        ...(kind === 'screens' ? { component_key: '', buttons: blankFlags() } : {}),
        ...(kind === 'responsibilities' ? { authority_type: 'CUSTOMER', level: 100 } : {}),
      },
    ]);
  }
  function dropNew() {
    leftGrid.current?.stop();
    const removing = rowRef.current.filter((r) => !r.id && r._checked);
    updateRows(rowRef.current.filter((r) => r.id || !r._checked));
    if (removing.some((r) => r._key === selected)) {
      setSelected('');
      clearRight();
    }
  }
  // 편집을 확정한 뒤 체크 행을 전송한다. clientKey로 응답·오류를 원래 UI 행과 연결한다.
  async function batch(remove = false) {
    leftGrid.current?.stop();
    const chosen = rowRef.current.filter((r) => r._checked);
    if (!chosen.length) {
      notify('첫 열에서 처리할 행을 체크해주세요.');
      return false;
    }
    if (!window.confirm(chosen.length + '개 행을 ' + (remove ? '삭제' : '저장') + '할까요?'))
      return false;
    setBusy(true);
    const payload = chosen.map((r) => ({
      clientKey: r._key,
      rowNumber: rowRef.current.indexOf(r) + 1,
      ...(r.id ? { id: r.id, version: r.version } : {}),
      ...(!remove
        ? {
            code: r.code,
            name: r.name,
            ...(kind === 'screens' ? { component_key: r.component_key, buttons: r.buttons } : {}),
            ...(kind === 'responsibilities'
              ? { authority_type: r.authority_type, level: Number(r.level) }
              : {}),
          }
        : {}),
    }));
    try {
      const result = await api(prefix + (remove ? '/delete' : '/save'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ rows: payload }),
      });
      const keepId = remove
        ? rightParent.current?.id
        : result.items.find((r: any) => r.clientKey === selected)?.id ||
          rightParent.current?.id ||
          result.items[0]?.id;
      await reloadSaved(keepId);
      notify((remove ? '삭제' : '저장') + '했습니다.', 'success');
      await onSaved();
      return true;
    } catch (e) {
      const detail = e instanceof ApiError ? e.rowErrors : [];
      updateRows(
        rowRef.current.map((r) => ({
          ...r,
          _error: detail.find((d) => d.clientKey === r._key)?.message,
        })),
      );
      notify(errorMessage(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    query,
    reset,
    save: () => batch(),
    remove: async () => {
      await batch(true);
    },
  }));
  const meta: Column[] = [
    { field: 'created_by', header: '등록자', width: 110 },
    { field: 'created_at', header: '등록일시', width: 165, format: time },
  ];
  const columns: Column[] = [
    { field: 'code', header: titles[kind] + '코드', width: 150, editable: (r) => !r.id },
    { field: 'name', header: titles[kind] + '명', width: 155, editable: true },
    ...(kind === 'screens'
      ? [
          { field: 'component_key', header: '화면 소스코드 명칭', width: 190, editable: true },
          ...actions.map((a, i) => ({
            field: 'buttons.' + a,
            header: labels[i],
            width: 80,
            boolean: true,
          })),
        ]
      : []),
    ...(kind === 'responsibilities'
      ? [
          {
            field: 'authority_type',
            header: '접근 구분',
            width: 140,
            editable: true,
            choices: ['SYSTEM', 'CUSTOMER'],
          },
          { field: 'level', header: '레벨 (0 최상위)', width: 155, editable: true },
          { field: 'menu_code', header: '메뉴코드', width: 140 },
          { field: 'menu_name', header: '메뉴명', width: 130 },
        ]
      : []),
    ...meta,
  ];
  // 이미 연결한 대상은 후보에서 제외하고 코드·명칭 조회 조건을 적용한다.
  function candidates(source: GridRow[], filter: string[], k: string) {
    return source.filter(
      (r) =>
        !links.some((l) => l.kind === k && l.target_id === r.id) &&
        r.code.toLowerCase().includes(filter[0].toLowerCase()) &&
        r.name.toLowerCase().includes(filter[1].toLowerCase()),
    );
  }
  // 편집 중인 연결은 보존하고 후보만 다시 읽는다. 선택이 바뀌면 늦은 응답을 무시한다.
  async function reloadCandidates() {
    if (!parent) return;
    const ticket = epoch.current;
    const d = await api(prefix + '/' + parent.id + (kind === 'menus' ? '/layout' : '/link'), {
      headers,
    });
    if (ticket !== epoch.current) return;
    setMenus(d.menus.map(wrap));
    if (kind === 'menus') setScreens(d.screens.map(wrap));
  }
  async function candidateQuery(type: 'M' | 'F') {
    if (!parent) return;
    setBusy(true);
    try {
      await reloadCandidates();
      if (type === 'M') setMFilter([mCode, mName]);
      else setSFilter([sCode, sName]);
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  // 후보를 로컬 구성에 추가한다. 실제 DB 변경은 적용 버튼을 누를 때 수행한다.
  function addLinks(type: 'M' | 'F') {
    const from =
        type === 'M' ? candidates(menus, mFilter, type) : candidates(screens, sFilter, type),
      picked = from.filter((r) => r._checked);
    updateLinks([
      ...links,
      ...picked.map((r) => ({
        kind: type,
        target_id: r.id,
        code: r.code,
        name: r.name,
        hidden: false,
        buttons: type === 'F' ? { ...r.buttons } : blankFlags(),
        usage: type === 'F' ? { ...r.buttons } : blankFlags(),
        _key: type + ':' + r.id,
        _checked: false,
      })),
    ]);
    if (type === 'M') setMenus((m) => m.map((r) => ({ ...r, _checked: false })));
    else setScreens((m) => m.map((r) => ({ ...r, _checked: false })));
  }
  async function dropLinks() {
    updateLinks(links.filter((r) => !r._checked));
    setLinkActive('');
    setBusy(true);
    try {
      await reloadCandidates();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  // 선택한 연결과 이웃 행을 교환한다. 서버가 배열 순서를 sort_order로 저장한다.
  function move(direction: number) {
    const i = links.findIndex((r) => r._key === linkActive),
      j = i + direction;
    if (i < 0 || j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    updateLinks(next);
  }
  // 전체 구성 또는 RESP 시작 메뉴를 부모 버전과 함께 전송하고 새 버전을 왼쪽 목록에도 반영한다.
  async function apply() {
    rightGrid.current?.stop();
    if (!parent || kind === 'screens') return;
    if (kind === 'responsibilities' && !chosenMenu) {
      notify('연결할 메뉴를 선택해주세요.');
      return;
    }
    if (
      !window.confirm(
        kind === 'menus'
          ? '현재 하위 메뉴·화면 구성을 적용할까요?'
          : '선택한 메뉴를 RESP에 적용할까요?',
      )
    )
      return;
    setBusy(true);
    try {
      const body =
        kind === 'menus'
          ? {
              version: parent.version,
              rows: linkRef.current.map((r) => ({
                kind: r.kind,
                target_id: r.target_id,
                hidden: r.hidden,
                ...(r.kind === 'F' ? { buttons: r.buttons } : {}),
              })),
            }
          : { version: parent.version, menuId: chosenMenu.id };
      const d = await api(prefix + '/' + parent.id + '/apply', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      await reloadSaved(d.parent.id);
      notify('적용했습니다.', 'success');
      await onSaved();
    } catch (e) {
      notify(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  // 좌우 비율을 25~65%로 제한하며 종료·취소 시 임시 포인터 리스너를 제거한다.
  function resize(e: React.PointerEvent<HTMLDivElement>) {
    const el = e.currentTarget,
      container = el.parentElement!;
    el.setPointerCapture(e.pointerId);
    const move = (p: PointerEvent) => {
      const box = container.getBoundingClientRect();
      setSplit(Math.max(25, Math.min(65, ((p.clientX - box.left) / box.width) * 100)));
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }
  const layoutColumns: Column[] = [
    { field: 'code', header: '코드', width: 140 },
    { field: 'name', header: '명칭', width: 135 },
    { field: 'kind', header: '종류', width: 65, format: (v) => (v === 'M' ? '메뉴' : '화면') },
    { field: 'hidden', header: '숨김', width: 65, boolean: true },
    ...actions.map((a, i) => ({
      field: 'buttons.' + a,
      header: labels[i],
      width: 65,
      boolean: true,
      disabled: (r: GridRow) => r.kind !== 'F' || !r.usage?.[a],
    })),
    ...meta,
  ];
  const candidateColumns: Column[] = [
    { field: 'code', header: '코드', width: 145 },
    { field: 'name', header: '명칭', width: 145 },
    ...meta,
  ];
  const mergeCandidates = (old: GridRow[], next: GridRow[]) =>
    old.map((r) => next.find((n) => n._key === r._key) || r);
  return (
    <div
      className={'register-screen ' + (kind === 'screens' ? 'single-register' : '')}
      data-register={kind}
    >
      <div
        className="registration-split"
        style={
          kind === 'screens' ? undefined : { gridTemplateColumns: split + '% 7px minmax(0,1fr)' }
        }
      >
        <section className="register-left">
          <div className="query-bar">
            <label>
              {titles[kind]}코드
              <input value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <label>
              {titles[kind]}명<input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="grid-tools">
            <button disabled={busy} onClick={addRow}>
              행추가
            </button>
            <button disabled={busy} onClick={dropNew}>
              행삭제
            </button>
          </div>
          <DataGrid
            ref={leftGrid}
            label={titles[kind] + ' 등록'}
            rows={rows}
            columns={columns}
            onChange={updateRows}
            onPick={pick}
            active={selected}
            busy={busy}
          />
        </section>
        {kind !== 'screens' && (
          <>
            <div
              className="splitter"
              role="separator"
              aria-label="좌우 영역 크기"
              onPointerDown={resize}
            />
            <section className="register-right">
              <div className="fixed-bar">
                <label>
                  {titles[kind]}코드
                  <input readOnly value={parent?.code || ''} />
                </label>
                <label>
                  {titles[kind]}명<input readOnly value={parent?.name || ''} />
                </label>
                {kind === 'responsibilities' && (
                  <>
                    <label>
                      메뉴코드
                      <input readOnly value={chosenMenu?.code || ''} />
                    </label>
                    <label>
                      메뉴명
                      <input readOnly value={chosenMenu?.name || ''} />
                    </label>
                  </>
                )}
                {screen.buttons.SAVE?.allowed && (
                  <button disabled={!parent || busy} onClick={apply}>
                    {kind === 'menus' ? '메뉴적용' : '적용'}
                  </button>
                )}
              </div>
              {kind === 'menus' && (
                <>
                  <div className="grid-tools">
                    <button disabled={!parent || busy} onClick={() => move(-1)}>
                      위
                    </button>
                    <button disabled={!parent || busy} onClick={() => move(1)}>
                      아래
                    </button>
                    <button disabled={!parent || busy} onClick={dropLinks}>
                      행삭제
                    </button>
                  </div>
                  <div className="layout-grid">
                    <DataGrid
                      ref={rightGrid}
                      label="하위 구성"
                      rows={links}
                      columns={layoutColumns}
                      onChange={updateLinks}
                      onPick={(r) => setLinkActive(r._key)}
                      active={linkActive}
                      busy={busy}
                    />
                  </div>
                </>
              )}
              <div
                className={
                  'candidate-panels ' + (kind === 'responsibilities' ? 'resp-candidates' : '')
                }
              >
                <section>
                  <div className="query-bar">
                    <label>
                      메뉴코드
                      <input value={mCode} onChange={(e) => setMCode(e.target.value)} />
                    </label>
                    <label>
                      메뉴명
                      <input value={mName} onChange={(e) => setMName(e.target.value)} />
                    </label>
                    <button disabled={!parent || busy} onClick={() => candidateQuery('M')}>
                      조회
                    </button>
                    {kind === 'menus' && (
                      <button disabled={!parent || busy} onClick={() => addLinks('M')}>
                        추가
                      </button>
                    )}
                  </div>
                  <DataGrid
                    label="메뉴 후보"
                    rows={
                      kind === 'menus'
                        ? candidates(menus, mFilter, 'M')
                        : menus.filter(
                            (r) =>
                              r.code.toLowerCase().includes(mFilter[0].toLowerCase()) &&
                              r.name.toLowerCase().includes(mFilter[1].toLowerCase()),
                          )
                    }
                    columns={candidateColumns}
                    checks={kind === 'menus'}
                    onChange={(next) => setMenus((old) => mergeCandidates(old, next))}
                    onPick={kind === 'responsibilities' ? (r) => setChosenMenu(r) : undefined}
                    active={chosenMenu?._key}
                    busy={busy}
                  />
                </section>
                {kind === 'menus' && (
                  <section>
                    <div className="query-bar">
                      <label>
                        화면코드
                        <input value={sCode} onChange={(e) => setSCode(e.target.value)} />
                      </label>
                      <label>
                        화면명
                        <input value={sName} onChange={(e) => setSName(e.target.value)} />
                      </label>
                      <button disabled={!parent || busy} onClick={() => candidateQuery('F')}>
                        조회
                      </button>
                      <button disabled={!parent || busy} onClick={() => addLinks('F')}>
                        추가
                      </button>
                    </div>
                    <DataGrid
                      label="화면 후보"
                      rows={candidates(screens, sFilter, 'F')}
                      columns={candidateColumns}
                      onChange={(next) => setScreens((old) => mergeCandidates(old, next))}
                      busy={busy}
                    />
                  </section>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
});
