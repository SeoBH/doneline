/**
 * AG Grid 공통 어댑터. 부모 React 상태가 데이터를 소유하고 편집은 onChange로 전달한다.
 * _key는 UI 식별자, _checked는 처리 대상 선택, _error는 서버 오류 표시이며 DB 컬럼이 아니다.
 */
import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { CodeLookup, LookupConfig, LookupItem } from './CodeLookup';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, ColDef } from 'ag-grid-community';
ModuleRegistry.registerModules([AllCommunityModule]);
// 그리드 테마는 한 번만 만든다. 렌더마다 withParams를 호출하면 새 테마 객체로 인식될 수 있다.
// 색은 style.css의 토큰을 var()로 참조해 화면 테마와 함께 바뀌게 한다.
const gridTheme = themeQuartz.withParams({
  headerBackgroundColor: 'var(--color-accent)',
  headerTextColor: 'var(--color-text-inverse)',
  rowHeight: 33,
  headerHeight: 36,
  fontSize: 12,
  borderColor: 'var(--color-border-strong)',
});
export type GridRow = Record<string, any> & { _key: string; _checked?: boolean; _error?: string };
// Record는 이름으로 값을 찾는 객체 타입, &는 타입 결합, 속성 뒤 ?는 생략 가능을 뜻한다.
// 업무 컬럼은 화면마다 다르지만 모든 행에는 UI 식별자인 _key가 있어야 한다.
export type GridHandle = { stop: () => void };
export type Column = {
  field: string;
  header: string;
  width?: number;
  editable?: boolean | ((row: GridRow) => boolean);
  boolean?: boolean;
  choices?: string[];
  lookup?: LookupConfig;
  disabled?: (row: GridRow) => boolean;
  format?: (value: any) => string;
};
export const DataGrid = forwardRef<
  GridHandle,
  {
    rows: GridRow[];
    columns: Column[];
    onChange?: (r: GridRow[]) => void;
    onPick?: (r: GridRow) => void;
    onDoublePick?: (r: GridRow) => void;
    active?: string;
    checks?: boolean;
    label: string;
    busy?: boolean;
  }
