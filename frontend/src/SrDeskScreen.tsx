/**
 * 요청 작업함(SR_DESK). 업체 담당자가 요청을 골라 상태·담당자·우선순위를 바꾸고 답변이나 내부 메모를 남긴다.
 * 많은 요청을 빠르게 훑어야 하므로 왼쪽은 읽기 전용 그리드, 오른쪽은 선택한 요청의 처리 폼이다.
 * 서버: backend/src/requests.ts(desk). 저장 시 version을 보내 다른 담당자와 동시에 바꾼 경우 충돌로 거절된다.
 * 저장 성공 후 현재 필터로 다시 조회하고, 실패하면 입력을 유지한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { api } from './api';
import { DataGrid } from './DataGrid';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { categoryLabel, dateTime, eventText, priorityLabel, statusLabel } from './srLabels';

// 처리 폼의 초기값. priority는 선택한 요청의 현재 값, assigneeId는 맡길 사람(관리자의 배정·재배정 선택)이다.
const emptyForm = { assigneeId: '', priority: '', comment: '', internal: false };

export const SrDeskScreen = forwardRef<
  ScreenHandle,
  {
    screen: Screen;
    notify: Notify;
    onState: (s: ViewState) => void;
    // 알림에서 넘어온 요청 ID. 바뀔 때마다 그 요청을 열어 보여 준다.
    focus?: { id: string; seq: number } | null;
  }
>(function SrDeskScreen({ screen, notify, onState, focus }, ref) {
  const [filters, setFilters] = useState({ status: '', filter: 'all' }),
    [items, setItems] = useState<any[]>([]),
    [assignees, setAssignees] = useState<any[]>([]),
    // 나(로그인한 직원)와 업체 관리자 여부. 서버 deskList가 알려 주며 변경 칸 잠금·담당자 선택지에 쓴다.
    [me, setMe] = useState<{ id: string; manager: boolean }>({ id: '', manager: false }),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [form, setForm] = useState(emptyForm),
    [busy, setBusy] = useState(false);
  const call = (path: string, body?: unknown) =>
    api('requests/desk' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Menu-ID': screen.menu_id },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // 우선순위를 바꾸었거나 답변을 적었으면 미저장 상태로 표시한다(진행 동작은 버튼을 누르는 즉시 저장된다).
  const original = detail ? { priority: detail.item.priority } : null;
  const dirty = Boolean(original && (form.priority !== original.priority || form.comment.trim()));
  useEffect(() => onState({ busy, dirty }), [busy, dirty, onState]);
  // 담당자 ID → 이름. 이력의 "담당자 변경"을 이름으로 보여줄 때 쓴다.
  const names = useMemo(
    () => Object.fromEntries(assignees.map((a) => [String(a.id), a.display_name])),
    [assignees],
  );
  function fill(d: any) {
    setDetail(d);
    setForm({
      ...emptyForm,
      assigneeId: d.item.assignee_id ? String(d.item.assignee_id) : '',
      priority: d.item.priority,
    });
  }
  async function load(keep = selected, f = filters) {
    const r = await call('?status=' + f.status + '&filter=' + f.filter);
    setItems(r.items);
    setAssignees(r.assignees);
    setMe(r.me);
    if (keep) fill(await call('/' + keep));
    else {
      setDetail(null);
      setForm(emptyForm);
    }
  }
  async function query(f = filters) {
    setBusy(true);
    try {
      await load(selected, f);
      notify('조회했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function pick(id: string) {
    if (dirty && !window.confirm('입력 중인 내용을 버리고 다른 요청을 열까요?')) return;
    setSelected(id);
    try {
      fill(await call('/' + id));
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  async function save() {
    if (!detail || !original) {
      notify('처리할 요청을 선택해주세요.');
      return false;
    }
    if (!dirty) {
      notify('변경된 내용이 없습니다.');
      return false;
    }
    if (!window.confirm('변경 내용을 저장할까요?')) return false;
    // 바뀐 항목만 보낸다. 서버는 보낸 항목마다 이력을 남기고 요청자에게 알린다.
    const r = await call('/' + selected, {
      version: detail.item.version,
      ...(form.priority !== original.priority ? { priority: form.priority } : {}),
      ...(form.comment.trim() ? { comment: form.comment, internal: form.internal } : {}),
    });
    await load(selected);
    notify(r.message, 'success');
    return true;
  }
  // 상세 안 버튼용: 처리 중 표시와 오류 안내를 맡는다(실패하면 입력은 그대로 남는다).
  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  // 진행 동작: 처리 시작(START)·처리 완료(RESOLVE)·되돌리기(REVERT)·요청 취소(CANCEL).
  // 되돌리기·취소는 답변/메모 칸의 내용을 사유로 보낸다. 우선순위 변경은 함께 보내지 않고 [저장]으로 따로 한다.
  async function act(action: 'START' | 'RESOLVE' | 'REVERT' | 'CANCEL') {
    if (!detail) return;
    const reason = form.comment.trim();
    if ((action === 'REVERT' || action === 'CANCEL') && !reason) {
      notify(
        (action === 'REVERT' ? '되돌리는' : '취소하는') +
          ' 사유를 답변/메모 칸에 적은 뒤 다시 눌러주세요.',
        'error',
      );
      return;
    }
    const ask = {
      START: '이 요청을 맡아 처리를 시작할까요?',
      RESOLVE: '처리 완료로 바꿀까요? 고객에게 결과 확인 요청이 갑니다.',
      REVERT: '접수 상태로 되돌리고 담당을 해제할까요? 다른 직원이 다시 맡을 수 있게 됩니다.',
      CANCEL: '이 요청을 취소할까요? 취소 사유가 고객에게 보입니다.',
    }[action];
    if (!window.confirm(ask)) return;
    await run(async () => {
      const r = await call('/' + selected, {
        version: detail.item.version,
        action,
        ...(action === 'START' && form.assigneeId && me.manager
          ? { assigneeId: form.assigneeId }
          : {}),
        ...(reason && action !== 'START' && action !== 'RESOLVE' ? { comment: reason } : {}),
      });
      await load(selected);
      notify(r.message, 'success');
    });
  }
  // 관리자: 처리 중 요청의 담당자만 바꾼다(상태는 그대로).
  async function reassign() {
    if (!detail || !window.confirm('담당자를 바꿀까요? 새 담당자에게 알림이 갑니다.')) return;
    await run(async () => {
      const r = await call('/' + selected, {
        version: detail.item.version,
        assigneeId: form.assigneeId,
      });
      await load(selected);
      notify(r.message, 'success');
    });
  }
  useEffect(() => {
    if (focus) void pick(focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);
  useImperativeHandle(ref, () => ({
    query: () => query(),
    reset: () => {
      setSelected(null);
      setDetail(null);
      setForm(emptyForm);
    },
    save,
  }));
  useEffect(() => {
    void load(null).catch((e) => notify((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = items.map((r) => ({
    ...r,
    _key: String(r.id),
    no: '#' + r.request_no,
    statusText: statusLabel[r.status],
    priorityText: priorityLabel[r.priority],
    due: (r.overdue ? '⚠ ' : '') + dateTime(r.due_at),
  }));
  const closed = detail && ['CLOSED', 'CANCELLED'].includes(detail.item.status);
  // 담당 규칙(서버 requests.ts deskUpdate와 같음): 남의 담당 요청은 관리자가 아니면 상태·담당·우선순위를 바꿀 수 없다.
  const owner = detail?.item.assignee_id ? String(detail.item.assignee_id) : '';
  const locked = Boolean(detail && owner && owner !== me.id && !me.manager);
  const canSave = Boolean(screen.buttons.SAVE?.allowed);
  // 지금 단계에서 다음에 할 일을 한 줄로 알려 준다.
  const stepHint = !detail
    ? ''
    : {
        OPEN: '접수됨 · 담당자가 맡으면 처리 중이 됩니다.',
        IN_PROGRESS: '처리 중 · 끝나면 [처리 완료]를 누르세요.',
        RESOLVED: '처리 완료 · 고객이 결과를 확인하면 완료됩니다.',
        CLOSED: '완료된 요청입니다.',
        CANCELLED: '취소된 요청입니다.',
      }[detail.item.status as string] || '';
  return (
    <div className="sr-screen sr-desk">
      <section className="sr-list">
        <div className="query-bar">
          <label>
            상태
            <select
              value={filters.status}
              onChange={(e) => {
                const f = { ...filters, status: e.target.value };
                setFilters(f);
                void query(f);
              }}
            >
              <option value="">진행 중 전체</option>
              {Object.entries(statusLabel).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            담당
            <select
              value={filters.filter}
              onChange={(e) => {
                const f = { ...filters, filter: e.target.value };
                setFilters(f);
                void query(f);
              }}
            >
              <option value="all">전체</option>
              <option value="mine">내 담당</option>
              <option value="none">미배정</option>
            </select>
          </label>
        </div>
        <DataGrid
          label="요청 목록"
          rows={rows}
          checks={false}
          busy={busy}
          active={selected || undefined}
          onPick={(r) => pick(r._key)}
          columns={[
            { field: 'no', header: '번호', width: 80 },
            { field: 'title', header: '제목', width: 240 },
            { field: 'customer_name', header: '고객사', width: 130 },
            {
              field: 'statusText',
              header: '상태',
              width: 100,
              render: (r) => <span className={'sr-badge sr-' + r.status}>{r.statusText}</span>,
            },
            {
              field: 'priorityText',
              header: '우선순위',
              width: 100,
              // 점 색으로 긴급도를 먼저 보이게 하고 글자도 함께 둔다(색만으로 구분하지 않기 위해).
              render: (r) => (
                <span className={'priority-dot priority-' + r.priority}>{r.priorityText}</span>
              ),
            },
            { field: 'assignee_name', header: '담당자', width: 110 },
            { field: 'due', header: '기한', width: 150 },
          ]}
        />
      </section>
      <section className="sr-detail">
        {detail ? (
          <div className="account-card">
            <div className="sr-card-head">
              <span className={'sr-badge sr-' + detail.item.status}>
                {statusLabel[detail.item.status]}
              </span>
              {detail.item.overdue && <span className="sr-badge sr-overdue">기한 초과</span>}
              <small>
                #{detail.item.request_no} · {categoryLabel[detail.item.category]} ·{' '}
                {detail.item.customer_name} / {detail.item.corporation_name} /{' '}
                {detail.item.department_name}
              </small>
            </div>
            <h2>{detail.item.title}</h2>
            <p className="hint">
              요청자 {detail.item.requester_name} · 등록 {dateTime(detail.item.created_at)} · 기한{' '}
              {dateTime(detail.item.due_at)}
            </p>
            <p className="sr-body">{detail.item.body}</p>
            {/* 진행 상자: 현재 상태와 담당자, 그리고 지금 할 수 있는 '다음 동작'만 버튼으로 보여 준다.
                상태를 직접 고르게 하면 단계를 건너뛰거나 거꾸로 갈 수 있어 SR 이력이 흐려지기 때문이다. */}
            <div className="sr-progress">
              <div className="sr-progress-now">
                <span>
                  담당자 <b>{detail.item.assignee_name || '미배정'}</b>
                  {owner && owner === me.id ? ' (나)' : ''}
                </span>
                <small>{stepHint}</small>
              </div>
              {locked ? (
                <p className="sr-notice">
                  {detail.item.assignee_name}님이 담당하는 요청입니다. 진행은 담당자나 업체 관리자만
                  할 수 있고, 아래에 댓글·내부 메모는 남길 수 있습니다.
                </p>
              ) : (
                canSave &&
                !closed && (
                  <div className="sr-progress-actions">
                    {detail.item.status === 'OPEN' && me.manager && (
                      <select
                        aria-label="맡길 담당자"
                        value={form.assigneeId}
                        disabled={busy}
                        onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                      >
                        <option value="">나에게</option>
                        {assignees
                          .filter((a) => String(a.id) !== me.id)
                          .map((a) => (
                            <option key={a.id} value={String(a.id)}>
                              {a.display_name}에게
                            </option>
                          ))}
                      </select>
                    )}
                    {detail.item.status === 'OPEN' && (
                      <button className="primary" disabled={busy} onClick={() => void act('START')}>
                        {me.manager && form.assigneeId ? '맡기고 처리 시작' : '내가 맡아 처리 시작'}
                      </button>
                    )}
                    {detail.item.status === 'IN_PROGRESS' && (
                      <>
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => void act('RESOLVE')}
                        >
                          처리 완료
                        </button>
                        <button disabled={busy} onClick={() => void act('REVERT')}>
                          되돌리기
                        </button>
                      </>
                    )}
                    {['OPEN', 'IN_PROGRESS'].includes(detail.item.status) && (
                      <button
                        className="danger-outline"
                        disabled={busy}
                        onClick={() => void act('CANCEL')}
                      >
                        요청 취소
                      </button>
                    )}
                  </div>
                )
              )}
              {/* 관리자: 처리 중 요청의 담당자만 바꾸는 재배정(상태는 처리 중 그대로) */}
              {me.manager && canSave && detail.item.status === 'IN_PROGRESS' && (
                <div className="sr-progress-actions">
                  <select
                    aria-label="담당자 변경"
                    value={form.assigneeId}
                    disabled={busy}
                    onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                  >
                    {assignees.map((a) => (
                      <option key={a.id} value={String(a.id)}>
                        {a.display_name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={busy || !form.assigneeId || form.assigneeId === owner}
                    onClick={() => void reassign()}
                  >
                    담당자 변경
                  </button>
                </div>
              )}
            </div>
            <fieldset className="account-fields field-grid" disabled={busy || closed}>
              <label>
                우선순위
                <select
                  value={form.priority}
                  disabled={locked || detail.item.status === 'RESOLVED'}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                >
                  {Object.entries(priorityLabel).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="account-wide">
                답변 / 메모
                <textarea
                  rows={3}
                  value={form.comment}
                  maxLength={10000}
                  placeholder="되돌리기·요청 취소 때는 이 칸에 사유를 적어주세요."
                  onChange={(e) => setForm({ ...form, comment: e.target.value })}
                />
              </label>
              <label className="account-wide sr-check">
                <input
                  type="checkbox"
                  checked={form.internal}
                  onChange={(e) => setForm({ ...form, internal: e.target.checked })}
                />
                내부 메모(고객에게 보이지 않음)
              </label>
            </fieldset>
            {/* 답변·우선순위 저장. 처리 칸을 채운 뒤 화면 맨 위 툴바까지 가지 않도록 바로 아래에 둔다(툴바 [저장]과 같은 동작). */}
            {!closed && canSave && (
              <div className="form-actions">
                <button
                  className="primary"
                  disabled={busy || !dirty}
                  onClick={() => void run(save)}
                >
                  저장
                </button>
              </div>
            )}
            <ol className="sr-timeline">
              {detail.events.map((e: any) => (
                <li
                  key={e.id}
                  className={
                    (e.kind === 'COMMENT' ? 'comment' : 'change') + (e.internal ? ' internal' : '')
                  }
                >
                  <small>
                    {e.actor_name}
                    {e.actor_is_customer ? ' (고객)' : ''} · {dateTime(e.created_at)}
                    {e.internal ? ' · 내부 메모' : ''}
                  </small>
                  <div>{eventText(e, names)}</div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="empty">목록에서 요청을 선택하세요.</div>
        )}
      </section>
    </div>
  );
});
