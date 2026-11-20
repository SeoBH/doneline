/**
 * 확인 창·결과 알림에 "누구를/무엇을" 처리하는지 보여 주는 문구를 만든다.
 * 사용 화면: AccountsScreen(사용자 승인·정지·삭제·기본정보 변경), CustomersScreen(고객사·법인·부서 삭제).
 * QA 4차 DV4-002, 5차 DV5-002·DV5-004: 대상 없이 "n개를 삭제할까요?"·"변경했습니다."만 뜨면 잘못 고른 행을 알아채기 어렵다.
 */

/**
 * 이름 목록을 "가, 나, 다 외 2명"처럼 줄인다. 확인 창이 길어지지 않도록 앞 max개만 적는다.
 * @param labels 화면에 보일 이름(예: '아이디(이름)', '이름(코드)')
 * @param unit '외 n' 뒤에 붙는 단위(사람은 '명', 그 밖은 '개')
 */
export function listNames(labels: string[], unit: string, max = 5) {
  const rest = labels.length > max ? ` 외 ${labels.length - max}${unit}` : '';
  return labels.slice(0, max).join(', ') + rest;
}

/**
 * 사용자 계정 행을 "3개 계정 kim(김철수), lee(이영희)" 형태로 만든다. 1개면 앞의 개수를 생략한다.
 * 그리드 행(GridRow)과 같이 칸 이름이 정해지지 않은 객체(Record)를 받아 login_id·display_name 칸을 읽는다.
 */
export function accountNames(rows: Record<string, any>[]) {
  const names = listNames(
    rows.map((r) => `${r.login_id}(${r.display_name})`),
    '명',
  );
  return (rows.length > 1 ? `${rows.length}개 계정 ` : '') + names;
}
