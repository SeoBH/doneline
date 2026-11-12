/** 고객사/법인/부서등록의 공통 그리드. 화면별 부모 선택 깊이만 다르며 체크 행만 저장한다. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from './api';
import { DataGrid, GridHandle, GridRow } from './DataGrid';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
const wrap = (r: any): GridRow => ({ ...r, _key: r.id, _checked: false });
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
    grid.current?.stop();
    const ticket = ++epoch.current;
    setBusy(true);
    try {
      const d = await api('catalogs/' + kind, { headers });
      if (ticket !== epoch.current) return;
      setData(d);
      const customer = d.customers.some((r: any) => r.id === customerId)
        ? customerId
        : d.customers[0]?.id || '';
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
  function reset() {
    epoch.current++;
    grid.current?.stop();
    update([]);
    setCode('');
    setName('');
    setActive('');
    setBusy(false);
  }
  function pickCustomer(r: GridRow) {
    grid.current?.stop();
    if (
      latest.current.some((r) => r._checked) &&
      !window.confirm('편집 중인 행을 버리고 고객사를 변경할까요?')
    )
      return;
    setCustomerId(r.id);
    setCorporationId('');
    setActive('');
    update(filtered(data[kind], r.id, ''));
  }
  function pickCorporation(r: GridRow) {
    grid.current?.stop();
    if (
      latest.current.some((r) => r._checked) &&
      !window.confirm('편집 중인 행을 버리고 법인을 변경할까요?')
    )
      return;
    setCorporationId(r.id);
    setActive('');
    update(filtered(data[kind], customerId, r.id));
  }
  function add() {
    grid.current?.stop();
    update([...latest.current, { _key: crypto.randomUUID(), _checked: true, code: '', name: '' }]);
  }
  function drop() {
    grid.current?.stop();
    update(latest.current.filter((r) => r.id || !r._checked));
  }
  async function batch(remove = false) {
    grid.current?.stop();
    const selected = latest.current.filter((r) => r._checked);
    if (!selected.length) {
      notify('처리할 행을 체크해주세요.');
      return false;
    }
    if (!window.confirm(selected.length + '개 행을 ' + (remove ? '삭제' : '저장') + '할까요?'))
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
      // 성공 후 전체를 다시 읽는다. 체크하지 않은 신규/수정 행도 DB 상태로 교체한다.
      update([]);
      setActive('');
      const d = await api('catalogs/' + kind, { headers });
      setData(d);
      update(filtered(d[kind]));
      notify((remove ? '삭제' : '저장') + '했습니다.', 'success');
      return true;
    } catch (e) {
      notify(
        (committed ? '변경은 완료됐지만 재조회하지 못했습니다. 조회 버튼으로 확인해주세요. ' : '') +
          (e as Error).message,
        'error',
      );
      return committed;
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
      <div className="query-bar">
        <label>
          {title}코드
          <input value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          {title}명<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
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
      {customer && kind === 'customers' && (
        <p>
          회원가입 링크:{' '}
          {/* 링크에는 추측하기 쉬운 고객사 코드 대신 서버가 만든 무작위 가입 토큰을 쓴다. */}
          <a href={'/?signup=' + customer.signup_token} target="_blank" rel="noreferrer">
            {window.location.origin + '/?signup=' + customer.signup_token}
          </a>
        </p>
      )}
    </div>
  );
});
