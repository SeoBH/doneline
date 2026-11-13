/**
 * 고객 요청(SR) 코드값의 화면 표시 문구. 서버·DB는 영문 코드를 쓰고 화면만 한국어로 보여준다.
 * 다국어를 붙일 때 이 사전만 언어별로 나누면 된다. 사용처: SrPortalScreen, SrDeskScreen.
 */
export const statusLabel: Record<string, string> = {
  OPEN: '접수',
  IN_PROGRESS: '처리 중',
  RESOLVED: '확인 대기',
  CLOSED: '완료',
  CANCELLED: '취소',
};
// 담당자 화면의 상태 선택지 이름. '확인 대기'만 보면 담당자가 무엇을 끝낸 것인지 알기 어려워
// '처리 완료'라는 동작 이름을 앞에 붙인다. 최종 '완료'는 고객이 [완료 확인]을 눌러야 된다.
export const deskStatusLabel: Record<string, string> = {
  OPEN: '접수(대기)',
  IN_PROGRESS: '처리 중',
  RESOLVED: '처리 완료 (고객 확인 대기)',
};
export const priorityLabel: Record<string, string> = {
  LOW: '낮음',
  NORMAL: '보통',
  HIGH: '높음',
  URGENT: '긴급',
};
export const categoryLabel: Record<string, string> = {
  INCIDENT: '장애',
  REQUEST: '작업 요청',
  QUESTION: '문의',
};
// 담당자 화면의 상태 변경 선택지. 서버(requests.ts DESK_TRANSITIONS)와 같은 규칙이며 최종 판단은 서버가 한다.
export const deskTransitions: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['OPEN', 'RESOLVED', 'CANCELLED'],
  RESOLVED: ['IN_PROGRESS'],
  CLOSED: [],
  CANCELLED: [],
};
export const dateTime = (v: string) =>
  new Date(v).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
// 이력 한 줄 설명. 담당자 변경은 ID 대신 이름을 쓰도록 이름 사전을 받는다.
export function eventText(e: any, names: Record<string, string> = {}) {
  if (e.kind === 'CREATED') return '요청을 등록했습니다.';
  if (e.kind === 'STATUS')
    return `상태: ${statusLabel[e.from_value] || e.from_value} → ${statusLabel[e.to_value] || e.to_value}`;
  if (e.kind === 'PRIORITY')
    return `우선순위: ${priorityLabel[e.from_value]} → ${priorityLabel[e.to_value]}`;
  if (e.kind === 'ASSIGN')
    return e.to_value ? `담당자: ${names[e.to_value] || '지정'}` : '담당자 지정을 해제했습니다.';
  return e.body;
}
