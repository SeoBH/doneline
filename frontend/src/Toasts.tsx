/**
 * 알림을 최대 네 개 표시한다.
 * 오류는 8초, 나머지는 4초 후 닫는다.
 * 마우스·키보드 포커스가 있으면 타이머를 해제하고 벗어나면 표시 시간을 새로 시작한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error';
export type Notify = (message: string, kind?: ToastKind) => void;
type Notice = { id: number; message: string; kind: ToastKind };

function Toast({ notice, dismiss }: { notice: Notice; dismiss: (id: number) => void }) {
  const [hovered, setHovered] = useState(false),
    [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(
      () => dismiss(notice.id),
      notice.kind === 'error' ? 8000 : 4000,
    );
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.kind, hovered, focused, dismiss]);
  return (
    <div
      className={'toast toast-' + notice.kind}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        {notice.kind === 'error' ? '!' : notice.kind === 'success' ? '✓' : 'i'}
      </span>
      <div className="toast-message">{notice.message}</div>
      <button className="toast-close" aria-label="알림 닫기" onClick={() => dismiss(notice.id)}>
        ×
      </button>
    </div>
  );
}

// 알림 ID를 재사용하지 않고 최근 네 개만 유지한다. 콜백 참조를 고정해 불필요한 타이머 재시작을 줄인다.
export function useToasts() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);
  const notify = useCallback<Notify>((message, kind = 'info') => {
    if (!message.trim()) return;
    const notice = { id: ++nextId.current, message, kind };
    setNotices((previous) => [...previous.slice(-3), notice]);
  }, []);
  const dismiss = useCallback(
    (id: number) => setNotices((previous) => previous.filter((n) => n.id !== id)),
    [],
  );
  const clear = useCallback(() => setNotices([]), []);
  return {
    notify,
    clear,
    viewport: (
      <section className="toast-stack" aria-label="알림">
        {notices.map((notice) => (
          <Toast key={notice.id} notice={notice} dismiss={dismiss} />
        ))}
      </section>
    ),
  };
}
