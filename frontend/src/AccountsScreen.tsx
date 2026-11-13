/**
 * 사용자 등록·승인 화면. 기존 DataGrid와 ScreenHandle을 사용해 공통 툴바에 연결한다.
 * 첫 탭은 직접 등록·승인, 둘째 탭은 사용자별 법인·부서 매핑이며 ETC4 권한으로 저장한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from './api';
import { DataGrid, GridRow } from './DataGrid';
import { AccountForm, emptyAccount } from './AccountForm';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
export const AccountsScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function AccountsScreen({ screen, notify, onState }, ref) {
  const [options, setOptions] = useState<any>({
      customers: [],
      responsibilities: [],
      operator: false,
    }),
    [customerId, setCustomerId] = useState(''),
    [rows, setRows] = useState<GridRow[]>([]);
  const [draft, setDraft] = useState(emptyAccount),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState(''),
    [status, setStatus] = useState('');
  const [tab, setTab] = useState<'basic' | 'mapping'>('basic'),
    [selected, setSelected] = useState<GridRow | null>(null);
  const [corporationIds, setCorporationIds] = useState<string[]>([]),
    [departmentIds, setDepartmentIds] = useState<string[]>([]),
    [activeCorp, setActiveCorp] = useState(''),
    [mappingDirty, setMappingDirty] = useState(false),
    [editing, setEditing] = useState<GridRow | null>(null),
    [editCustomer, setEditCustomer] = useState('');
  const form = useRef<HTMLFormElement>(null),
    epoch = useRef(0);
  // 관리자가 직원에게 직접 전달할 비밀번호 설정 링크(메일 자동 발송 전까지 사용). 닫거나 다른 작업 전까지 표시한다.
  const [issuedLink, setIssuedLink] = useState<{ who: string; link: string } | null>(null);
  // 한 번에 승인하기 창: 대상 사용자, 지정할 역할, 소속 부서. 승인·역할 저장·부서 지정을 한 번의 확인으로 처리한다.
  const [quick, setQuick] = useState<GridRow | null>(null),
    [quickResp, setQuickResp] = useState(''),
    [quickDepts, setQuickDepts] = useState<string[]>([]);
  const customer = options.customers.find((c: any) => c.id === customerId),
    headers = { 'X-Menu-ID': screen.menu_id };
  const formDirty = Boolean(
    editing
      ? draft.name !== editing.display_name ||
          draft.address !== editing.address ||
          draft.mobile !== editing.mobile ||
          draft.email !== (editing.email || '') ||
          draft.respId !== (editing.resp_id || '') ||
          editCustomer !== (editing.customer_id || 'system')
      : Object.values(draft).some(Boolean),
  );
  const dirty = formDirty || mappingDirty || rows.some((r) => r._checked);
  const checked = rows.filter((r) => r._checked);
  const visibleActions =
    tab === 'basic'
      ? ['RESET', 'QUERY', 'SAVE', 'DELETE', 'ETC1', 'ETC2', 'ETC3']
      : ['RESET', 'QUERY', 'ETC4'];
  const disabledActions =
    tab === 'mapping'
      ? !selected || selected.account_status !== 'ACTIVE' || selected.authority_type === 'SYSTEM'
        ? ['ETC4']
        : []
      : ['DELETE', 'ETC1', 'ETC2', 'ETC3'].filter(
          (a) =>
            !checked.length ||
            (a === 'ETC1' &&
              checked.some(
                (r) => !['PENDING', 'REJECTED', 'SUSPENDED'].includes(r.account_status),
              )) ||
            (a === 'ETC2' && checked.some((r) => r.account_status !== 'PENDING')) ||
            (a === 'ETC3' && checked.some((r) => r.account_status !== 'ACTIVE')),
        );
  useEffect(
    () => onState({ busy, dirty, visibleActions, disabledActions }),
    [busy, dirty, tab, selected, rows, onState],
  );
  async function query() {
    const ticket = ++epoch.current;
    setBusy(true);
    try {
      const o = await api('accounts/options', { headers });
      if (ticket !== epoch.current) return;
      setOptions(o);

      const key = o.customers.some((c: any) => c.id === customerId)
        ? customerId
        : customerId === 'system' && o.operator
          ? 'system'
          : o.customers[0]?.id || (o.operator ? 'system' : '');
      setCustomerId(key);
      const data = key ? await api('accounts/' + key, { headers }) : { items: [] };
      if (ticket === epoch.current) {
        const fresh = data.items.map((r: any) => ({ ...r, _key: r.id, _checked: false }));
        setRows(fresh);
        const current = fresh.find((r: GridRow) => r.id === selected?.id) || null;
        restoreMapping(current);
        if (current) editAccount(current);
        else newAccount();
        setNote('');
      }
    } catch (e) {
      notify((e as Error).message, 'error');
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
    if (tab === 'mapping') {
      restoreMapping(selected);
      return;
    }
    epoch.current++;
    setRows((old) => old.map((r) => ({ ...r, _checked: false })));
    newAccount();
    setSelected(null);
    setMappingDirty(false);
    setCorporationIds([]);
    setDepartmentIds([]);
    setActiveCorp('');
    setNote('');
    setStatus('');
    setBusy(false);
  }
  function chooseCustomer(id: string) {
    if (dirty && !window.confirm('입력 중인 내용을 버리고 고객사를 변경할까요?')) return;
    epoch.current++;
    setCustomerId(id);
    setSelected(null);
    setMappingDirty(false);
    setCorporationIds([]);
    setDepartmentIds([]);
    setActiveCorp('');
    setRows([]);
    newAccount();
    setNote('');
  }
  async function save() {
    if (!form.current?.reportValidity() || !customerId) return false;
    if (editing) return updateAccount();
    if (
      !window.confirm(
        '사용자를 등록할까요? 등록 후 비밀번호 설정 링크를 직원에게 전달해야 로그인할 수 있습니다.',
      )
    )
      return false;
    setBusy(true);
    try {
      // 공용 가입 폼의 비밀번호 필드는 관리자 등록 요청에서 제외한다.
      const { password, ...profile } = draft;
      const r = await api('accounts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...profile,
          customerId: customerId === 'system' ? null : customerId,
        }),
      });
      setDraft(emptyAccount());
      notify(r.message, 'success');
      if (r.link) setIssuedLink({ who: profile.name, link: r.link });
      await query();
      return true;
    } catch (e) {
      notify((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }
  function editAccount(selected: GridRow) {
    setEditing(selected);
    setEditCustomer(selected.customer_id || 'system');
    setDraft({
      loginId: selected.login_id,
      name: selected.display_name,
      address: selected.address,
      mobile: selected.mobile,
      email: selected.email || '',
      respId: selected.resp_id || '',
      password: '',
    });
  }
  function newAccount() {
    setEditing(null);
    setDraft(emptyAccount());
  }
  async function passwordLink() {
    if (
      !editing ||
      !window.confirm(
        '비밀번호 설정 링크를 새로 만들까요? 이전에 만든 링크는 사용할 수 없게 됩니다.',
      )
    )
      return;
    setBusy(true);
    try {
      const r = await api('accounts/password-link', {
        method: 'POST',
        headers,
        body: JSON.stringify({ userId: editing.id, version: editing.version }),
      });
      notify(r.message, 'success');
      if (r.link) setIssuedLink({ who: editing.display_name, link: r.link });
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function updateAccount() {
    if (!editing || !window.confirm('선택한 사용자의 기본정보를 변경할까요?')) return false;
    setBusy(true);
    try {
      await api('accounts/update', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: editing.id,
          version: editing.version,
          name: draft.name,
          address: draft.address,
          mobile: draft.mobile,
          email: draft.email,
          respId: draft.respId,
          customerId: editCustomer === 'system' ? null : editCustomer,
        }),
      });
      newAccount();
      await query();
      notify('변경했습니다.', 'success');
      return true;
    } catch (e) {
      notify((e as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function review(action: 'approve' | 'reject' | 'suspend') {
    if (tab !== 'basic') {
      notify('기본정보·승인 탭에서 처리해주세요.');
      return;
    }
    const selected = rows.filter((r) => r._checked);
    if (!selected.length) {
      notify('처리할 행을 체크해주세요.');
      return;
    }
    // 가입 신청 1건 승인은 역할·소속 부서를 함께 고르는 창으로 한 번에 처리한다.
    if (
      action === 'approve' &&
      selected.length === 1 &&
      selected[0].account_status === 'PENDING' &&
      selected[0].customer_id
    ) {
      const row = selected[0];
      const defaultResp =
        row.resp_id ||
        options.responsibilities.find((r: any) => r.code === 'CUSTOMER_USER')?.id ||
        '';
      setQuick(row);
      setQuickResp(String(defaultResp));
      // 이미 지정된 부서가 있으면 그대로, 없고 고객사 부서가 하나뿐이면 그 부서를 미리 체크한다(고를 것이 없는 클릭을 줄임).
      const saved = (row.scopes || []).map((x: any) => String(x.department_id));
      const only = customer?.departments.length === 1 ? [String(customer.departments[0].id)] : [];
      setQuickDepts(saved.length ? saved : only);
      return;
    }
    if (action === 'approve' && selected.some((r) => !r.resp_id)) {
      notify('사용자정보에서 역할을 먼저 지정하고 저장해주세요.');
      return;
    }
    const reapprove = action === 'approve' && selected.some((r) => r.account_status !== 'PENDING');
    if (reapprove && !note.trim()) {
      notify('재승인 사유를 입력해주세요.');
      return;
    }
    const label = { approve: '승인', reject: '반려', suspend: '정지' }[action];
    if (
      !window.confirm(
        selected.length +
          '개 계정을 ' +
          label +
          '할까요?' +
          (reapprove ? ' 다시 사용 가능 상태로 변경합니다.' : ''),
      )
    )
      return;
    setBusy(true);
    try {
      await api('accounts/' + action, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customerId,
          note,
          rows: selected.map((r) => ({
            id: r.id,
            version: r.version,
          })),
        }),
      });
      notify(label + '했습니다.', 'success');
      await query();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  /**
   * 한 번에 승인: (1) 역할이 바뀌었으면 저장 -> (2) 승인 -> (3) 소속 법인·부서 지정을 차례로 요청한다.
   * 각 단계는 서버의 기존 검사(권한·버전)를 그대로 거치며, 버전이 바뀌므로 단계마다 최신 행을 다시 읽는다.
   * 중간에 실패하면 거기서 멈추고 이유를 알린다(끝난 단계는 유지되며 사용자등록 화면에서 이어서 처리할 수 있다).
   */
  async function quickApprove() {
    if (!quick || !customer) return;
    if (!quickResp || !quickDepts.length) {
      notify('역할과 소속 부서를 하나 이상 선택해주세요.', 'error');
      return;
    }
    setBusy(true);
    const latest = async () =>
      (await api('accounts/' + customerId, { headers })).items.find((r: any) => r.id === quick.id);
    try {
      let row: any = quick;
      if (String(row.resp_id || '') !== quickResp) {
        await api('accounts/update', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            userId: row.id,
            version: row.version,
            name: row.display_name,
            address: row.address || '',
            mobile: row.mobile,
            email: row.email || '',
            respId: quickResp,
            customerId: row.customer_id,
          }),
        });
        row = await latest();
      }
      await api('accounts/approve', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customerId,
          note: '',
          rows: [{ id: row.id, version: row.version }],
        }),
      });
      row = await latest();
      // 선택한 부서의 법인도 함께 지정한다(법인마다 부서가 하나 이상 있어야 로그인할 수 있음).
      const corporationIds = [
        ...new Set(
          customer.departments
            .filter((d: any) => quickDepts.includes(String(d.id)))
            .map((d: any) => String(d.corporation_id)),
        ),
      ];
      await api('accounts/mapping', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: row.id,
          version: row.version,
          corporationIds,
          departmentIds: quickDepts,
        }),
      });
      notify(quick.display_name + '님을 승인했습니다. 이제 로그인할 수 있습니다.', 'success');
      setQuick(null);
      await query();
    } catch (e) {
      notify((e as Error).message, 'error');
      await query();
    } finally {
      setBusy(false);
    }
  }
  // 클릭한 사용자의 저장된 스냅샷을 불러온다. 미저장 매핑은 사용자 전환 전에 확인한다.
  function pickUser(row: GridRow) {
    if (selected?.id === row.id) return;
    if (
      (mappingDirty || formDirty) &&
      !window.confirm('저장하지 않은 입력을 버리고 사용자를 변경할까요?')
    )
      return;
    restoreMapping(row);
    editAccount(row);
  }
  // 초기화는 선택 사용자의 마지막 조회 스냅샷으로 되돌리고 체크 해제를 저장하지 않는다.
  function restoreMapping(row: GridRow | null) {
    setSelected(row);
    setCorporationIds(row?.corporation_ids || []);
    setDepartmentIds(row?.scopes.map((s: any) => s.department_id) || []);
    setActiveCorp(row?.corporation_ids?.[0] || '');
    setMappingDirty(false);
  }
  async function remove() {
    if (
      !checked.length ||
      !window.confirm(checked.length + '개 사용자를 실제 삭제할까요? 복구할 수 없습니다.')
    )
      return;
    setBusy(true);
    try {
      await api('accounts/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ rows: checked.map((r) => ({ id: r.id, version: r.version })) }),
      });
      await query();
      notify('삭제했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function saveMapping() {
    if (tab !== 'mapping' || !selected) {
      notify('법인·부서 매핑 탭에서 사용자를 선택해주세요.');
      return;
    }
    if (!window.confirm('법인·부서 매핑을 저장할까요? 기존 로그인 세션은 종료됩니다.')) return;
    setBusy(true);
    try {
      await api('accounts/mapping', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          userId: selected.id,
          version: selected.version,
          corporationIds,
          departmentIds,
        }),
      });
      notify('매핑을 저장했습니다.', 'success');
      await query();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    query,
    reset,
    remove,
    save: async () => {
      if (tab === 'mapping') {
        notify('매핑 저장 버튼을 사용해주세요.');
        return false;
      }
      return save();
    },
    buttonLabels: { ETC1: '승인', ETC2: '반려', ETC3: '정지', ETC4: '매핑 저장' },
    actions: {
      ETC4: saveMapping,
      ETC1: () => review('approve'),
      ETC2: () => review('reject'),
      ETC3: () => review('suspend'),
    },
  }));
  const names: Record<string, string> = {
    PENDING: '승인 대기',
    ACTIVE: '승인 완료',
    REJECTED: '반려',
    SUSPENDED: '정지',
  };
  function scopeName(scopes: any[]) {
    return scopes
      .map((s) => {
        const co = customer?.corporations.find((c: any) => c.id === s.corporation_id),
          d = customer?.departments.find((d: any) => d.id === s.department_id);
        return (co?.code || s.corporation_id) + '/' + (d?.code || s.department_id);
      })
      .join(', ');
  }
  return (
    <div className="users-screen">
      <div className="account-tabs" role="tablist" aria-label="사용자등록 구분">
        <button
          role="tab"
          aria-selected={tab === 'basic'}
          disabled={busy}
          onClick={() => setTab('basic')}
        >
          기본정보·승인
        </button>
        <button
          role="tab"
          aria-selected={tab === 'mapping'}
          disabled={busy}
          onClick={() => setTab('mapping')}
        >
          법인·부서 매핑
        </button>
      </div>
      {quick && (
        <div className="modal-backdrop" onClick={() => !busy && setQuick(null)}>
          <div
            className="account-card quick-approve"
            role="dialog"
            aria-label="가입 승인"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{quick.display_name}님 가입 승인</h2>
            <p className="hint">역할과 소속 부서를 고르고 승인하면 바로 로그인할 수 있습니다.</p>
            <label>
              역할
              <select value={quickResp} onChange={(e) => setQuickResp(e.target.value)}>
                {options.responsibilities
                  .filter((r: any) => r.authority_type === 'CUSTOMER')
                  .map((r: any) => (
                    <option key={r.id} value={String(r.id)}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset className="account-fields">
              <legend>소속 부서 (하나 이상)</legend>
              {!customer?.departments.length && (
                <p className="hint">등록된 부서가 없습니다. 부서등록에서 먼저 추가해주세요.</p>
              )}
              {(customer?.departments || []).map((d: any) => {
                const corp = customer.corporations.find((c: any) => c.id === d.corporation_id);
                const id = String(d.id);
                return (
                  <label key={id} className="sr-check">
                    <input
                      type="checkbox"
                      checked={quickDepts.includes(id)}
                      onChange={(e) =>
                        setQuickDepts(
                          e.target.checked
                            ? [...quickDepts, id]
                            : quickDepts.filter((x) => x !== id),
                        )
                      }
                    />
                    {corp?.name} / {d.name}
                  </label>
                );
              })}
            </fieldset>
            <div className="lookup-actions">
              <button type="button" disabled={busy} onClick={() => setQuick(null)}>
                취소
              </button>
              <button type="button" className="primary" disabled={busy} onClick={quickApprove}>
                승인
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="account-screen">
        <section className="account-list">
          <div className="query-bar">
            <label>
              고객사
              <select
                aria-label="고객사"
                value={customerId}
                disabled={busy || !options.operator}
                onChange={(e) => chooseCustomer(e.target.value)}
              >
                <option value="">선택</option>
                {options.operator && <option value="system">우리 업체 직원 (고객사 없음)</option>}
                {options.customers.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              상태
              <select
                aria-label="상태"
                value={status}
                disabled={busy}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setRows((old) => old.map((r) => ({ ...r, _checked: false })));
                }}
              >
                <option value="">전체</option>
                {Object.entries(names).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DataGrid
            label="사용자 목록"
            onPick={pickUser}
            active={selected?._key}
            checks={tab === 'basic'}
            rows={rows.filter((r) => !status || r.account_status === status)}
            columns={[
              { field: 'login_id', header: '아이디', width: 140 },
              { field: 'display_name', header: '이름', width: 100 },
              { field: 'account_status', header: '상태', format: (v) => names[v] },
              { field: 'resp_name', header: '역할', width: 150 },
              { field: 'email', header: '이메일', width: 220 },
              {
                field: 'mapping_ready',
                header: '매핑 상태',
                format: (v) => (v ? '완료' : '매핑 필요'),
              },
              { field: 'mobile', header: '휴대전화', width: 140 },
              { field: 'address', header: '주소', width: 200 },
              { field: 'scopes', header: '법인/부서 범위', width: 260, format: scopeName },
              {
                field: 'registration_source',
                header: '등록 경로',
                format: (v) => (v === 'ADMIN' ? '관리자' : '회원가입'),
              },
              { field: 'review_note', header: '처리 사유', width: 200 },
            ]}
            onChange={(next) =>
              setRows((old) => old.map((r) => next.find((n) => n._key === r._key) || r))
            }
            busy={busy}
          />
          {tab === 'basic' && (
            <div className="account-review">
              <label>
                처리 사유 (반려·정지·재승인 필수)
                <input
                  value={note}
                  disabled={busy}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <small>
                체크 행 전체가 함께 처리됩니다. 승인 대상은 승인 대기·반려·정지, 정지 대상은 승인
                완료 계정입니다.
              </small>
            </div>
          )}
        </section>
        {tab === 'basic' ? (
          <form ref={form} className="account-card" onSubmit={(e) => e.preventDefault()}>
            <h2>사용자정보</h2>
            <button
              type="button"
              disabled={busy || !editing || !screen.buttons.SAVE?.allowed || formDirty}
              onClick={passwordLink}
            >
              비밀번호 설정 링크 만들기
            </button>
            {/* 메일 자동 발송 전까지: 관리자가 링크를 복사해 메신저 등으로 직접 전달한다. */}
            {issuedLink && (
              <div className="link-box" role="status">
                <strong>{issuedLink.who}님 비밀번호 설정 링크 (24시간 유효)</strong>
                <code>{issuedLink.link}</code>
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(issuedLink.link)
                      .then(() => notify('링크를 복사했습니다. 직원에게 전달해주세요.', 'success'))
                      .catch(() => notify('복사하지 못했습니다. 링크를 직접 선택해 복사해주세요.'))
                  }
                >
                  복사
                </button>
                <button type="button" onClick={() => setIssuedLink(null)}>
                  닫기
                </button>
              </div>
            )}
            {editing && (
              <small>
                이메일 {editing.email_verified_at ? '인증 완료' : '미인증'} · 비밀번호{' '}
                {editing.password_set ? '설정됨' : '미설정'}
              </small>
            )}
            {editing && (
              <label>
                등록 고객사
                <select
                  aria-label="등록 고객사"
                  value={editCustomer}
                  disabled={busy || !options.operator}
                  onChange={(e) => {
                    setEditCustomer(e.target.value);
                    setDraft({ ...draft, respId: '' });
                  }}
                >
                  {options.operator && <option value="system">우리 업체 직원 (고객사 없음)</option>}
                  {options.customers.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p>
              {editing
                ? '상단 저장으로 기본정보를 변경합니다. 고객사를 변경하면 기존 매핑은 제거됩니다.'
                : '여기서 등록한 사용자는 승인 없이 바로 사용됩니다. 고객사 사용자는 [법인·부서 매핑] 탭에서 소속 부서를 지정해야 로그인할 수 있습니다.'}
            </p>
            <AccountForm
              editing={Boolean(editing)}
              value={draft}
              onChange={setDraft}
              customer={{
                responsibilities: options.responsibilities.filter((r: any) =>
                  (editing ? editCustomer : customerId) === 'system'
                    ? r.authority_type === 'SYSTEM'
                    : r.authority_type === 'CUSTOMER',
                ),
              }}
              disabled={busy || (!customer && customerId !== 'system')}
            />
          </form>
        ) : (
          <section className="mapping-panels">
            <p>
              {selected
                ? selected.login_id + ' · ' + selected.display_name
                : '왼쪽에서 사용자를 선택해주세요.'}
            </p>
            <p>
              법인을 체크한 뒤 해당 법인을 클릭하여 아래에서 부서를 선택합니다. 각 법인에 부서가
              하나 이상 있어야 로그인할 수 있습니다.
            </p>
            <DataGrid
              label="법인 매핑"
              rows={(customer?.corporations || []).map((r: any) => ({
                ...r,
                _key: r.id,
                _checked: corporationIds.includes(r.id),
              }))}
              columns={[
                { field: 'code', header: '법인코드' },
                { field: 'name', header: '법인명', width: 180 },
              ]}
              active={activeCorp}
              busy={
                busy ||
                !selected ||
                selected.account_status !== 'ACTIVE' ||
                !screen.buttons.ETC4?.allowed
              }
              onPick={(r) => setActiveCorp(r.id)}
              onChange={(rs) => {
                const ids = rs.filter((r) => r._checked).map((r) => r.id);
                setCorporationIds(ids);
                setDepartmentIds((old) =>
                  old.filter((id) =>
                    customer.departments.some(
                      (d: any) => d.id === id && ids.includes(d.corporation_id),
                    ),
                  ),
                );
                setMappingDirty(true);
              }}
            />
            <h3>선택 법인의 부서</h3>
            <DataGrid
              label="부서 매핑"
              rows={(customer?.departments || [])
                .filter((d: any) => d.corporation_id === activeCorp)
                .map((d: any) => ({ ...d, _key: d.id, _checked: departmentIds.includes(d.id) }))}
              columns={[
                { field: 'code', header: '부서코드' },
                { field: 'name', header: '부서명', width: 180 },
              ]}
              busy={
                busy ||
                !selected ||
                selected.account_status !== 'ACTIVE' ||
                !corporationIds.includes(activeCorp) ||
                !screen.buttons.ETC4?.allowed
              }
              onChange={(rs) => {
                const shown = rs.map((r) => r.id);
                setDepartmentIds((old) => [
                  ...old.filter((id) => !shown.includes(id)),
                  ...rs.filter((r) => r._checked).map((r) => r.id),
                ]);
                setMappingDirty(true);
              }}
            />
          </section>
        )}
      </div>
    </div>
  );
});
