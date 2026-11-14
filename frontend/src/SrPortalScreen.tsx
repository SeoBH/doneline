/**
 * 고객 요청 화면(SR_PORTAL). 고객사 사용자가 요청을 등록하고 처리 상황을 보며 댓글·완료 확인을 한다.
 * 비전문가가 쓰는 화면이라 그리드 대신 카드 목록과 입력 폼을 쓴다. 서버: backend/src/requests.ts(portal).
 * 공통 툴바: 조회=목록 새로고침, 초기화=선택·입력 비우기, 저장=새 요청 등록 또는 댓글 등록, 완료 확인=ETC1.
 * 저장 성공 후에는 목록과 선택한 요청을 다시 읽어 DB 값만 표시하고, 실패하면 입력을 유지한다.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { categoryLabel, dateTime, eventText, priorityLabel, statusLabel } from './srLabels';
import { Attachments, sizeText } from './Attachments';
import { ImageText, PastePreview, usePastedImages } from './PastedImages';
import { upload } from './api';
import { askText, confirmAction } from './ConfirmDialog';

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
    // 새 요청과 함께 올릴 파일. 요청이 먼저 만들어져야 첨부할 수 있어 등록 직후 차례로 올린다.
    [newFiles, setNewFiles] = useState<File[]>([]),
    [busy, setBusy] = useState(false);
  // 글 칸별 캡처 붙여넣기(PastedImages.tsx). 요청 내용과 댓글이 각자 따로 이미지를 모은다.
  const bodyImgs = usePastedImages(draft.body, (v) => setDraft((d) => ({ ...d, body: v })));
  const commentImgs = usePastedImages(comment, setComment);
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
  // 첫 목록을 받기 전에는 '요청 없음' 대신 '불러오는 중'을 보여 준다(QA DL-008: 빈 목록으로 오해).
  const [loaded, setLoaded] = useState(false);
  // keep: 다시 열 요청 ID(null이면 상세를 비움). listOnly: 목록만 읽고 상세는 건드리지 않는다(첫 조회용).
  async function load(keep = selected, listOnly = false) {
    const r = await call('');
    setItems(r.items);
    setScopes(r.scopes);
    setLoaded(true);
    if (listOnly) return;
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
    commentImgs.reset();
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
        notify('제목·내용·법인/부서를 입력해 주세요.');
        return false;
      }
      if (!(await confirmAction('요청을 등록할까요?'))) return false;
      // 붙여 넣은 이미지 표시를 저장 형식으로 바꾼다. 이미지는 요청이 만들어진 뒤 아래에서 올린다.
      const pasted = bodyImgs.tokens();
      const r = await call('', {
        title: draft.title,
        body: pasted.text,
        category: draft.category,
        priority: draft.priority,
        corporationId,
        departmentId,
      });
      setCreating(false);
      setDraft(emptyDraft);
      setSelected(r.id);
      // 첨부 실패가 요청 등록을 되돌리지는 않는다. 실패한 파일은 상세 화면에서 다시 올리도록 안내한다.
      let failed = 0;
      for (const f of newFiles) {
        const form = new FormData();
        form.append('file', f);
        await upload(`requests/portal/${r.id}/attachments`, form, {
          'X-Menu-ID': screen.menu_id,
        }).catch(() => failed++);
      }
      for (const img of pasted.used)
        await bodyImgs
          .uploadAll([img], `requests/portal/${r.id}`, screen.menu_id)
          .catch(() => failed++);
      setNewFiles([]);
      bodyImgs.reset();
      await load(r.id);
      notify(
        failed
          ? `${r.message} 파일 ${failed}개는 올리지 못했습니다. 아래에서 다시 첨부해 주세요.`
          : r.message,
        failed ? 'error' : 'success',
      );
      return true;
    }
    if (!selected || !comment.trim()) {
      notify('새 요청을 작성하거나, 요청을 선택해 댓글을 입력해 주세요.');
      return false;
    }
    if (!(await confirmAction('댓글을 등록할까요?'))) return false;
    // 댓글의 이미지는 먼저 올린다(실패하면 댓글을 남기지 않고 입력을 그대로 둔다).
    const pasted = commentImgs.tokens();
    await commentImgs.uploadAll(pasted.used, 'requests/portal/' + selected, screen.menu_id);
    const r = await call('/' + selected + '/comment', { body: pasted.text });
    setComment('');
    commentImgs.reset();
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
  /**
   * 완료 확인 또는 재처리 요청. 재처리는 확인 창 안에서 사유를 바로 받는다(QA DLV2-007).
   * 예전에는 '아래 댓글 칸에 적고 다시 누르기'였는데, 사유를 [댓글 등록]으로 먼저 올리면 다시 적어야 했다.
   * 댓글 칸에 적어 둔 글이 있으면 사유 칸에 미리 넣어 준다(캡처 이미지는 그 글과 함께 올라간다).
   */
  async function decide(accept: boolean) {
    if (!detail || !canConfirm) return;
    let reason = '';
    if (accept) {
      if (!(await confirmAction('처리 결과를 확인하고 요청을 완료할까요?'))) return;
    } else {
      const typed = await askText({
        title: '재처리 요청',
        message: '담당자가 무엇을 다시 해야 하는지 알 수 있게 이유를 적어 주세요.',
        confirmLabel: '재처리 요청',
        input: { label: '재처리 사유', required: true, initial: comment.trim(), max: 2000 },
      });
      if (typed === null) return;
      reason = typed;
    }
    setBusy(true);
    try {
      // 댓글 칸의 글을 그대로 사유로 썼다면, 그 글에 붙인 캡처도 먼저 첨부로 올린다.
      const fromComment = !accept && reason === comment.trim();
      const pasted = commentImgs.tokens();
      if (fromComment)
        await commentImgs.uploadAll(pasted.used, 'requests/portal/' + selected, screen.menu_id);
      const r = await call('/' + selected + (accept ? '/confirm' : '/reopen'), {
        version: detail.item.version,
        ...(accept ? {} : { reason: fromComment ? pasted.text.trim() : reason }),
      });
      if (!accept && reason === comment.trim()) {
        setComment('');
        commentImgs.reset();
      }
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
      bodyImgs.reset();
      commentImgs.reset();
    },
    save,
  }));
  // 화면을 처음 열면 바로 목록을 보여준다. 상세는 비우지 않는다: 알림을 눌러 이 화면이 새로 열린 경우
  // 알림의 요청을 먼저 고르는데, 목록 응답이 늦게 오면서 상세를 지워 버렸다(QA DLV2-006).
  useEffect(() => {
    void load(null, true).catch((e) => notify((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 목록만 조용히 새로 읽는다(상세·입력 중인 글은 건드리지 않음). 실패해도 알리지 않고 다음 기회에 다시 읽는다.
  const refreshing = useRef(false);
  async function refreshList() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const r = await call('');
      setItems(r.items);
      setLoaded(true);
    } catch {
      // 네트워크가 잠깐 끊긴 경우 등. 다음 주기에 다시 시도한다.
    } finally {
      refreshing.current = false;
    }
  }
  // 로그인 직후 첫 조회가 비어 보이는 경우(QA DL-008)와 새 요청·상태 변화를 [조회] 없이도 반영한다:
  // 2초 뒤 한 번 더, 이후 1분마다, 그리고 다른 창에 갔다가 돌아올 때 목록을 새로 읽는다.
  useEffect(() => {
    const again = window.setTimeout(() => void refreshList(), 2000);
    const timer = window.setInterval(() => void refreshList(), 60000);
    const onFocus = () => void refreshList();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearTimeout(again);
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
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
        {!items.length && (
          <p className="hint">{loaded ? '등록된 요청이 없습니다.' : '불러오는 중…'}</p>
        )}
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
                우선순위
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
                placeholder="화면 캡처는 이 칸에 바로 붙여 넣을 수 있습니다(Ctrl+V)."
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                onPaste={bodyImgs.onPaste}
                onDrop={bodyImgs.onDrop}
              />
            </label>
            <PastePreview
              images={bodyImgs.images}
              setWidth={bodyImgs.setWidth}
              remove={bodyImgs.remove}
            />
            {/* 첨부 파일(선택): 고른 파일을 등록 전에 목록으로 보여 주고 뺄 수 있게 한다(QA DL-025).
                휴대폰에서는 사진 촬영·앨범 선택도 된다. 파일당 10MB, 실행 파일 불가(서버 검사). */}
            <div className="sr-files">
              <strong>첨부 파일(선택)</strong>
              {newFiles.length > 0 && (
                <ul>
                  {newFiles.map((f, i) => (
                    <li key={f.name + i}>
                      <span>{f.name}</span>
                      <small>{sizeText(f.size)}</small>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => setNewFiles(newFiles.filter((_, j) => j !== i))}
                      >
                        빼기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="sr-files-add">
                <label className="file-button">
                  파일 고르기
                  <input
                    type="file"
                    multiple
                    className="visually-hidden"
                    onChange={(e) => {
                      // 여러 번 골라도 앞서 고른 파일에 덧붙인다. 같은 파일을 다시 고를 수 있게 칸은 비운다.
                      setNewFiles([...newFiles, ...Array.from(e.target.files || [])]);
                      e.target.value = '';
                    }}
                  />
                </label>
                <small>
                  요청을 등록할 때 함께 올라갑니다. 파일당 10MB, 요청당 20개까지. 실행 파일은 올릴
                  수 없습니다.
                </small>
              </div>
            </div>
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
                #{detail.item.request_no} · {categoryLabel[detail.item.category]} · 우선순위{' '}
                {priorityLabel[detail.item.priority]}
              </small>
            </div>
            <h2>{detail.item.title}</h2>
            <p className="sr-body">
              <ImageText
                text={detail.item.body}
                files={detail.attachments || []}
                base={'requests/portal/' + detail.item.id}
                menuId={screen.menu_id}
              />
            </p>
            <p className="hint">
              담당자 {detail.item.assignee_name || '배정 전'} · 처리 기한{' '}
              {dateTime(detail.item.due_at)}
            </p>
            {canConfirm && (
              <div className="sr-decide">
                <span>
                  처리가 완료되었습니다. 결과를 확인해 주세요.
                  {/* auto_close_at: 서버가 계산한 자동 완료 예정 시각(처리 완료 + 7일). */}
                  {detail.item.auto_close_at &&
                    ` ${dateTime(detail.item.auto_close_at)}까지 확인이 없으면 자동으로 완료됩니다.`}
                </span>
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
            <Attachments
              base={'requests/portal/' + detail.item.id}
              menuId={screen.menu_id}
              files={detail.attachments || []}
              canUpload={
                !['CLOSED', 'CANCELLED'].includes(detail.item.status) &&
                Boolean(screen.buttons.SAVE?.allowed)
              }
              onChanged={() => load(String(detail.item.id))}
              notify={notify}
            />
            <ol className="sr-timeline">
              {detail.events.map((e: any) => (
                <li key={e.id} className={e.kind === 'COMMENT' ? 'comment' : 'change'}>
                  <small>
                    {e.actor_name} · {dateTime(e.created_at)}
                  </small>
                  <div>
                    {e.kind === 'COMMENT' ? (
                      <ImageText
                        text={e.body}
                        files={detail.attachments || []}
                        base={'requests/portal/' + detail.item.id}
                        menuId={screen.menu_id}
                      />
                    ) : (
                      eventText(e)
                    )}
                  </div>
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
                      placeholder="화면 캡처는 이 칸에 바로 붙여 넣을 수 있습니다(Ctrl+V)."
                      onChange={(e) => setComment(e.target.value)}
                      onPaste={commentImgs.onPaste}
                      onDrop={commentImgs.onDrop}
                    />
                  </label>
                  <PastePreview
                    images={commentImgs.images}
                    setWidth={commentImgs.setWidth}
                    remove={commentImgs.remove}
                  />
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
