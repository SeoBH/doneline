/** 고객사/법인/부서등록의 공통 그리드. 화면별 부모 선택 깊이만 다르며 체크 행만 저장한다. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from './api';
import { DataGrid, GridHandle, GridRow } from './DataGrid';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { confirmAction } from './ConfirmDialog';
const wrap = (r: any): GridRow => ({ ...r, _key: r.id, _checked: false });
/**
 * 고객사·법인·부서를 저장·삭제했음을 같은 브라우저 창의 다른 화면(탭)에 알리는 이벤트 이름.
 * 화면들은 처음 열 때만 목록을 읽으므로, 이 신호를 받으면 편집 중이 아닐 때 목록을 다시 읽는다(QA DLV2-002).
 * CustomEvent: 브라우저가 제공하는 '내가 이름 붙인 이벤트'. detail에 바뀐 종류(customers 등)를 담는다.
 */
export const CATALOG_CHANGED = 'doneline:catalog-changed';
export const CustomersScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function CustomersScreen({ screen, notify, onState }, ref) {
  const kind =
    screen.component_key === 'department-register'
      ? 'departments'
      : screen.component_key === 'corporation-register'
        ? 'corporations'
        : 'customers';
  const title = { customers: '고객사', corporations: '법인', departments: '부서' }[kind];
  const [data, setData] = useState<any>({ customers: [], corporations: [], departments: [] });
  const [customerId, setCustomerId] = useState(''),
    [corporationId, setCorporationId] = useState('');
  const [rows, setRows] = useState<GridRow[]>([]),
    latest = useRef<GridRow[]>([]),
    grid = useRef<GridHandle>(null);
  const [busy, setBusy] = useState(false),
    [active, setActive] = useState(''),
    [code, setCode] = useState(''),
    [name, setName] = useState('');
  const epoch = useRef(0),
    headers = { 'X-Menu-ID': screen.menu_id };
  const dirty = rows.some((r) => r._checked);
  useEffect(() => onState({ busy, dirty }), [busy, dirty, onState]);
  function update(r: GridRow[]) {
    latest.current = r;
    setRows(r);
  }
  function filtered(source: any[], customer = customerId, corporation = corporationId) {
    return source
      .filter(
        (r) =>
          (kind === 'customers' || r.customer_id === customer) &&
          (kind !== 'departments' || r.corporation_id === corporation) &&
          r.code.toLowerCase().includes(code.toLowerCase()) &&
          r.name.toLowerCase().includes(name.toLowerCase()),
      )
      .map(wrap);
  }
  async function query() {
    await grid.current?.stop();
    const ticket = ++epoch.current;
    setBusy(true);
    try {
      const d = await api('catalogs/' + kind, { headers });
      if (ticket !== epoch.current) return;
      setData(d);
      // 상위 고객사는 사용자가 직접 고른 것만 유지한다. 예전에는 첫 고객사를 자동으로 골라
      // 고객사를 누르지 않고 저장한 법인이 첫 고객사에 들어갔다(QA DLV2-003). 고객사가 1곳뿐이면 그곳을 고른다.
      const customer = d.customers.some((r: any) => r.id === customerId)
        ? customerId
        : d.customers.length === 1
          ? d.customers[0].id
          : '';
      const corporation = d.corporations.some(
        (r: any) => r.id === corporationId && r.customer_id === customer,
      )
        ? corporationId
        : '';
      setCustomerId(customer);
      setCorporationId(corporation);
      update(filtered(d[kind], customer, corporation));
      setActive('');
    } catch (e) {
      if (ticket === epoch.current) notify((e as Error).message, 'error');
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    void query();
    return () => {
      epoch.current++;
    };
  }, []);
  // 다른 화면에서 고객사·법인·부서가 바뀌면 다시 읽는다. 편집 중(체크한 행이 있음)이면 입력을 지키려고 건너뛴다.
  // queryRef: 이벤트 함수는 처음 만든 것이 계속 쓰이므로 최신 query 함수를 ref로 읽는다.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onChanged = (e: Event) => {
      const changed = (e as CustomEvent).detail;
      if (changed === kind || latest.current.some((r) => r._checked)) return;
      void queryRef.current();
    };
    window.addEventListener(CATALOG_CHANGED, onChanged);
    return () => window.removeEventListener(CATALOG_CHANGED, onChanged);
  }, [kind]);
  async function reset() {
    epoch.current++;
    await grid.current?.stop();
    update([]);
    setCode('');
    setName('');
    setActive('');
    setBusy(false);
  }
  async function pickCustomer(r: GridRow) {
    await grid.current?.stop();
    if (
      latest.current.some((r) => r._checked) &&
      !(await confirmAction('편집 중인 행을 버리고 고객사를 변경할까요?'))
    )
      return;
    setCustomerId(r.id);
    setCorporationId('');
    setActive('');
    update(filtered(data[kind], r.id, ''));
  }
  async function pickCorporation(r: GridRow) {
    await grid.current?.stop();
    if (
      latest.current.some((r) => r._checked) &&
      !(await confirmAction('편집 중인 행을 버리고 법인을 변경할까요?'))
    )
      return;
    setCorporationId(r.id);
    setActive('');
    update(filtered(data[kind], customerId, r.id));
  }
  async function add() {
    await grid.current?.stop();
    update([...latest.current, { _key: crypto.randomUUID(), _checked: true, code: '', name: '' }]);
  }
  async function drop() {
    await grid.current?.stop();
    update(latest.current.filter((r) => r.id || !r._checked));
  }
  async function batch(remove = false) {
    await grid.current?.stop();
    let selected = latest.current.filter((r) => r._checked);
    if (!remove) {
      // 행추가만 하고 아무것도 적지 않은 새 행은 실수로 생긴 것으로 보고 저장 대상에서 조용히 뺀다.
      const blank = selected.filter((r) => !r.id && !r.code?.trim() && !r.name?.trim());
      if (blank.length) {
        update(latest.current.filter((r) => !blank.includes(r)));
        selected = selected.filter((r) => !blank.includes(r));
      }
      // 코드나 이름이 빠진 행은 서버에 보내기 전에 표시하고 몇 번째 행인지 알려 준다(QA DL-003·서버의 모호한 오류 대신).
      const missing = selected.filter((r) => !r.code?.trim() || !r.name?.trim());
      if (missing.length) {
        const marked = latest.current.map((r) =>
          missing.includes(r) ? { ...r, _error: '코드와 이름을 입력해 주세요.' } : r,
        );
        update(marked);
        const nth = marked.findIndex((r) => r._error) + 1;
        notify(`${nth}번째 행의 코드와 이름을 모두 입력해 주세요.`, 'error');
        return false;
      }
    }
    if (!selected.length) {
      notify('처리할 행을 체크해 주세요.');
      return false;
    }
    // 확인 창에 어느 고객사(·법인)에 저장하는지 함께 보여 준다(QA DLV2-003).
    const parentName = [
      kind !== 'customers' && data.customers.find((r: any) => r.id === customerId)?.name,
      kind === 'departments' && data.corporations.find((r: any) => r.id === corporationId)?.name,
    ]
      .filter(Boolean)
      .join(' · ');
    const target = parentName ? `${parentName}에 ${title} ` : `${title} `;
    if (
      !(await confirmAction(`${target}${selected.length}개를 ${remove ? '삭제' : '저장'}할까요?`))
    )
      return false;
    let committed = false;
    setBusy(true);
    try {
      await api('catalogs/' + kind + (remove ? '/delete' : '/save'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customerId,
          corporationId,
          rows: selected.map((r) => ({
            clientKey: r._key,
            ...(r.id ? { id: r.id, version: r.version } : {}),
            ...(!remove ? { code: r.code, name: r.name } : {}),
          })),
        }),
      });
      committed = true;
      // 저장 뒤에도 보던 고객사의 가입 링크가 계속 보이도록, 선택했던(또는 방금 저장한 1건의) 코드를 기억해 다시 고른다(QA DL-028).
      const keepCode = remove
        ? ''
        : latest.current.find((r) => r._key === active)?.code ||
          (selected.length === 1 ? selected[0].code : '');
      // 성공 후 전체를 다시 읽는다. 체크하지 않은 신규/수정 행도 DB 상태로 교체한다.
      // 다시 읽는 동안 표를 비우지 않는다(비우면 '데이터 없음'이 잠깐 보여 저장이 날아간 것처럼 보임, QA R1).
      setActive('');
      const d = await api('catalogs/' + kind, { headers });
      setData(d);
      const fresh = filtered(d[kind]);
      update(fresh);
      const again = keepCode && fresh.find((r) => r.code === keepCode);
      if (again) setActive(again._key);
      // 다른 탭에 열려 있는 고객사·법인·부서·사용자 화면도 새 목록을 읽게 알린다(QA DLV2-002).
      window.dispatchEvent(new CustomEvent(CATALOG_CHANGED, { detail: kind }));
      notify((remove ? '삭제' : '저장') + '했습니다.', 'success');
      return true;
    } catch (e) {
      notify(
        (committed
          ? '변경은 완료됐지만 재조회하지 못했습니다. 조회 버튼으로 확인해 주세요. '
          : '') + (e as Error).message,
        'error',
      );
      return committed;
    } finally {
      setBusy(false);
    }
  }
  /**
   * 가입 링크 교체. 링크가 엉뚱한 곳에 전달됐을 때 새 링크를 만들어 예전 링크로는 가입하지 못하게 한다.
   * 성공하면 목록을 다시 읽어 새 링크를 보여 준다. 이미 가입한 사용자에게는 영향이 없다.
   */
  async function rotateLink(customer: any) {
    if (
      !(await confirmAction({
        title: '가입 링크를 새로 만들까요?',
        message: `${customer.name}에 보낸 예전 가입 링크는 더 이상 쓸 수 없습니다. 이미 가입한 사용자는 그대로 로그인할 수 있습니다.`,
        confirmLabel: '새 링크 만들기',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      const r = await api('catalogs/customers/' + customer.id + '/signup-link', {
        method: 'POST',
        headers,
        body: '{}',
      });
      const d = await api('catalogs/' + kind, { headers });
      setData(d);
      const fresh = filtered(d[kind]);
      update(fresh);
      setActive(fresh.find((x) => x.id === customer.id)?._key || '');
      notify(r.message, 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
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
  const parentReady =
    kind === 'customers' || Boolean(customerId && (kind !== 'departments' || corporationId));
  const columns = [
    { field: 'code', header: '코드', width: 140 },
    { field: 'name', header: '명칭', width: 170 },
  ];
  const customer = data.customers.find(
    (r: any) =>
      r.id === (kind === 'customers' ? rows.find((r) => r._key === active)?.id : customerId),
  );
  return (
    <div className="catalog-screen">
      {/* 위 칸은 '찾기 조건'이다(등록은 아래 목록의 [행추가]). 등록 칸으로 오해하지 않게 이름과 안내를 붙인다(QA DL-028). */}
      <div className="query-bar" aria-label="조회 조건">
        <label>
          {title}코드로 찾기
          <input
            value={code}
            disabled={busy}
            placeholder="비우면 전체"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label>
          {title}명으로 찾기
          <input
            value={name}
            disabled={busy}
            placeholder="비우면 전체"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      <div
        className="catalog-columns"
        style={{
          gridTemplateColumns:
            kind === 'departments'
              ? '1fr 1fr 1.4fr'
              : kind === 'corporations'
                ? '1fr 1.5fr'
                : '1fr',
        }}
      >
        {kind !== 'customers' && (
          <section>
            <h2>고객사</h2>
            <DataGrid
              label="고객사 목록"
              columns={columns}
              rows={data.customers.map(wrap)}
              checks={false}
              active={customerId}
              onPick={pickCustomer}
              busy={busy}
            />
          </section>
        )}
        {kind === 'departments' && (
          <section>
            <h2>법인</h2>
            <DataGrid
              label="법인 목록"
              columns={columns}
              rows={data.corporations.filter((r: any) => r.customer_id === customerId).map(wrap)}
              checks={false}
              active={corporationId}
              onPick={pickCorporation}
              busy={busy}
            />
          </section>
        )}
        <section>
          <div className="grid-tools">
            <h2>{title} 목록</h2>
            <button disabled={busy || !parentReady || !screen.buttons.SAVE?.allowed} onClick={add}>
              행추가
            </button>
            <button disabled={busy} onClick={drop}>
              행삭제
            </button>
          </div>
          {/* 상위 항목을 고르기 전에는 목록이 비고 [행추가]가 잠기므로 이유를 알려 준다(QA DL-007). */}
          {!parentReady && (
            <p className="hint parent-hint">
              {kind === 'departments' && customerId
                ? '가운데 법인 목록에서 법인을 먼저 눌러 선택하세요. 그다음 [행추가]로 부서를 추가합니다.'
                : `왼쪽 고객사 목록에서 고객사를 먼저 눌러 선택하세요. 그다음 ${kind === 'departments' ? '법인을 고르고 ' : ''}[행추가]로 ${title}을(를) 추가합니다.`}
            </p>
          )}
          <DataGrid
            ref={grid}
            label={title + ' 편집'}
            rows={rows}
            columns={[
              { field: 'code', header: title + '코드', width: 160, editable: (r) => !r.id },
              { field: 'name', header: title + '명', width: 200, editable: true },
            ]}
            onChange={update}
            onPick={(r) => setActive(r._key)}
            active={active}
            busy={busy || !parentReady}
          />
        </section>
      </div>
      {kind === 'customers' &&
        (customer?.signup_token ? (
          // 링크에는 추측하기 쉬운 고객사 코드 대신 서버가 만든 무작위 가입 토큰을 쓴다.
          <div className="link-box">
            <strong>{customer.name} 가입 링크</strong>
            <code>{window.location.origin + '/?signup=' + customer.signup_token}</code>
            <button
              type="button"
              onClick={() =>
                navigator.clipboard
                  .writeText(window.location.origin + '/?signup=' + customer.signup_token)
                  .then(() =>
                    notify('가입 링크를 복사했습니다. 고객 담당자에게 보내 주세요.', 'success'),
                  )
                  .catch(() => notify('복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.'))
              }
            >
              가입 링크 복사
            </button>
            <button
              type="button"
              disabled={busy || !screen.buttons.SAVE?.allowed}
              onClick={() => void rotateLink(customer)}
            >
              새 링크로 바꾸기
            </button>
          </div>
        ) : (
          <p className="hint">
            저장된 고객사 행을 누르면 고객이 가입할 때 쓰는 링크가 여기에 나타납니다.
          </p>
        ))}
    </div>
  );
});
