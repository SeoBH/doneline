/**
 * 앱 공통 확인 창. 브라우저 기본 confirm() 대신 Doneline 화면 모양으로 묻는다(QA DL-009: 기본 창이 완성도를 떨어뜨림).
 * 사용: if (!(await confirmAction('저장할까요?'))) return;  — 확인을 누르면 true, 취소·Esc·바깥 누르기는 false.
 * ConfirmHost를 main.tsx에 한 번 두면 어느 화면에서든 confirmAction으로 부를 수 있다.
 * '삭제'·'취소'·'버리고'처럼 되돌리기 어려운 동작은 확인 버튼을 빨간색으로 보여 준다.
 * askText: 사유처럼 글을 받아야 하는 확인(예: 재처리 요청 사유). 확인하면 입력한 글, 취소하면 null을 돌려준다.
 */
import { useEffect, useRef, useState } from 'react';

type Ask = { message: string; title?: string; confirmLabel?: string; danger?: boolean };
// input: 글 입력 칸을 함께 보여 줄 때의 설정. required면 비어 있을 때 확인 버튼을 막는다.
type TextAsk = Ask & {
  input: { label: string; required?: boolean; initial?: string; max?: number };
};
type Pending = Ask & { input?: TextAsk['input']; resolve: (ok: boolean, text?: string) => void };
// 화면에 떠 있는 ConfirmHost에 질문을 넘기는 통로. Host가 없으면(드문 경우) 브라우저 기본 창으로 대신한다.
let show: ((p: Pending) => void) | null = null;

/** 확인을 묻고 답을 기다린다. 문자열만 주면 제목 없이 내용만 보여 준다. */
export function confirmAction(ask: Ask | string): Promise<boolean> {
  const a = typeof ask === 'string' ? { message: ask } : ask;
  if (!show) return Promise.resolve(window.confirm(a.message));
  return new Promise((resolve) => show!({ ...a, resolve }));
}

/** 글을 받는 확인 창. 확인하면 앞뒤 공백을 뺀 글, 취소하면 null. Host가 없으면 브라우저 기본 입력 창으로 대신한다. */
export function askText(ask: TextAsk): Promise<string | null> {
  if (!show) {
    const v = window.prompt(ask.message, ask.input.initial || '');
    return Promise.resolve(v === null ? null : v.trim());
  }
  return new Promise((resolve) =>
    show!({ ...ask, resolve: (ok, text) => resolve(ok ? (text || '').trim() : null) }),
  );
}

// 되돌리기 어려운 동작인지 문구로 판단해 확인 버튼 색을 정한다(호출하는 곳마다 따로 지정하지 않게).
const risky = (m: string) => /삭제|취소할까요|버리고|종료됩니다|복구할 수 없습니다/.test(m);

export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const okButton = useRef<HTMLButtonElement>(null),
    textBox = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    // 한 번에 하나만 묻는다. 앞 질문이 남아 있으면 '취소'로 끝내고 새 질문을 띄운다.
    show = (p) =>
      setPending((old) => {
        old?.resolve(false);
        return p;
      });
    return () => {
      show = null;
    };
  }, []);
  // 창이 열리면 확인 버튼에 초점을 둔다(Enter로 바로 확인, Tab으로 취소 이동).
  // 글 입력 창이면 입력 칸에 초점을 둔다(바로 사유를 적을 수 있게).
  useEffect(() => {
    if (!pending) return;
    setText(pending.input?.initial || '');
    if (pending.input) textBox.current?.focus();
    else okButton.current?.focus();
  }, [pending]);
  if (!pending) return null;
  const close = (ok: boolean) => {
    pending.resolve(ok, text);
    setPending(null);
  };
  const blocked = Boolean(pending.input?.required && !text.trim());
  const danger = pending.danger ?? risky(pending.message);
  return (
    <div className="confirm-backdrop" onMouseDown={() => close(false)}>
      {/* alertdialog: 응답이 필요한 알림 창. aria-modal: 뒤 화면은 잠시 조작할 수 없다는 뜻. */}
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(false);
        }}
      >
        <h2 id="confirm-title">{pending.title || '확인'}</h2>
        <p id="confirm-message">{pending.message}</p>
        {pending.input && (
          <label className="confirm-input">
            {pending.input.label}
            <textarea
              ref={textBox}
              rows={4}
              value={text}
              maxLength={pending.input.max || 2000}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
        )}
        <div className="confirm-actions">
          <button type="button" onClick={() => close(false)}>
            취소
          </button>
          <button
            type="button"
            ref={okButton}
            className={danger ? 'danger-solid' : 'primary'}
            disabled={blocked}
            onClick={() => close(true)}
          >
            {pending.confirmLabel || '확인'}
          </button>
        </div>
      </div>
    </div>
  );
}
