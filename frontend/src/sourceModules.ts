/**
 * DB component_key와 실제 등록 화면 종류를 연결하는 허용 목록. 버튼 문구는 화면별 재정의, 기본 문구, 동작 코드 순으로 결정한다.
 */
import { RegisterKind } from './RegistrationScreen';
import { actions, labels } from './types';
// Add source modules here. The source supplies its button captions; omitted captions use defaults.
export const sourceModules: Record<
  string,
  { kind: RegisterKind; buttonLabels?: Record<string, string> }
> = {
  'screen-register': { kind: 'screens' },
  'menu-register': { kind: 'menus' },
  'resp-register': { kind: 'responsibilities' },
};
export function buttonLabel(source: string | null, action: string) {
  return (
    sourceModules[source || '']?.buttonLabels?.[action] ||
    labels[actions.indexOf(action as (typeof actions)[number])] ||
    action
  );
}
