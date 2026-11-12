/** DB 없이 공통 그리드/팝업 계약을 검증하는 테스트 화면. 실제 업무의 접근 범위 검사는 서버에서 별도로 해야 한다. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DataGrid, GridRow } from '../src/DataGrid';
import '../src/style.css';
import './lookup.css';
const sample = new URLSearchParams(location.search).has('sample');
const departments = [
  { id: 'd1', corporation_id: '1', code: 'D001', name: '영업' },
  { id: 'd3', corporation_id: '1', code: 'D003', name: '회계' },
  { id: 'd4', corporation_id: '2', code: 'D001', name: '구매' },
  { id: 'd5', corporation_id: '2', code: 'D002', name: '물류' },
  { id: 'd2', corporation_id: '3', code: 'D002', name: '개발' },
  { id: 'd6', corporation_id: '4', code: 'D001', name: '관리' },
];
const candidates = [
  { id: '1', code: 'A001', name: '서울전자' },
  { id: '2', code: 'A002', name: '부산전자' },
  { id: '3', code: 'B001', name: '대전상사' },
  { id: '4', code: 'P_01', name: '100% 법인' },
];
const initial = (): GridRow[] => [
  {
    _key: 'first',
    corporation_id: '1',
    corporation_code: 'A001',
    corporation_name: '서울전자',
    department_id: 'd1',
    department_code: 'D001',
    department_name: '영업',
  },
  {
    _key: 'second',
    corporation_id: '3',
    corporation_code: 'B001',
    corporation_name: '대전상사',
    department_id: 'd2',
    department_code: 'D002',
    department_name: '개발',
  },
];
function TestScreen() {
  const [rows, setRows] = useState(initial),
    [locked, setLocked] = useState(false),
    [mode, setMode] = useState('normal');
  return (
    <main className="lookup-sample">
      <h1>코드검색 샘플</h1>
      <p>
        법인코드의 검색 버튼을 눌러 법인을 선택한 뒤, 부서코드에서 해당 법인의 부서를 선택해보세요.
      </p>
      <p>
        팝업에서 코드·명칭으로 조회하고 원하는 행을 더블클릭하면 코드와 명칭이 함께 채워집니다. 다른
        법인으로 변경하면 기존 부서는 비워집니다.
      </p>
      <p className="sample-notice">
        가상 데이터로 체험하는 화면입니다. 변경값은 DB에 저장되지 않으며 새로고침하면 초기 상태로
        돌아갑니다.
      </p>
      <div className="sample-tools">
        {sample && (
          <button
            onClick={() =>
              setRows([
                ...rows,
                {
                  _key: crypto.randomUUID(),
                  corporation_id: '',
                  corporation_code: '',
                  corporation_name: '',
                  department_id: '',
                  department_code: '',
                  department_name: '',
                },
              ])
            }
          >
            행추가
          </button>
        )}
        <button onClick={() => setRows(initial())}>테스트 초기화</button>
        <button onClick={() => setLocked(!locked)}>편집 잠금</button>
        {!sample && (
          <label>
            응답 모드
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="normal">정상</option>
              <option value="error">실패</option>
              <option value="slow">지연</option>
              <option value="replace">원본 교체</option>
            </select>
          </label>
        )}
      </div>
      <div style={{ height: 340 }}>
        <DataGrid
          label="업무 테스트"
          rows={rows}
          onChange={setRows}
          columns={[
            {
              field: 'corporation_code',
              header: '법인코드',
              width: 190,
              editable: !locked,
              lookup: {
                title: '법인검색',
                fields: {
                  id: 'corporation_id',
                  code: 'corporation_code',
                  name: 'corporation_name',
                },
                clear: ['department_id', 'department_code', 'department_name'],
                load: async () => {
                  if (mode === 'error') throw Error('테스트 조회 실패');
                  if (mode === 'replace') setTimeout(() => setRows(initial()), 100);
                  if (mode === 'slow' || mode === 'replace')
                    await new Promise((r) => setTimeout(r, 400));
                  return candidates;
                },
              },
            },
            { field: 'corporation_name', header: '법인명', width: 180 },
            {
              field: 'department_code',
              header: '부서코드',
              width: 190,
              editable: (row) => !locked && Boolean(row.corporation_id),
              lookup: {
                title: '부서검색',
                fields: { id: 'department_id', code: 'department_code', name: 'department_name' },
                load: async (row) =>
                  departments.filter((d) => d.corporation_id === row.corporation_id),
              },
            },
            { field: 'department_name', header: '부서명' },
          ]}
        />
      </div>
      <output data-testid="rows" hidden={sample}>
        {JSON.stringify(rows)}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<TestScreen />);
