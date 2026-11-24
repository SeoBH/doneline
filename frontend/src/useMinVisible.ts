/**
 * 처리 중 표시를 '늦게 켜고, 켜지면 최소 시간 유지'하는 훅. 관련: main.tsx의 처리 중 줄(QA DL-006).
 * - 0.2~0.3초 만에 끝나는 조회·저장은 줄이 깜빡이듯 지나가 눈에 띄지 않는다는 QA 지적이 있어,
 *   한 번 보인 줄은 minMs 동안 유지한다(줄 애니메이션 한 번이 1.1초라 0.6초면 움직임이 보인다).
 * - 0.1초도 안 걸리는 처리는 사람이 '즉시'로 느끼므로 줄을 아예 띄우지 않아 깜빡임을 막는다(delayMs).
 * 버튼 잠금·aria-busy·'처리 중…' 글자 같은 실제 처리 상태는 늦추지 않고, 이 반환값은 눈에 보이는 줄에만 쓴다.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * on: 실제 처리 중 여부. delayMs: 켜진 뒤 이만큼 지나도 계속 처리 중일 때만 보인다. minMs: 보인 뒤 최소 유지 시간.
 * 반환: 줄을 그릴지 여부.
 * 부수 효과: 보이기·숨기기를 미루는 타이머 하나. 상태가 바뀌거나 화면이 사라지면 정리 함수가 취소한다.
 */
export function useMinVisible(on: boolean, delayMs: number, minMs: number): boolean {
  const [visible, setVisible] = useState(false);
  // useRef: 다시 그려도 유지되는 값 상자. 줄이 보이기 시작한 시각을 기억해 남은 유지 시간을 계산한다.
  const shownAt = useRef(0);
  useEffect(() => {
    // 처리 중인데 아직 안 보임 → delayMs 뒤에 보이기. 그 전에 처리가 끝나면 정리 함수가 취소해 아예 안 뜬다.
    if (on && !visible) {
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    // 처리가 끝났는데 보이는 중 → 최소 시간을 채운 뒤 숨기기. 그 사이 다시 처리가 시작되면(on=true) 취소되어 계속 보인다.
    if (!on && visible) {
      const left = Math.max(0, minMs - (Date.now() - shownAt.current));
      const timer = setTimeout(() => setVisible(false), left);
      return () => clearTimeout(timer);
    }
  }, [on, visible, delayMs, minMs]);
  return visible;
}