>(function DataGrid(
  { rows, columns, onChange, onPick, onDoublePick, active, checks = true, label, busy },
  ref,
) {
  // forwardRef는 부모가 전달한 ref를 받는다. useRef는 렌더 사이에 값을 보관하며,
  // .current를 바꿔도 그 자체로 화면을 다시 그리지 않는다. 여기서는 그리드와 최신 행을 기억한다.
  const grid = useRef<AgGridReact<GridRow>>(null);
  const container = useRef<HTMLDivElement>(null),
    returnFocus = useRef<{ key: string; field: string } | null>(null);
  const [localActive, setLocalActive] = useState('');
  const [lookup, setLookup] = useState<{ source: GridRow; config: LookupConfig } | null>(null);
  function closeLookup() {
    if (lookup) returnFocus.current = { key: lookup.source._key, field: lookup.config.fields.code };
    setLookup(null);
  }
  useEffect(() => {
    if (lookup || !returnFocus.current) return;
    // 값 반영 후 그리드가 셀 버튼을 다시 만들 수 있어 새 DOM에서 원래 위치를 찾는다.
    const target = returnFocus.current;
    let next = 0;
    const frame = requestAnimationFrame(() => {
      next = requestAnimationFrame(() => {
        const button = Array.from(
          container.current?.querySelectorAll<HTMLButtonElement>('button[data-lookup-key]') || [],
        ).find((b) => b.dataset.lookupKey === target.key && b.dataset.lookupField === target.field);
        button?.focus();
        returnFocus.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(next);
    };
  });
  const selectedKey = active === undefined ? localActive : active;
  const latest = useRef(rows);
  latest.current = rows;
  // 재조회·상위 코드 변경으로 원래 행이 교체되면 열린 팝업 결과를 적용하지 않는다.
  useEffect(() => {
    if (lookup && (busy || !rows.includes(lookup.source))) setLookup(null);
  }, [rows, busy, lookup]);
  function chooseLookup(item: LookupItem) {
    if (!lookup || busy || !latest.current.includes(lookup.source)) {
      setLookup(null);
      return;
    }
    const { config, source } = lookup;
    const column = columns.find((c) => c.lookup?.fields.code === config.fields.code);
    if (
      !onChange ||
      !column ||
      column.disabled?.(source) ||
      !(typeof column.editable === 'function' ? column.editable(source) : column.editable)
    ) {
      setLookup(null);
      return;
    }
    const next = latest.current.map((row) => {
      if (row !== source) return row;
      const changed = row[config.fields.id] !== item.id;
      const cleared = Object.fromEntries(
        (changed ? config.clear || [] : []).map((field) => [field, '']),
      );
      return {
        ...row,
        ...cleared,
        [config.fields.id]: item.id,
        [config.fields.code]: item.code,
        [config.fields.name]: item.name,
        _checked: true,
        _error: undefined,
      };
    });
    latest.current = next;
    onChange?.(next);
    closeLookup();
  }
  // 중첩 필드는 내부 객체도 복사한다. 일반 셀 수정 시 처리 대상으로 체크하고 이전 오류를 지운다.
  function update(key: string, field: string, value: any) {
    const next = latest.current.map((r) => {
      if (r._key !== key) return r;
      const parts = field.split('.');
      const row: GridRow = { ...r, _error: undefined };
      if (parts.length === 2) row[parts[0]] = { ...r[parts[0]], [parts[1]]: value };
      else row[field] = value;
      if (field !== '_checked') row._checked = true;
      return row;
    });
    latest.current = next;
    onChange?.(next);
  }
  // 부모가 저장 직전에 편집 중인 셀을 확정할 수 있도록 stop만 공개한다.
  useImperativeHandle(ref, () => ({ stop: () => grid.current?.api?.stopEditing() }));
  // 행추가로 생긴 저장 전 행(id 없음)이 목록 아래쪽 화면 밖에 붙으면 사용자는 추가된 줄 모른다.
  // 처음 보는 신규 행을 기억해 두었다가, 그리드가 새 데이터를 반영한 직후(onRowDataUpdated) 그 행으로 스크롤한다.
  // 자식인 AgGridReact가 부모 effect보다 먼저 데이터를 반영할 수 있어 effect가 아닌 렌더 단계(useMemo)에서 계산한다.
  const knownKeys = useRef(new Set<string>()),
    scrollTo = useRef<string | null>(null);
  useMemo(() => {
    const fresh = rows.filter((r) => !r.id && !knownKeys.current.has(r._key)).at(-1);
    knownKeys.current = new Set(rows.map((r) => r._key));
    if (fresh) scrollTo.current = fresh._key;
  }, [rows]);
  // useMemo는 아래 의존성 배열의 값이 바뀔 때 열 정의를 다시 계산한다.
  // 열마다 편집 가능 여부·체크박스·표시 형식을 구성하며, 데이터 변경이 없어도 렌더마다 재생성하지 않는다.
  const defs = useMemo<ColDef<GridRow>[]>(() => {
    const columnsDef: ColDef<GridRow>[] = columns.map((col) => ({
      field: col.field,
      headerName: col.header,
      width: col.width || 130,
      minWidth: 65,
      editable: (p) =>
        !busy &&
        !col.boolean &&
        !col.lookup &&
        (typeof col.editable === 'function' ? col.editable(p.data!) : Boolean(col.editable)),
      // 입력할 수 있는 칸을 옅은 바탕과 테두리로 표시한다(두 번 눌러 편집한다는 것을 알아보기 쉽게).
      cellClassRules: {
        'cell-editable': (p) =>
          !col.boolean &&
          !col.lookup &&
          (typeof col.editable === 'function' ? col.editable(p.data!) : Boolean(col.editable)),
      },
      // choices는 자유 입력 대신 선택 목록을 제공한다. RESP 구분의 오타를 줄이되 서버도 재검사한다.
      ...(col.choices
        ? { cellEditor: 'agSelectCellEditor', cellEditorParams: { values: col.choices } }
        : {}),
      ...(col.lookup
        ? {
            cellRenderer: (p: any) => (
              <span className="lookup-cell">
                <span>{p.value || ''}</span>
                <button
                  type="button"
                  data-lookup-key={p.data._key}
                  data-lookup-field={col.lookup!.fields.code}
                  aria-label={label + ' ' + col.header + ' 검색 ' + (p.node.rowIndex + 1)}
                  disabled={
                    busy ||
                    !onChange ||
                    col.disabled?.(p.data) ||
                    !(typeof col.editable === 'function' ? col.editable(p.data) : col.editable)
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    grid.current?.api?.stopEditing();
                    const source = latest.current.find((r) => r._key === p.data._key);
                    if (source) setLookup({ source, config: col.lookup! });
                  }}
                >
                  검색
                </button>
              </span>
            ),
          }
        : {}),
      sortable: false,
      // 행 순서가 메뉴 표시 순서이므로 헤더 정렬은 끄고, 열 너비 조절은 허용한다.
      resizable: true,
      ...(col.boolean
        ? {
            cellRenderer: (p: any) => (
              <input
                type="checkbox"
                aria-label={label + ' ' + col.header + ' ' + (p.node.rowIndex + 1)}
                checked={Boolean(p.value)}
                disabled={busy || col.disabled?.(p.data)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => update(p.data._key, col.field, e.target.checked)}
              />
            ),
          }
        : // 표시 함수를 지정한 열은 자동 불리언 체크박스 추론을 꺼서 완료/매핑 필요 같은 설명을 표시한다.
          col.format && !col.lookup
          ? { cellDataType: false, valueFormatter: (p: any) => col.format!(p.value) }
          : {}),
    }));
    if (checks)
      columnsDef.unshift({
        field: '_checked',
        headerName: '선택',
        width: 52,
        pinned: 'left',
        resizable: false,
        headerComponent: () => (
          <input
            type="checkbox"
            aria-label={label + ' 전체 선택'}
            checked={rows.length > 0 && rows.every((r) => r._checked)}
            disabled={busy || !rows.length}
            onChange={(e) => {
              const next = latest.current.map((r) => ({ ...r, _checked: e.target.checked }));
              latest.current = next;
              onChange?.(next);
            }}
          />
        ),
        cellRenderer: (p: any) => (
          <input
            type="checkbox"
            aria-label={label + ' 행 선택 ' + (p.node.rowIndex + 1)}
            checked={Boolean(p.data._checked)}
            disabled={busy}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => update(p.data._key, '_checked', e.target.checked)}
          />
        ),
      });
    return columnsDef;
  }, [columns, rows, busy, label, checks, onChange]);
  return (
    <>
      <div ref={container} className="registration-grid" aria-label={label}>
        {/* readOnlyEdit: 그리드가 원본을 수정하지 않고 편집 요청을 보내면 React 상태에서 반영한다.
          stopEditingWhenCellsLoseFocus: 셀을 벗어나면 편집을 확정한다.
          singleClickEdit=false: 한 번 클릭은 행 선택, 더블클릭은 편집으로 구분한다.
          getRowId: 행 위치가 바뀌어도 같은 _key를 가진 행으로 인식하게 한다. */}
        <AgGridReact
          ref={grid}
          theme={gridTheme}
          rowData={rows}
          columnDefs={defs}
          getRowId={(p) => p.data._key}
          readOnlyEdit
          stopEditingWhenCellsLoseFocus
          singleClickEdit={false}
          onCellEditRequest={(e) => update(e.data._key, String(e.colDef.field), e.newValue)}
          onRowDataUpdated={(e) => {
            const key = scrollTo.current;
            scrollTo.current = null;
            const node = key ? e.api.getRowNode(key) : undefined;
            // 'bottom': 새 행이 화면 아래쪽 끝에 보이도록 필요한 만큼만 스크롤한다.
            if (node) e.api.ensureNodeVisible(node, 'bottom');
          }}
          onRowClicked={(e) => {
            if (!busy && e.data) {
              setLocalActive(e.data._key);
              onPick?.(e.data);
            }
          }}
          onRowDoubleClicked={(e) => {
            if (!busy && e.data) onDoublePick?.(e.data);
          }}
          // classRules는 조건이 false가 되면 이전 클래스도 제거한다. getRowClass는 누적되어 잔상이 남을 수 있다.
          rowClassRules={{
            'grid-row-error': (p) => Boolean(p.data?._error),
            'grid-row-current': (p) => p.data?._key === selectedKey,
          }}
          overlayNoRowsTemplate="<span>조회된 데이터가 없습니다.</span>"
        />
      </div>
      {lookup && (
        <CodeLookup
          config={lookup.config}
          source={lookup.source}
          onSelect={chooseLookup}
          onClose={closeLookup}
        />
      )}
    </>
  );
});
