/**
 * SLA 설정 화면(SLA_SETTINGS). 우선순위별 첫 응답 기한·처리 기한(시간)을 정한다.
 * 항목이 4개로 고정이라 그리드 대신 표 안의 숫자 입력칸을 쓴다. 서버: backend/src/sla.ts.
 * 저장은 바뀐 행만 보내며, 성공하면 다시 조회해 DB 값만 표시한다. 변경은 이후 등록되는 요청부터 적용된다.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';
import { priorityLabel } from './srLabels';

type Row = {
  priority: string;
  responseHours: number;
  resolveHours: number;
  version: number | null;
  custom: boolean;
};

export const SlaSettingsScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function SlaSettingsScreen({ screen, notify, onState }, ref) {
  const [saved, setSaved] = useState<Row[]>([]),
    [rows, setRows] = useState<Row[]>([]),
    [busy, setBusy] = useState(false);
  // 저장된 값과 다른 행만 저장 대상이다.
  const changed = rows.filter((r, i) => {
    const s = saved[i];
    return s && (r.responseHours !== s.responseHours || r.resolveHours !== s.resolveHours);
  });
  useEffect(() => onState({ busy, dirty: changed.length > 0 }), [busy, changed.length, onState]);
  const headers = { 'X-Menu-ID': screen.menu_id };
  async function load() {
    const r = await api('sla', { headers });
    setSaved(r.items);
    setRows(r.items);
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
  async function save() {
    if (!changed.length) {
      notify('변경된 내용이 없습니다.');
      return false;
    }
    // 입력 중에는 빈칸을 허용하므로(0으로 보관) 저장할 때 범위를 검사한다.
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 8760;
    if (changed.some((r) => !valid(r.responseHours) || !valid(r.resolveHours))) {
      notify('기한은 1~8760 사이의 정수(시간)로 입력해주세요.', 'error');
      return false;
    }
    if (changed.some((r) => r.responseHours > r.resolveHours)) {
      notify('첫 응답 기한은 처리 기한보다 길 수 없습니다.', 'error');
      return false;
    }
    if (!window.confirm('SLA를 저장할까요? 이후 등록되는 요청부터 적용됩니다.')) return false;
    const r = await api('sla', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rows: changed.map(({ priority, responseHours, resolveHours, version }) => ({
          priority,
          responseHours,
          resolveHours,
          ...(version ? { version } : {}),
        })),
      }),
    });
    await load();
    notify(r.message, 'success');
    return true;
  }
  useImperativeHandle(ref, () => ({ query, reset: () => setRows(saved), save }));
  useEffect(() => {
    void load().catch((e) => notify((e as Error).message, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 숫자 입력 중에는 칸을 비울 수 있게 빈칸을 0으로 보관하고, 범위(1~8760, 1년=8760시간)는 저장할 때 검사한다.
  const set = (i: number, key: 'responseHours' | 'resolveHours', value: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [key]: value === '' ? 0 : Number(value) } : r)));
  return (
    <div className="sla-screen">
      <p className="hint">
        기한은 요청 등록 시점부터의 시간(주말 포함)입니다. 저장하면 이후 등록되는 요청부터 적용되고,
        이미 등록된 요청의 기한은 바뀌지 않습니다.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>우선순위</th>
              <th>첫 응답 기한(시간)</th>
              <th>처리 기한(시간)</th>
              <th>구분</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.priority}>
                <td>{priorityLabel[r.priority]}</td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    aria-label={priorityLabel[r.priority] + ' 첫 응답 기한'}
                    value={r.responseHours || ''}
                    disabled={busy || !screen.buttons.SAVE?.allowed}
                    onChange={(e) => set(i, 'responseHours', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    aria-label={priorityLabel[r.priority] + ' 처리 기한'}
                    value={r.resolveHours || ''}
                    disabled={busy || !screen.buttons.SAVE?.allowed}
                    onChange={(e) => set(i, 'resolveHours', e.target.value)}
                  />
                </td>
                <td>{r.custom ? '업체 설정' : '기본값'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
