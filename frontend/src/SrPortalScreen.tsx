/**
 * 고객 요청 화면(SR_PORTAL). 고객사 사용자가 요청을 등록하고 처리 상황을 보며 댓글·완료 확인을 한다.
 * 비전문가가 쓰는 화면이라 그리드 대신 카드 목록과 입력 폼을 쓴다. 서버: backend/src/requests.ts(portal).
 * 공통 툴바: 조회=목록 새로고침, 초기화=선택·입력 비우기, 저장=새 요청 등록 또는 댓글 등록, 완료 확인=ETC1.
 * 저장 성공 후에는 목록과 선택한 요청을 다시 읽어 DB 값만 표시하고, 실패하면 입력을 유지한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { categoryLabel, dateTime, eventText, priorityLabel, statusLabel } from './srLabels';

const emptyDraft = {
  title: '',
  body: '',
  category: 'REQUEST',
  priority: 'NORMAL',
  scope: '', // "법인ID:부서ID" 형태로 한 선택지에 담는다.
};

export const SrPortalScreen = forwardRef<
  ScreenHandle,
  {
    screen: Screen;
    notify: Notify;
    onState: (s: ViewState) => void;
    // 알림에서 넘어온 요청 ID. 바뀔 때마다 그 요청을 열어 보여 준다.
    focus?: { id: string; seq: number } | null;
  }
>(function SrPortalScreen({ screen, notify, onState, focus }, ref) {
  const [items, setItems] = useState<any[]>([]),
    [scopes, setScopes] = useState<any[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [creating, setCreating] = useState(false),
    [draft, setDraft] = useState(emptyDraft),
    [comment, setComment] = useState(''),
    [busy, setBusy] = useState(false);
  // 모든 요청에 메뉴 ID를 붙여 서버가 이 메뉴에서 허용된 버튼인지 검사하게 한다.
  const call = (path: string, body?: unknown) =>
    api('requests/portal' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Menu-ID': screen.menu_id },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const dirty = creating ? Boolean(draft.title || draft.body) : Boolean(comment.trim());
  const canConfirm = detail?.item.status === 'RESOLVED';
  // 툴바 버튼 상태를 알린다. 완료 확인은 '확인 대기' 요청을 선택했을 때만 누를 수 있다.
  useEffect(
    () => onState({ busy, dirty, disabledActions: canConfirm ? [] : ['ETC1'] }),
    [busy, dirty, canConfirm, onState],
  );
  async function load(keep = selected) {
    const r = await call('');
    setItems(r.items);
    setScopes(r.scopes);
    if (keep) setDetail(await call('/' + keep));
    else setDetail(null);
  }
  async function query() {
    setBusy(true);
    try {
      await load();
      notify('조회했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function pick(id: string) {
    setCreating(false);
    setSelected(id);
    setComment('');
    try {
      setDetail(await call('/' + id));
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }
  function startNew() {
    setCreating(true);
    setSelected(null);
    setDetail(null);
    // 매핑이 하나뿐이면 미리 선택해 입력을 줄인다.
    setDraft({
      ...emptyDraft,
      scope: scopes.length === 1 ? scopes[0].corporation_id + ':' + scopes[0].department_id : '',
    });
  }
  /** 저장: 새 요청 작성 중이면 등록, 요청을 보고 있으면 댓글 등록. 성공 후 다시 조회한다. */
  async function save() {
    if (creating) {
      const [corporationId, departmentId] = draft.scope.split(':');
      if (!draft.title.trim() || !draft.body.trim() || !corporationId) {
        notify('제목·내용·법인/부서를 입력해주세요.');
        return false;
      }
      if (!window.confirm('요청을 등록할까요?')) return false;
      const r = await call('', {
        title: draft.title,
        body: draft.body,
        category: draft.category,
        priority: draft.priority,
        corporationId,
        departmentId,
      });
      setCreating(false);
      setDraft(emptyDraft);
      setSelected(r.id);
      await load(r.id);
      notify(r.message, 'success');
      return true;
    }
    if (!selected || !comment.trim()) {
      notify('새 요청을 작성하거나, 요청을 선택해 댓글을 입력해주세요.');
      return false;
    }
    if (!window.confirm('댓글을 등록할까요?')) return false;
    const r = await call('/' + selected + '/comment', { body: comment });
    setComment('');
    await load(selected);
    notify(r.message, 'success');
    return true;
  }
  /** 폼 아래 버튼용 저장. 툴바 저장과 같은 처리를 하고, 오류는 여기서 알린다(툴바는 main.tsx가 알림). */
  async function submitHere() {
    setBusy(true);
    try {
      await save();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function decide(accept: boolean) {
    if (!detail || !canConfirm) return;
    // 재처리 요청은 이유가 있어야 담당자가 무엇을 다시 할지 안다. 아래 댓글 칸에 적은 내용을 사유로 보낸다.
    if (!accept && !comment.trim()) {
      notify('재처리가 필요한 이유를 아래 댓글 칸에 적은 뒤 [재처리 요청]을 눌러주세요.', 'error');
      document.querySelector<HTMLTextAreaElement>('.sr-detail textarea')?.focus();
      return;
    }
    const question = accept
      ? '처리 결과를 확인하고 요청을 완료할까요?'
      : '처리 결과가 맞지 않아 다시 처리를 요청할까요?';
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const r = await call('/' + selected + (accept ? '/confirm' : '/reopen'), {
        version: detail.item.version,
        ...(accept ? {} : { reason: comment.trim() }),
      });
      if (!accept) setComment('');
      await load(selected);
      notify(r.message, 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (focus) void pick(focus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);
  useImperativeHandle(ref, () => ({
    // 툴바는 탭 상태가 바뀔 때만 다시 그려지므로 작성 모드에 따라 바뀌는 문구 대신 두 경우에 맞는 고정 문구를 쓴다.
    buttonLabels: { SAVE: '등록', ETC1: '완료 확인' },
    actions: { ETC1: () => decide(true) },
    query,
    reset: () => {
      setCreating(false);
      setSelected(null);
      setDetail(null);
      setDraft(emptyDraft);
      setComment('');
    },
    save,
  }));
  // 화면을 처음 열면 바로 목록을 보여준다.
  useEffect(() => {
    void load(null).catch((e) => notify((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="sr-screen">
      <section className="sr-list">
        <div className="grid-tools">
          {/* 고객사 관리자는 담당 부서 전체 요청을 보므로 '내 요청' 대신 '요청 목록'으로 부른다. */}
          <h2>요청 목록</h2>
          {screen.buttons.SAVE?.allowed && (
            <button className="primary" disabled={busy} onClick={startNew}>
              + 새 요청
            </button>
          )}
        </div>
        {!items.length && <p className="hint">등록된 요청이 없습니다.</p>}
        {items.map((r) => (
          <button
            key={r.id}
            className={'sr-card' + (selected === String(r.id) ? ' selected' : '')}
            onClick={() => pick(String(r.id))}
          >
            <span className="sr-card-head">
              <span className={'sr-badge sr-' + r.status}>{statusLabel[r.status]}</span>
              <small>#{r.request_no}</small>
              {r.overdue && <span className="sr-badge sr-overdue">기한 초과</span>}
            </span>
            <strong>{r.title}</strong>
            <small>
              {r.department_name} · {r.requester_name} · {dateTime(r.updated_at)}
            </small>
          </button>
        ))}
      </section>
      <section className="sr-detail">
        {creating ? (
          <div className="account-card">
            <h2>새 요청</h2>
            <label>
              제목
              <input
                value={draft.title}
                maxLength={200}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <div className="field-grid">
              <label>
                구분
                <select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                >
                  {Object.entries(categoryLabel).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                긴급도
                <select
                  value={draft.priority}
                  onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                >
                  {Object.entries(priorityLabel).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              법인 / 부서
              <select
                value={draft.scope}
                onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
              >
                <option value="">선택</option>
                {scopes.map((s) => (
                  <option
                    key={s.corporation_id + ':' + s.department_id}
                    value={s.corporation_id + ':' + s.department_id}
                  >
                    {s.corporation_name} / {s.department_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              내용
              <textarea
                rows={8}
                value={draft.body}
                maxLength={10000}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </label>
            {/* 휴대폰에서 내용을 쓴 뒤 화면 맨 위 툴바까지 올라가지 않도록 폼 아래에도 등록 버튼을 둔다. */}
            <button className="primary" disabled={busy} onClick={() => void submitHere()}>
              요청 등록
            </button>
          </div>
        ) : detail ? (
          <div className="account-card">
            <div className="sr-card-head">
              <span className={'sr-badge sr-' + detail.item.status}>
                {statusLabel[detail.item.status]}
              </span>
              <small>
                #{detail.item.request_no} · {categoryLabel[detail.item.category]} · 긴급도{' '}
                {priorityLabel[detail.item.priority]}
              </small>
            </div>
            <h2>{detail.item.title}</h2>
            <p className="sr-body">{detail.item.body}</p>
            <p className="hint">
              담당자 {detail.item.assignee_name || '배정 전'} · 처리 기한{' '}
              {dateTime(detail.item.due_at)}
            </p>
            {canConfirm && (
              <div className="sr-decide">
                <span>처리가 완료되었습니다. 결과를 확인해주세요.</span>
                {screen.buttons.ETC1?.allowed && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => decide(true)}>
                      완료 확인
                    </button>
                    <button disabled={busy} onClick={() => decide(false)}>
                      재처리 요청
                    </button>
                  </>
                )}
              </div>
            )}
            <ol className="sr-timeline">
              {detail.events.map((e: any) => (
                <li key={e.id} className={e.kind === 'COMMENT' ? 'comment' : 'change'}>
                  <small>
                    {e.actor_name} · {dateTime(e.created_at)}
                  </small>
                  <div>{eventText(e)}</div>
                </li>
              ))}
            </ol>
            {!['CLOSED', 'CANCELLED'].includes(detail.item.status) &&
              screen.buttons.SAVE?.allowed && (
                <>
                  <label>
                    댓글
                    <textarea
                      rows={3}
                      value={comment}
                      maxLength={10000}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </label>
                  <button disabled={busy || !comment.trim()} onClick={() => void submitHere()}>
                    댓글 등록
                  </button>
                </>
              )}
          </div>
        ) : (
          <div className="empty">요청을 선택하거나 [+ 새 요청]으로 등록하세요.</div>
        )}
      </section>
    </div>
  );
});
