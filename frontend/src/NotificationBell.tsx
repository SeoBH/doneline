/**
 * 상단 헤더의 앱 안 알림(종 아이콘). 안 읽은 개수를 표시하고 누르면 최근 알림 목록을 연다.
 * 서버: GET /api/notifications, POST /api/notifications/read (backend/src/requests.ts).
 * 실시간 연결 없이 1분마다, 그리고 창으로 돌아올 때 다시 읽는다(서버 부담과 구현을 단순하게 유지).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { dateTime } from './srLabels';
import { Icon } from './Icon';

// onOpen: 알림을 누르면 관련 화면(요청 상세·사용자등록)을 여는 함수. main.tsx가 화면 이동을 맡는다.
export function NotificationBell({ onOpen }: { onOpen: (n: any) => void }) {
  const [data, setData] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 }),
    [open, setOpen] = useState(false),
    box = useRef<HTMLDivElement>(null);
  // 패널이 열려 있을 때 바깥을 누르면 닫는다(휴대폰에서 패널이 화면을 덮어 다른 곳을 누를 수 없게 되는 문제 방지).
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  // useCallback: 함수 참조를 고정해 아래 effect가 렌더마다 타이머를 다시 만들지 않게 한다.
  const load = useCallback(() => {
    // 알림은 보조 기능이므로 실패해도 화면에 오류를 띄우지 않고 다음 주기에 다시 시도한다.
    api('notifications')
      .then(setData)
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60000);
    window.addEventListener('focus', load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [load]);
  async function readAll() {
    await api('notifications/read', { method: 'POST', body: JSON.stringify({ ids: [] }) }).catch(
      () => {},
    );
    load();
  }
  return (
    <div className="bell" ref={box}>
      <button
        aria-label={'알림 ' + data.unread + '건'}
        aria-expanded={open}
        onClick={(e) => {
          // 바깥 클릭으로 닫히는 우클릭 메뉴 처리와 겹치지 않도록 이벤트 전파를 막는다.
          e.stopPropagation();
          setOpen(!open);
          if (!open) load();
        }}
      >
        <Icon name="bell" />
        {data.unread > 0 && <span className="bell-count">{data.unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" onClick={(e) => e.stopPropagation()}>
          <div className="grid-tools">
            <strong>알림</strong>
            <button className="link-button" onClick={readAll} disabled={!data.unread}>
              모두 읽음
            </button>
          </div>
          {!data.items.length && <p className="hint">알림이 없습니다.</p>}
          <ul>
            {data.items.map((n) => (
              <li key={n.id} className={n.read_at ? '' : 'unread'}>
                <button
                  className="bell-item"
                  onClick={() => {
                    // 누른 알림은 읽음으로 바꾸고 관련 화면으로 이동한다.
                    void api('notifications/read', {
                      method: 'POST',
                      body: JSON.stringify({ ids: [String(n.id)] }),
                    })
                      .catch(() => {})
                      .then(load);
                    setOpen(false);
                    onOpen(n);
                  }}
                >
                  <div>{n.message}</div>
                  <small>{dateTime(n.created_at)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
