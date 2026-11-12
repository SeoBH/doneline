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
        '승인 없이 사용자를 등록할까요? CUSTOMER 계정은 매핑까지 완료해야 로그인할 수 있습니다.',
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
        '저장된 이메일로 비밀번호 설정 메일을 준비할까요? 현재 실제 발송은 보류됩니다.',
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
    if (action === 'approve' && selected.some((r) => !r.resp_id)) {
      notify('사용자 수정에서 RESP를 먼저 지정해주세요.');
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
                {options.operator && <option value="system">SYSTEM 계정 (고객사 없음)</option>}
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
              { field: 'resp_code', header: 'RESP', width: 170 },
              { field: 'resp_level', header: 'RESP 레벨' },
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
              비밀번호 재설정 메일 준비
            </button>
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
                  {options.operator && <option value="system">SYSTEM 계정 (고객사 없음)</option>}
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
                : '직접 등록은 별도 승인이 없습니다. CUSTOMER 계정은 두 번째 탭에서 매핑해주세요.'}
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
