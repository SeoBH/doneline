/**
 * 감사 조회 화면. 이벤트 조회 후 행 선택 시 변경 전후 JSON을 표시한다.
 * 메뉴 ID를 보내 서버 권한 검사를 거치며 상세가 없는 이벤트도 정상 결과로 안내한다.
 */
import { forwardRef, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle } from './types';
import { Notify } from './Toasts';
export const AuditScreen = forwardRef<ScreenHandle, { screen: Screen; notify: Notify }>(
  function AuditScreen({ screen, notify }, ref) {
    const [items, setItems] = useState<any[]>([]);
    const [detail, setDetail] = useState<any[]>([]);
    async function query() {
      try {
        const r = await api('admin/audit-events', { headers: { 'X-Menu-ID': screen.menu_id } });
        setItems(r.items);
        setDetail([]);
        notify('조회했습니다.', 'success');
      } catch (e) {
        notify((e as Error).message, 'error');
      }
    }
    async function changes(eventId: string) {
      try {
        const r = await api('admin/audit-events/' + eventId + '/changes', {
          headers: { 'X-Menu-ID': screen.menu_id },
        });
        setDetail(r.items);
        if (!r.items.length) notify('이 작업에는 설정 변경 이력이 없습니다.', 'success');
      } catch (e) {
        notify((e as Error).message, 'error');
      }
    }
    useImperativeHandle(ref, () => ({
      query,
      reset: () => {
        setItems([]);
        setDetail([]);
      },
    }));
    return (
      <>
        <p className="hint">행을 선택하면 권한·메뉴 설정의 변경 전후 내용을 확인할 수 있습니다.</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>시각</th>
                <th>기능</th>
                <th>결과</th>
                <th>사용자</th>
                <th>요청 ID</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.event_id}>
                  <td>{new Date(row.occurred_at).toLocaleString('ko-KR')}</td>
                  <td>
                    <button className="link-button" onClick={() => changes(row.event_id)}>
                      {row.action}
                    </button>
                  </td>
                  <td>{row.outcome}</td>
                  <td>{row.user_id || '—'}</td>
                  <td>{row.request_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {detail.map((d) => (
          <section className="change-detail" key={d.id}>
            <h3>
              {d.entity_type} · {d.change_type}
            </h3>
            <div className="field-grid">
              <div>
                <h4>변경 전</h4>
                <pre>{JSON.stringify(d.before_values, null, 2) || '없음'}</pre>
              </div>
              <div>
                <h4>변경 후</h4>
                <pre>{JSON.stringify(d.after_values, null, 2) || '없음'}</pre>
              </div>
            </div>
          </section>
        ))}
      </>
    );
  },
);
