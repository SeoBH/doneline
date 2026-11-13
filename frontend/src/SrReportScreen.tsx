/**
 * 월간 리포트 화면(SR_REPORT). 월·고객사를 골라 처리 실적을 보고 엑셀로 내려받는다.
 * 서버: backend/src/reports.ts. 툴바 조회=QUERY, 엑셀 다운로드=ETC1.
 * 지표 정의는 서버 주석과 같다: 처리 SLA 준수율=기한 내 처리 완료/처리 완료, 첫 응답 준수율=기한 내 첫 응답/판단 가능한 등록 건.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { api } from './api';
import { Screen, ScreenHandle, ViewState } from './types';
import { Notify } from './Toasts';

// 기본 조회 월: 이번 달. 처음 가입한 업체도 바로 실적이 보이게 하고, 지난달 보고는 월을 바꿔 조회한다.
function thisMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
const pct = (v: number | null) => (v === null || v === undefined ? '—' : v + '%');

export const SrReportScreen = forwardRef<
  ScreenHandle,
  { screen: Screen; notify: Notify; onState: (s: ViewState) => void }
>(function SrReportScreen({ screen, notify, onState }, ref) {
  const [month, setMonth] = useState(thisMonth),
    [customerId, setCustomerId] = useState(''),
    [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => onState({ busy, dirty: false }), [busy, onState]);
  const qs = () =>
    '?month=' + encodeURIComponent(month) + '&customerId=' + encodeURIComponent(customerId);
  async function query() {
    setBusy(true);
    try {
      setData(await api('reports/monthly' + qs(), { headers: { 'X-Menu-ID': screen.menu_id } }));
      notify('조회했습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  /** 엑셀은 JSON이 아니라 파일이므로 fetch로 직접 받아 브라우저 다운로드를 만든다. */
  async function download() {
    setBusy(true);
    try {
      const res = await fetch('/api/reports/monthly.xlsx' + qs(), {
        headers: { 'X-Menu-ID': screen.menu_id },
      });
      if (!res.ok) throw new Error((await res.json()).message || '다운로드에 실패했습니다.');
      // Blob(파일 내용)을 임시 주소로 만들어 숨은 링크를 눌러 저장하고, 주소는 바로 해제한다.
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `Doneline_월간리포트_${month}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      notify('엑셀 파일을 내려받았습니다.', 'success');
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    buttonLabels: { ETC1: '엑셀 다운로드' },
    actions: { ETC1: download },
    query,
    reset: () => {
      setMonth(thisMonth());
      setCustomerId('');
      setData(null);
    },
  }));
  useEffect(() => {
    void query();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = data ? [...data.rows, { customer_name: '합계', ...data.total, total: true }] : [];
  return (
    <div className="report-screen">
      <div className="query-bar">
        <label>
          조회 월
          <input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
          />
        </label>
        <label>
          고객사
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">전체</option>
            {(data?.customers || []).map((c: any) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        월 기준은 한국 시간입니다. 조건을 바꾼 뒤 [조회]를 누르세요. [엑셀 다운로드]는 요약과 요청
        목록 시트를 함께 내려받습니다.
      </p>
      <p className="hint">
        처리 SLA 준수율 = 처리 완료 건 중 기한 안에 끝낸 비율 · 첫 응답 SLA 준수율 = 등록 건 중 첫
        응답 기한 안에 답한 비율 · 평균 처리 시간 = 등록부터 처리 완료까지
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>고객사</th>
              <th>등록</th>
              <th>처리 완료</th>
              <th>고객 확인 완료</th>
              {/* title: 마우스를 올리면 지표 정의를 보여 준다. 아래 범례에도 같은 설명을 둔다. */}
              <th title="그 달 처리 완료 건 중 처리 기한 안에 끝낸 비율">처리 SLA 준수율</th>
              <th title="그 달 등록 건 중 첫 응답 기한 안에 답한 비율">첫 응답 SLA 준수율</th>
              <th title="등록부터 처리 완료까지 걸린 평균 시간">평균 처리 시간</th>
              <th title="지금 접수·처리 중·확인 대기인 건수">현재 진행 중</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.total ? 'total' : r.customer_id} className={r.total ? 'total-row' : ''}>
                <td>{r.customer_name}</td>
                <td>{r.created}</td>
                <td>{r.resolved}</td>
                <td>{r.closed}</td>
                <td>{pct(r.resolveRate)}</td>
                <td>{pct(r.responseRate)}</td>
                <td>{r.avg_resolve_hours === null ? '—' : r.avg_resolve_hours + '시간'}</td>
                <td>{r.open_now}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});
