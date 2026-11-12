/** 공통 단건 코드검색 창. 조회 함수는 호출 화면이 제공하고 선택 결과는 아직 DB에 저장하지 않는다. */
import { useEffect, useRef, useState } from 'react';
import { DataGrid, GridRow } from './DataGrid';
export type LookupItem = { id: string; code: string; name: string };
export type LookupSearch = { code: string; name: string };
export type LookupConfig = {
  title: string;
  load: (row: GridRow, search: LookupSearch) => Promise<LookupItem[]>;
  // 선택 결과의 ID·코드·명칭을 원래 행의 어느 컬럼에 넣을지 지정한다.
  fields: { id: string; code: string; name: string };
  clear?: string[];
};
export function CodeLookup({
  config,
  source,
  onSelect,
  onClose,
}: {
  config: LookupConfig;
  source: GridRow;
  onSelect: (item: LookupItem) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    epoch = useRef(0);
  const [search, setSearch] = useState<LookupSearch>({ code: '', name: '' });
  const [rows, setRows] = useState<GridRow[]>([]),
    [selected, setSelected] = useState<GridRow | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  /** 새 조회는 이전 선택을 비운다. 창을 닫은 뒤 도착한 응답은 상태에 반영하지 않는다. */
  async function query(value = search) {
    const ticket = ++epoch.current;
    setBusy(true);
    setError('');
    setSelected(null);
    setRows([]);
    try {
      const filter = { code: value.code.trim(), name: value.name.trim() };
      const items = await config.load(source, filter);
      // 대소문자를 무시하는 포함 검색이다. %와 _도 일반 글자로 취급한다.
      if (ticket === epoch.current)
        setRows(
          items
            .filter(
              (item) =>
                item.code.toLowerCase().includes(filter.code.toLowerCase()) &&
                item.name.toLowerCase().includes(filter.name.toLowerCase()),
            )
            .map((item) => ({ ...item, _key: item.id })),
        );
    } catch (e) {
      if (ticket === epoch.current) setError((e as Error).message);
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    // showModal은 배경 클릭/키보드 접근을 막고 포커스를 창 안에 가둔다. 닫을 때 원래 셀 버튼으로 돌아간다.
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    void query({ code: '', name: '' });
    return () => {
      epoch.current++;
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  function choose(row: GridRow) {
    if (!busy && rows.some((r) => r.id === row.id))
      onSelect({ id: row.id, code: row.code, name: row.name });
  }
  return (
    <dialog
      ref={dialog}
      className="code-lookup"
      aria-label={config.title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2>{config.title}</h2>
      <form
        className="query-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void query();
        }}
      >
        <label>
          코드
          <input
            autoFocus
            value={search.code}
            maxLength={40}
            disabled={busy}
            onChange={(e) => setSearch({ ...search, code: e.target.value })}
          />
        </label>
        <label>
          명칭
          <input
            value={search.name}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setSearch({ ...search, name: e.target.value })}
          />
        </label>
        <button disabled={busy}>{busy ? '조회 중…' : '조회'}</button>
      </form>
      <p>
        코드·명칭은 입력한 글자를 포함하는 항목을 찾습니다. 원하는 행을 더블클릭하거나 선택 버튼을
        누르세요.
      </p>
      {error && <p role="alert">{error}</p>}
      <DataGrid
        label={config.title + ' 결과'}
        rows={rows}
        columns={[
          { field: 'code', header: '코드', width: 190 },
          { field: 'name', header: '명칭', width: 350 },
        ]}
        checks={false}
        active={selected?._key || ''}
        onPick={setSelected}
        onDoublePick={choose}
        busy={busy}
      />
      <div className="lookup-actions">
        <span role="status">{busy ? '조회 중' : `${rows.length}건`}</span>
        <button
          type="button"
          disabled={busy || !selected}
          onClick={() => selected && choose(selected)}
        >
          선택
        </button>
        <button type="button" onClick={onClose}>
          취소
        </button>
      </div>
    </dialog>
  );
}
