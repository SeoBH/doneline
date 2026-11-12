/**
 * 서버 응답과 화면 간 공통 계약. bigint ID는 정밀도 손실을 피하도록 문자열로 다룬다.
 * ScreenHandle은 공통 툴바가 각 화면의 기능을 호출하는 인터페이스다.
 */
export type User = { id: string; displayName: string; mustChangePassword: boolean };
export type Screen = {
  id: string;
  menu_id: string;
  name: string;
  code: string;
  component_key: string | null;
  sort_order: number;
  hidden: boolean;
  buttons: Record<string, { label: string; allowed: boolean }>;
};
export type Nav = {
  rootMenuId: string;
  menus: { id: string; name: string }[];
  edges: { parent_menu_id: string; child_menu_id: string; hidden: boolean; sort_order: number }[];
  screens: Screen[];
};
export type Tab = Screen & { path: string[] };
export type ScreenHandle = {
  buttonLabels?: Record<string, string>;
  actions?: Record<string, () => void | Promise<void>>;
  query: () => Promise<void>;
  reset: () => void;
  save?: () => Promise<boolean>;
  remove?: () => Promise<void>;
};
// 현재 내부 탭이 사용하는 버튼과 실행 조건을 공통 툴바에 알린다. 서버 권한을 대신하지 않는다.
export type ViewState = {
  dirty: boolean;
  busy: boolean;
  visibleActions?: string[];
  disabledActions?: string[];
};
export const actions = [
  'RESET',
  'QUERY',
  'SAVE',
  'DELETE',
  'ETC1',
  'ETC2',
  'ETC3',
  'ETC4',
] as const;
export const labels = ['초기화', '조회', '저장', '삭제', '기타1', '기타2', '기타3', '기타4'];
// 같은 화면이라도 메뉴별 권한이 다르므로 메뉴 ID와 화면 ID를 함께 탭 키로 사용한다.
export const tabKey = (s: Screen) => s.menu_id + ':' + s.id;
