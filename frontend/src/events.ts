/**
 * 화면끼리 주고받는 브라우저 이벤트 이름 모음.
 * CATALOG_CHANGED: 고객사·법인·부서를 저장·삭제했을 때 CustomersScreen이 보낸다. 다른 탭의 등록 화면·시작하기가 듣고 다시 읽는다.
 * 화면 파일(CustomersScreen 등)은 필요할 때 따로 내려받으므로, 이름만 이 작은 파일에 두어 서로 끌어오지 않게 한다.
 */
export const CATALOG_CHANGED = 'doneline:catalog-changed';
