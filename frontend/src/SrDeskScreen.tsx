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
import {
  categoryLabel,
  dateTime,
  deskTransitions,
  eventText,
  priorityLabel,
  statusLabel,
} from './srLabels';

// 처리 폼의 초기값. status·assigneeId·priority는 선택한 요청의 현재 값으로 채운다.
const emptyForm = { status: '', assigneeId: '', priority: '', comment: '', internal: false };

export const SrDeskScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function SrDeskScreen({ screen, notify, onState }, ref) {
  const [filters, setFilters] = useState({ status: '', filter: 'all' }),
    [items, setItems] = useState<any[]>([]),
    [assignees, setAssignees] = useState<any[]>([]),
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
  // 현재 요청 값과 폼을 비교해 바뀐 것이 있으면 미저장 상태로 표시한다.
  const original = detail
    ? {
        status: detail.item.status,
        assigneeId: detail.item.assignee_id ? String(detail.item.assignee_id) : '',
        priority: detail.item.priority,
      }
    : null;
  const dirty = Boolean(
    original &&
      (form.status !== original.status ||
        form.assigneeId !== original.assigneeId ||
        form.priority !== original.priority ||
        form.comment.trim()),
  );
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
      status: d.item.status,
      assigneeId: d.item.assignee_id ? String(d.item.assignee_id) : '',
      priority: d.item.priority,
    });
  }
  async function load(keep = selected, f = filters) {
    const r = await call('?status=' + f.status + '&filter=' + f.filter);
    setItems(r.items);
    setAssignees(r.assignees);
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
      ...(form.status !== original.status ? { status: form.status } : {}),
      ...(form.assigneeId !== original.assigneeId ? { assigneeId: form.assigneeId } : {}),
      ...(form.priority !== original.priority ? { priority: form.priority } : {}),
      ...(form.comment.trim() ? { comment: form.comment, internal: form.internal } : {}),
    });
    await load(selected);
    notify(r.message, 'success');
    return true;
  }
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
            { field: 'statusText', header: '상태', width: 90 },
            { field: 'priorityText', header: '우선순위', width: 90 },
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
            <fieldset className="account-fields field-grid" disabled={busy || closed}>
              <label>
                상태
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {[detail.item.status, ...deskTransitions[detail.item.status]].map((s) => (
                    <option key={s} value={s}>
                      {statusLabel[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                담당자
                <select
                  value={form.assigneeId}
                  onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
                >
                  <option value="">미배정</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                우선순위
                <select
                  value={form.priority}
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
          <div className="empty">왼쪽 목록에서 요청을 선택하세요.</div>
        )}
      </section>
    </div>
  );
});
